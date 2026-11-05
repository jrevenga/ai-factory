import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalDir,
  commandCandidates,
  commandPathFacts,
  gitDirs,
  pathFacts,
  repoRoot,
  resolveToolPath,
  sha256hex,
  worktreeFacts,
} from "../../../../src/adapters/pi/extension/facts.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const isWin = process.platform === "win32";
const host = isWin ? "win32" : "posix";

async function tmp(prefix = "facts"): Promise<string> {
  const t = await makeTmp(prefix);
  cleanups.push(t.cleanup);
  return realpathSync.native(t.dir);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Factory Test", "-c", "user.email=factory-test@example.invalid", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: isWin ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();
}

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** Directory symlink; junctions on Windows need no privilege. */
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, isWin ? "junction" : "dir");
}

describe("pathFacts (tool paths, Pi resolveToCwd semantics)", () => {
  it("a symlink inside the root that points outside resolves outside, including a missing tail", async () => {
    const t = await tmp();
    const root = join(t, "root");
    const outside = join(t, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    linkDir(outside, join(root, "link"));
    const f = pathFacts("link/new dir/file.txt", root, t);
    expect(f).toEqual({ input: "link/new dir/file.txt", resolved: join(outside, "new dir", "file.txt"), platform: host, exists: false, directory: false, lexical: join(root, "link", "new dir", "file.txt") });
  });

  it.skipIf(isWin)("a dangling symlink resolves to its (missing) target, not to the link", async () => {
    const t = await tmp();
    const root = join(t, "root");
    mkdirSync(root);
    mkdirSync(join(t, "outside"));
    symlinkSync(join(t, "outside", "created-later.txt"), join(root, "dangling"));
    expect(pathFacts("dangling", root, t).resolved).toBe(join(t, "outside", "created-later.txt"));
    // A relative dangling target resolves against the link's directory.
    symlinkSync("../outside/rel.txt", join(root, "rel"));
    expect(pathFacts("rel", root, t).resolved).toBe(join(t, "outside", "rel.txt"));
  });

  it.skipIf(isWin)("a symlink loop yields an unresolvable fact (fail closed) for tool and command paths", async () => {
    const t = await tmp();
    symlinkSync(join(t, "b"), join(t, "a"));
    symlinkSync(join(t, "a"), join(t, "b"));
    expect(pathFacts("a/x", t, t).resolved).toBe("");
    expect(commandPathFacts("a/x", t, t).map((f) => f.resolved)).toEqual([""]);
  });

  it("expands ~, strips a leading @ and accepts file:// URLs like Pi", async () => {
    const t = await tmp();
    const home = join(t, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const cwd = join(t, "cwd");
    mkdirSync(cwd);
    expect(pathFacts("~/.ssh/id_rsa", cwd, home).resolved).toBe(join(home, ".ssh", "id_rsa"));
    expect(pathFacts("~", cwd, home).resolved).toBe(home);
    expect(pathFacts("@~/.ssh/id_rsa", cwd, home).resolved).toBe(join(home, ".ssh", "id_rsa"));
    expect(pathFacts("@notes.md", cwd, home).resolved).toBe(join(cwd, "notes.md"));
    expect(pathFacts(pathToFileURL(join(home, ".ssh", "config")).href, cwd, home).resolved).toBe(join(home, ".ssh", "config"));
    // A bare `~user` is a relative name for Pi, not another home.
    expect(pathFacts("~other/x", cwd, home).resolved).toBe(join(cwd, "~other", "x"));
  });

  it("realpaths a symlinked home given to ~ expansion", async () => {
    const t = await tmp();
    mkdirSync(join(t, "real home", ".aws"), { recursive: true });
    linkDir(join(t, "real home"), join(t, "home link"));
    expect(pathFacts("~/.aws/credentials", t, join(t, "home link")).resolved).toBe(join(t, "real home", ".aws", "credentials"));
  });

  it("expands ~ with the home exactly as given (like Pi), so ~/.. under a symlinked home is the lexical parent", async () => {
    const t = await tmp();
    mkdirSync(join(t, "data", "me"), { recursive: true });
    mkdirSync(join(t, "data", "proj"));
    mkdirSync(join(t, "users", "proj"), { recursive: true });
    linkDir(join(t, "data", "me"), join(t, "users", "me"));
    // Pi writes <t>/users/me/../proj/file = <t>/users/proj/file (lexical), not <t>/data/proj/file.
    expect(pathFacts("~/../proj/file", t, join(t, "users", "me")).resolved).toBe(join(t, "users", "proj", "file"));
    // bash resolves .. physically after the home symlink.
    expect(commandPathFacts("~/../proj/file", t, join(t, "users", "me"))[0]!.resolved).toBe(join(t, "data", "proj", "file"));
  });

  it("collapses .. lexically before the filesystem, as Pi's tools do", async () => {
    const t = await tmp();
    const root = join(t, "root");
    mkdirSync(join(t, "outside", "deep"), { recursive: true });
    mkdirSync(root);
    linkDir(join(t, "outside", "deep"), join(root, "link"));
    expect(pathFacts("link/../x.txt", root, t).resolved).toBe(join(root, "x.txt"));
  });

  it("normalizes unicode spaces like Pi", async () => {
    const t = await tmp();
    expect(pathFacts("a\u00A0b.txt", t, t).resolved).toBe(join(t, "a b.txt"));
  });

  it("an invalid file URL yields a fact core treats as secret and outside (fail closed)", async () => {
    const t = await tmp();
    const f = pathFacts(isWin ? "file:///C:/a%2Fb" : "file://remote-host/x", t, t);
    expect(f.resolved).toBe("");
    expect(f.input).toBe(isWin ? "file:///C:/a%2Fb" : "file://remote-host/x");
  });

  it("read variants: a missing path falls back to Pi's macOS screenshot variant when it exists", async () => {
    const t = await tmp();
    writeFileSync(join(t, "Shot 10.00.00\u202FAM.png"), "");
    expect(pathFacts("Shot 10.00.00 AM.png", t, t, { read: true }).resolved).toBe(join(t, "Shot 10.00.00\u202FAM.png"));
    expect(pathFacts("Shot 10.00.00 AM.png", t, t).resolved).toBe(join(t, "Shot 10.00.00 AM.png"));
  });

  it.skipIf(!isWin)("a Git Bash drive path normalizes to a Windows path", async () => {
    const t = await tmp();
    const drive = t[0]!.toLowerCase();
    const gitBash = `/${drive}/${t.slice(3).replaceAll("\\", "/")}/x.txt`;
    expect(pathFacts(gitBash, "C:\\", t).resolved.toLowerCase()).toBe(join(t, "x.txt").toLowerCase());
  });
});

describe("resolveToolPath (lexical, both platforms)", () => {
  it("win32: Git Bash /c/, /mnt/c/ and /cygdrive/c/ drive forms, ~\\ and file URLs", () => {
    const home = "C:\\Users\\me";
    expect(resolveToolPath("/c/Users/me/x", "D:\\proj", home, "win32")).toBe("C:\\Users\\me\\x");
    expect(resolveToolPath("/mnt/d/a", "C:\\proj", home, "win32")).toBe("D:\\a");
    expect(resolveToolPath("/cygdrive/e/", "C:\\proj", home, "win32")).toBe("E:\\");
    expect(resolveToolPath("~\\.ssh\\id_rsa", "D:\\proj", home, "win32")).toBe("C:\\Users\\me\\.ssh\\id_rsa");
    expect(resolveToolPath("file:///C:/x/y.txt", "D:\\proj", home, "win32")).toBe("C:\\x\\y.txt");
    expect(resolveToolPath("src/a.ts", "D:\\proj", home, "win32")).toBe("D:\\proj\\src\\a.ts");
    // `//server/share` is not a Git Bash drive path.
    expect(resolveToolPath("//srv/share/x", "D:\\proj", home, "win32")).toBe("\\\\srv\\share\\x");
  });

  it("posix: no Git Bash conversion and no ~\\ expansion", () => {
    expect(resolveToolPath("/c/x", "/proj", "/home/me", "posix")).toBe("/c/x");
    expect(resolveToolPath("~\\x", "/proj", "/home/me", "posix")).toBe("/proj/~\\x");
    expect(resolveToolPath("~/x", "/proj", "/home/me", "posix")).toBe("/home/me/x");
  });
});

describe("command path facts (bash semantics)", () => {
  it("R37: report whether the target is a directory (following links); a missing target is not one", async () => {
    const t = await tmp();
    const root = join(t, "root");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "a.ts"), "1\n");
    linkDir(join(root, "src"), join(root, "link"));
    expect(commandPathFacts("src", root, t)[0]!.directory).toBe(true);
    expect(commandPathFacts("link", root, t)[0]!.directory).toBe(true);
    expect(commandPathFacts("a.ts", root, t)[0]!.directory).toBe(false);
    expect(commandPathFacts("missing.ts", root, t)[0]!.directory).toBe(false);
  });

  it("resolve .. physically: a symlink followed by .. leaves the root", async () => {
    const t = await tmp();
    const root = join(t, "root");
    mkdirSync(join(t, "outside", "deep"), { recursive: true });
    mkdirSync(root);
    linkDir(join(t, "outside", "deep"), join(root, "link"));
    expect(commandPathFacts("link/../x.txt", root, t)).toEqual([
      { input: "link/../x.txt", resolved: join(t, "outside", "x.txt"), platform: host, exists: false, directory: false, lexical: join(root, "x.txt") },
    ]);
  });

  it("after .. climbs out of a missing directory, later symlinks are followed again", async () => {
    const t = await tmp();
    const root = join(t, "root");
    mkdirSync(root);
    mkdirSync(join(t, "outside"));
    linkDir(join(t, "outside"), join(root, "link"));
    expect(commandPathFacts("missing/../link/x", root, t)[0]!.resolved).toBe(join(t, "outside", "x"));
  });

  it("expand a leading ~/ and keep the raw argument as input; no @ stripping or file URLs", async () => {
    const t = await tmp();
    mkdirSync(join(t, "home"));
    expect(commandPathFacts("~/.netrc", t, join(t, "home"))[0]!.resolved).toBe(join(t, "home", ".netrc"));
    expect(commandPathFacts("@x", t, t)[0]!.resolved).toBe(join(t, "@x"));
  });

  it("candidates: win32 gives the Git Bash and the Windows reading of /c/...; posix gives one", () => {
    expect(commandCandidates("/c/Users/me/x", "D:\\proj", "C:\\Users\\me", "win32")).toEqual(["C:\\Users\\me\\x", "D:/c/Users/me/x"]);
    expect(commandCandidates("src/../x", "D:\\proj", "C:\\Users\\me", "win32")).toEqual(["D:\\proj\\src/../x"]);
    expect(commandCandidates("~/.ssh/k", "D:\\proj", "C:\\Users\\me", "win32")).toEqual(["C:\\Users\\me\\.ssh/k"]);
    // An MSYS mount path (/tmp, /usr, /etc) has no known Windows location in Git Bash: unresolvable candidate.
    expect(commandCandidates("/tmp/x", "D:\\proj", "C:\\Users\\me", "win32")).toEqual(["", "D:/tmp/x"]);
    expect(commandCandidates("/etc/hosts", "/proj", "/home/me", "posix")).toEqual(["/etc/hosts"]);
    expect(commandCandidates("a/../b", "/proj", "/home/me", "posix")).toEqual(["/proj/a/../b"]);
  });
});

describe("canonicalDir", () => {
  it("realpaths an existing symlinked dir and keeps a missing tail; rejects relative or empty input", async () => {
    const t = await tmp();
    mkdirSync(join(t, "real"));
    linkDir(join(t, "real"), join(t, "alias"));
    expect(canonicalDir(join(t, "alias"))).toBe(join(t, "real"));
    expect(canonicalDir(join(t, "alias", "missing", "agent"))).toBe(join(t, "real", "missing", "agent"));
    expect(() => canonicalDir("relative/dir")).toThrow(/absolute/);
    expect(() => canonicalDir("")).toThrow(/absolute/);
  });
});

describe("git facts", () => {
  // The code under test inherits the process env: keep the developer's git config out of it.
  beforeAll(() => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", isWin ? "NUL" : "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("repoRoot returns the realpathed toplevel from a subdirectory, undefined outside a repository", async () => {
    const t = await tmp();
    const r = repo(join(t, "proj"));
    mkdirSync(join(r, "src"));
    linkDir(r, join(t, "proj-link"));
    expect(repoRoot(join(t, "proj-link", "src"))).toBe(r);
    mkdirSync(join(t, "plain"));
    expect(repoRoot(join(t, "plain"))).toBeUndefined();
    expect(repoRoot(join(t, "does-not-exist"))).toBeUndefined();
  });

  it("gitDirs returns the git dir and the common dir, absolute and realpathed", async () => {
    const t = await tmp();
    const r = repo(join(t, "proj"));
    expect(gitDirs(r)).toEqual([join(r, ".git")]);
    git(r, "worktree", "add", "-q", "-b", "factory/t1", join(t, "wt"));
    expect(gitDirs(join(t, "wt"))).toEqual([join(r, ".git", "worktrees", "wt"), join(r, ".git")]);
    mkdirSync(join(t, "plain"));
    expect(gitDirs(join(t, "plain"))).toEqual([]);
  });

  it("worktreeFacts: same-repo worktree with its branch; other repo; missing path; repository subdirectory", async () => {
    const t = await tmp();
    const r = repo(join(t, "proj"));
    git(r, "worktree", "add", "-q", "-b", "factory/t1", join(t, "wt"));
    expect(worktreeFacts(join(t, "wt"), r)).toEqual({ exists: true, sameRepo: true, branch: "factory/t1" });
    const other = repo(join(t, "other"));
    expect(worktreeFacts(other, r)).toEqual({ exists: true, sameRepo: false, branch: "main" });
    expect(worktreeFacts(join(t, "nope"), r)).toEqual({ exists: false, sameRepo: false });
    mkdirSync(join(t, "wt", "sub"));
    expect(worktreeFacts(join(t, "wt", "sub"), r).sameRepo).toBe(false);
    git(join(t, "wt"), "checkout", "-q", "--detach");
    expect(worktreeFacts(join(t, "wt"), r)).toEqual({ exists: true, sameRepo: true });
  });
});

describe("sha256hex", () => {
  it("hashes UTF-8 text to lowercase hex", () => {
    expect(sha256hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
