// Pure path policy: containment and secret-path classification.
// The extension computes PathFacts (realpath of the nearest existing ancestor + tail);
// core never touches the filesystem and picks path.posix / path.win32 explicitly.
import path from "node:path";

export type PathPlatform = "posix" | "win32";

export interface PathFacts {
  /** The path as the tool call spelled it. */
  input: string;
  /** Absolute; realpath of the nearest existing ancestor plus the remaining tail. */
  resolved: string;
  platform: PathPlatform;
}

export interface PathContext {
  home: string;
  piAgentDir: string;
  writeRoots: string[];
  tmpRoots: string[];
}

export interface PathClassification {
  secret: boolean;
  within: "write-root" | "tmp" | "outside";
  root?: string;
  relative?: string;
}

export interface SecretContext {
  home: string;
  piAgentDir: string;
  /** Defaults to win32 when the path looks like a Windows path, otherwise posix. */
  platform?: PathPlatform;
}

const GIT_BASH_DRIVE = /^\/([A-Za-z])(?:\/|$)/;
const WINDOWS_LIKE = /^[A-Za-z]:[\\/]|^\\\\/;
const ENV_EXCLUDED = new Set([".env.example", ".env.sample", ".env.template"]);

function api(platform: PathPlatform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Normalizes without touching the filesystem. Git Bash `/c/x` becomes `C:\x` on win32. */
function normalize(p: string, platform: PathPlatform): string {
  if (platform === "win32") {
    const m = GIT_BASH_DRIVE.exec(p);
    const converted = m ? `${m[1]!.toUpperCase()}:${p.slice(2) || "\\"}` : p;
    return path.win32.normalize(converted);
  }
  return path.posix.normalize(p);
}

function stripTrailingSep(p: string, platform: PathPlatform): string {
  const a = api(platform);
  return p.length > a.parse(p).root.length ? p.replace(/[\\/]+$/, "") : p;
}

function contains(root: string, target: string, platform: PathPlatform): string | undefined {
  const a = api(platform);
  const rel = a.relative(root, target);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${a.sep}`) || a.isAbsolute(rel)) return undefined;
  return rel;
}

function segmentsOf(rel: string, platform: PathPlatform): string[] {
  const parts = rel.split(platform === "win32" ? /[\\/]+/ : "/").filter((s) => s !== "");
  return platform === "win32" ? parts.map((s) => s.toLowerCase()) : parts;
}

export function isSecretPath(resolved: string, ctx: SecretContext): boolean {
  const platform = ctx.platform ?? (WINDOWS_LIKE.test(resolved) || WINDOWS_LIKE.test(ctx.home) ? "win32" : "posix");
  const target = stripTrailingSep(normalize(resolved, platform), platform);
  const lc = (s: string) => (platform === "win32" ? s.toLowerCase() : s);

  const base = lc(api(platform).basename(target));
  if (base === ".env" || (base.startsWith(".env.") && !ENV_EXCLUDED.has(base))) return true;
  if (base === ".npmrc" || base === ".pypirc") return true;
  if (base.endsWith(".pem") || base.startsWith("id_rsa") || base.startsWith("id_ed25519")) return true;

  const agentDir = stripTrailingSep(normalize(ctx.piAgentDir, platform), platform);
  const agentRel = contains(agentDir, target, platform);
  if (agentRel !== undefined && lc(agentRel) === "auth.json") return true;

  const home = stripTrailingSep(normalize(ctx.home, platform), platform);
  const rel = contains(home, target, platform);
  if (rel === undefined || rel === "") return false;
  const seg = segmentsOf(rel, platform);
  const first = seg[0]!;
  const joined = seg.join("/");
  if (first.startsWith(".claude")) return true; // ~/.claude*/** and ~/.claude.json
  if (first === ".ssh" || first === ".gnupg" || first === ".azure") return true;
  if (seg[0] === ".config" && seg[1] === "gcloud" && seg.length > 1) return true;
  return [
    ".pi/agent/auth.json",
    ".codex/auth.json",
    ".aws/credentials",
    ".config/gh/hosts.yml",
    ".netrc",
    ".git-credentials",
    ".docker/config.json",
    ".kube/config",
  ].includes(joined);
}

export function classifyPath(p: PathFacts, ctx: PathContext): PathClassification {
  const target = stripTrailingSep(normalize(p.resolved, p.platform), p.platform);
  const secret =
    isSecretPath(p.resolved, { home: ctx.home, piAgentDir: ctx.piAgentDir, platform: p.platform }) ||
    (path.isAbsolute(p.input) || GIT_BASH_DRIVE.test(p.input)
      ? isSecretPath(p.input, { home: ctx.home, piAgentDir: ctx.piAgentDir, platform: p.platform })
      : false);

  const find = (roots: string[]) => {
    for (const root of roots) {
      const rel = contains(stripTrailingSep(normalize(root, p.platform), p.platform), target, p.platform);
      if (rel !== undefined) return { root, relative: rel };
    }
    return undefined;
  };
  const w = find(ctx.writeRoots);
  if (w) return { secret, within: "write-root", ...w };
  const t = find(ctx.tmpRoots);
  if (t) return { secret, within: "tmp", ...t };
  return { secret, within: "outside" };
}
