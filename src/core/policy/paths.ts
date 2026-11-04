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
  /**
   * R28: whether the target existed when the facts were taken (hook time). Undefined means unknown and counts
   * as not existing where it matters (a later segment of a command may use a path an earlier one creates).
   */
  exists?: boolean;
  /**
   * R37: whether the target is a directory (following symbolic links) at hook time. Undefined means unknown; a
   * `git add` path counts as an explicit file only when this is `false`.
   */
  directory?: boolean;
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
  platform: PathPlatform;
}

const ENV_EXCLUDED = new Set([".env.example", ".env.sample", ".env.template"]);
const WIN_DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const WIN_UNC_ROOT = /^\\\\[^\\/]+\\[^\\/]+/;

function api(platform: PathPlatform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Mirrors Pi's normalizeWindowsShellPath (pi-coding-agent dist/utils/paths.js) exactly:
 * `/c/x`, `/mnt/c/x` and `/cygdrive/c/x` become `C:\x`, but only for a path that starts with
 * `/`, does not start with `//` and contains no backslash.
 */
function normalizeWindowsShellPath(p: string): string {
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
  const match = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return p;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

interface Canonical {
  path: string;
  /** True when a `.` or `..` segment was present and collapsed lexically. */
  dots: boolean;
  /** Literal (untrimmed) spelling when it differs from `path`; secrets are checked on both. */
  alt?: string;
}

/**
 * Lexical canonical form, or undefined when the path is not a usable absolute path
 * (callers fail closed). Never touches the filesystem.
 */
function canon(raw: string, platform: PathPlatform): Canonical | undefined {
  if (raw === "" || raw.includes("\0")) return undefined;
  if (platform === "posix") {
    if (!raw.startsWith("/")) return undefined;
    const dots = raw.split("/").some((seg) => seg === "." || seg === "..");
    return { path: path.posix.normalize(raw), dots };
  }
  let p = normalizeWindowsShellPath(raw);
  let verbatim = false;
  if (/^\\\\[?.]\\UNC\\/i.test(p)) {
    p = `\\\\${p.slice(8)}`;
    verbatim = true;
  } else if (/^\\\\[?.]\\/.test(p)) {
    p = p.slice(4);
    verbatim = true;
  }
  let root: string;
  if (WIN_DRIVE_ROOT.test(p)) root = `${p.slice(0, 2).toUpperCase()}\\`;
  else if (WIN_UNC_ROOT.test(p)) {
    const m = /^\\\\([^\\/]+)[\\/]+([^\\/]+)/.exec(p.replaceAll("/", "\\"))!;
    root = `\\\\${m[1]}\\${m[2]}\\`;
    p = root + p.slice(m[0].length);
  } else return undefined;
  const rest = p.slice(root.length);
  if (rest.includes(":")) return undefined; // alternate data streams, device names
  if (root.startsWith("\\\\") && root.slice(2).includes(":")) return undefined;
  // Win32 trims trailing dots/spaces only from the final segment (and never under \\?\).
  // Any other segment that would be altered, or an all-dots name, is ambiguous: fail closed.
  let dots = false;
  const raws = rest.split(/[\\/]+/).filter((x) => x !== "");
  const trimmedSegs: string[] = [];
  const literalSegs: string[] = [];
  raws.forEach((seg, i) => {
    const last = i === raws.length - 1;
    const t = seg.replace(/ +$/, "");
    if (t === "." || t === "..") {
      dots = true;
      trimmedSegs.push(t);
      literalSegs.push(t);
      return;
    }
    const trimmed = seg.replace(/[. ]+$/, "");
    if (/^\.+$/.test(seg) || (trimmed !== seg && (!last || verbatim))) dots = true;
    if (trimmed !== "") trimmedSegs.push(trimmed);
    literalSegs.push(seg);
  });
  const result = path.win32.normalize(root + trimmedSegs.join("\\"));
  const literal = path.win32.normalize(root + literalSegs.join("\\"));
  return { path: result, dots, ...(literal !== result ? { alt: literal } : {}) };
}

function stripTrailingSep(p: string, platform: PathPlatform): string {
  const a = api(platform);
  if (p.length <= a.parse(p).root.length) return p;
  return p.replace(platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
}

function requireAbsolute(value: string, name: string, platform: PathPlatform): string {
  const c = canon(value, platform);
  if (!c) throw new Error(`${name} must be an absolute path, got ${JSON.stringify(value)}`);
  return stripTrailingSep(c.path, platform);
}

function contains(root: string, target: string, platform: PathPlatform): string | undefined {
  const a = api(platform);
  const rel = a.relative(root, target);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${a.sep}`) || a.isAbsolute(rel)) return undefined;
  return rel;
}

function segmentsOf(rel: string, platform: PathPlatform): string[] {
  return rel.split(platform === "win32" ? /[\\/]+/ : "/").filter((s) => s !== "");
}

/**
 * Ruling R27: secret matching folds case on every platform (case-insensitive volumes such as APFS open
 * `~/.SSH/config` as `~/.ssh/config`; over-detection only asks). Root containment stays case-sensitive on posix.
 */
function secretOfCanonical(rawTarget: string, ctx: SecretContext): boolean {
  const { platform } = ctx;
  const lc = (s: string) => s.toLowerCase();
  const target = lc(rawTarget);
  const home = lc(requireAbsolute(ctx.home, "home", platform));
  const agentDir = lc(requireAbsolute(ctx.piAgentDir, "piAgentDir", platform));

  const base = api(platform).basename(target);
  if (base === ".env" || (base.startsWith(".env.") && !ENV_EXCLUDED.has(base))) return true;
  if (base === ".npmrc" || base === ".pypirc") return true;
  if (base.endsWith(".pem") || base.startsWith("id_rsa") || base.startsWith("id_ed25519")) return true;

  const agentRel = contains(agentDir, target, platform);
  if (agentRel !== undefined && agentRel === "auth.json") return true;

  const rel = contains(home, target, platform);
  if (rel === undefined || rel === "") return false;
  const seg = segmentsOf(rel, platform);
  const first = seg[0]!;
  const joined = seg.join("/");
  // Intentional superset of ~/.claude*/** and ~/.claude.json: any home entry starting with .claude.
  if (first.startsWith(".claude")) return true;
  if (first === ".ssh" || first === ".gnupg" || first === ".azure") return true;
  if (seg[0] === ".config" && seg[1] === "gcloud") return true;
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

function secretOfCanonicals(c: Canonical, ctx: SecretContext): boolean {
  const forms = c.alt === undefined ? [c.path] : [c.path, c.alt];
  return forms.some((f) => secretOfCanonical(stripTrailingSep(f, ctx.platform), ctx));
}

/**
 * True for secret files. A path that is not a usable absolute path is treated as secret (fail closed).
 * Throws when `home` or `piAgentDir` is not absolute (configuration error).
 */
export function isSecretPath(resolved: string, ctx: SecretContext): boolean {
  requireAbsolute(ctx.home, "home", ctx.platform);
  requireAbsolute(ctx.piAgentDir, "piAgentDir", ctx.platform);
  const c = canon(resolved, ctx.platform);
  if (!c) return true;
  return secretOfCanonicals(c, ctx);
}

export function classifyPath(p: PathFacts, ctx: PathContext): PathClassification {
  const sctx: SecretContext = { home: ctx.home, piAgentDir: ctx.piAgentDir, platform: p.platform };
  requireAbsolute(ctx.home, "home", p.platform);
  requireAbsolute(ctx.piAgentDir, "piAgentDir", p.platform);

  const c = canon(p.resolved, p.platform);
  if (!c) return { secret: true, within: "outside" };
  const target = stripTrailingSep(c.path, p.platform);

  const inputCanon = canon(p.input, p.platform);
  const secret =
    secretOfCanonicals(c, sctx) || (inputCanon !== undefined && secretOfCanonicals(inputCanon, sctx));
  // A leftover `.`/`..` means the caller did not canonicalize: never grant containment.
  if (c.dots) return { secret, within: "outside" };

  const find = (roots: string[]) => {
    for (const root of roots) {
      const rc = canon(root, p.platform);
      if (!rc) continue; // empty / relative roots grant nothing
      const rel = contains(stripTrailingSep(rc.path, p.platform), target, p.platform);
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
