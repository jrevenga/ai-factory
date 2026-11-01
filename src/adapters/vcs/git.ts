// Git through the `git` executable, always non-interactive (no credential prompts) and time-bounded, so
// a missing credential or an offline machine fails fast with a classified error (A §6.2/C1, S2).
import { runBounded, type RunResult } from "../platform/process.ts";

export type GitErrorKind = "auth-https" | "auth-ssh" | "not-found" | "network" | "unknown";

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Default 60 s. */
  timeoutMs?: number;
}

export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly stderr: string;
  readonly code: number | null;
  constructor(args: string[], result: Pick<RunResult, "code" | "stderr" | "timedOut">) {
    const kind: GitErrorKind = result.timedOut ? "network" : classifyGitError(result.stderr);
    const detail = result.timedOut ? "timed out" : `exited with ${result.code}`;
    super(`git ${args.join(" ")} ${detail} (${kind}): ${result.stderr.trim() || "no output"}`);
    this.name = "GitError";
    this.kind = kind;
    this.stderr = result.stderr;
    this.code = result.code;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Maps git's stderr to a cause the user can act on. Order matters: SSH auth also prints "Could not read from remote". */
export function classifyGitError(stderr: string): GitErrorKind {
  if (/could not read (username|password) for 'https?:\/\//i.test(stderr) || /authentication failed for/i.test(stderr)) return "auth-https";
  if (/permission denied \(publickey/i.test(stderr) || /host key verification failed/i.test(stderr)) return "auth-ssh";
  if (/repository not found/i.test(stderr) || /\bnot found\b/i.test(stderr)) return "not-found";
  if (
    /could not resolve host|failed to connect|couldn'?t connect|could not connect|connection (refused|timed out|reset)|operation timed out|network is unreachable|no route to host|timed out/i.test(
      stderr,
    )
  ) {
    return "network";
  }
  return "unknown";
}

/** Runs git non-interactively; rejects with GitError on a non-zero exit or timeout. */
export async function git(args: string[], opts: GitOptions = {}): Promise<RunResult> {
  let result: RunResult;
  try {
    result = await runBounded("git", args, {
      cwd: opts.cwd,
      env: { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("git was not found on PATH. Install Git (https://git-scm.com/downloads) and retry.", { cause: e });
    }
    throw e;
  }
  if (result.code !== 0) throw new GitError(args, result);
  return result;
}

/** Tag names on the remote (without `refs/tags/`; peeled `^{}` lines dropped). */
export async function lsRemoteTags(url: string, opts: GitOptions = {}): Promise<string[]> {
  const { stdout } = await git(["ls-remote", "--tags", "--refs", "--", url], opts);
  const tags: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const ref = line.split("\t")[1];
    if (ref === undefined || !ref.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
    tags.push(ref.slice("refs/tags/".length));
  }
  return tags;
}

/** True when `tag` exists on the remote, false when it does not; rejects with GitError when the remote cannot be read. */
export async function resolveRef(url: string, tag: string, opts: GitOptions = {}): Promise<boolean> {
  const { stdout } = await git(["ls-remote", "--tags", "--refs", "--", url, `refs/tags/${tag}`], opts);
  return stdout.split(/\r?\n/).some((line) => line.split("\t")[1] === `refs/tags/${tag}`);
}

/** Shallow clone of one tag (needs a smart-protocol remote). */
export async function cloneTag(url: string, tag: string, dest: string, opts: GitOptions = {}): Promise<void> {
  await git(["clone", "--quiet", "--depth", "1", "--branch", tag, "--", url, dest], opts);
}
