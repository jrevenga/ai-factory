import { isAbsolute, resolve, sep } from "node:path";
import { runBounded } from "../platform/process.ts";

export interface SandboxSpec {
  /** Roots replaced by an empty tmpfs (deduplicated; parents are mounted before children). */
  hide: string[];
  roBinds: string[];
  rwBinds: string[];
  cwd: string;
  network: boolean;
}

function absolute(p: string, what: string): string {
  if (!isAbsolute(p)) throw new Error(`sandbox ${what} must be an absolute path: ${p}`);
  return resolve(p);
}

const depth = (p: string) => p.split(sep).filter(Boolean).length;

/** Builds the `bwrap` argument vector (ruling 1 order). Throws on a relative path. */
export function sandboxArgs(spec: SandboxSpec, command: string, args: string[]): string[] {
  const hide = [...new Set(spec.hide.map((p) => absolute(p, "hidden root")))].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  const ro = spec.roBinds.map((p) => absolute(p, "ro bind"));
  const rw = spec.rwBinds.map((p) => absolute(p, "rw bind"));
  const cwd = absolute(spec.cwd, "cwd");
  return [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    ...hide.flatMap((p) => ["--tmpfs", p]),
    ...ro.flatMap((p) => ["--ro-bind", p, p]),
    ...rw.flatMap((p) => ["--bind", p, p]),
    "--chdir", cwd,
    "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session",
    ...(spec.network ? [] : ["--unshare-net"]),
    "--", command, ...args,
  ];
}

export type BwrapStatus = { ok: true; version: string } | { ok: false; reason: string };

/** Whether an unprivileged `bwrap` works here. Never spawns off Linux. */
export async function bwrapUsable(platform: NodeJS.Platform = process.platform): Promise<BwrapStatus> {
  if (platform !== "linux") return { ok: false, reason: `bubblewrap sandboxing needs Linux (this is ${platform})` };
  try {
    const v = await runBounded("bwrap", ["--version"], { timeoutMs: 5000 });
    if (v.code !== 0) return { ok: false, reason: `bwrap --version failed: ${(v.stderr || v.stdout).trim() || (v.timedOut ? "timed out" : `exit ${v.code}`)}` };
    const probe = await runBounded("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--die-with-parent", "true"], { timeoutMs: 5000 });
    if (probe.code !== 0) return { ok: false, reason: `bwrap cannot create a sandbox here: ${probe.stderr.trim() || (probe.timedOut ? "timed out" : `exit ${probe.code}`)}` };
    return { ok: true, version: v.stdout.trim() };
  } catch (e) {
    return { ok: false, reason: `bwrap is not available: ${e instanceof Error ? e.message : String(e)}` };
  }
}
