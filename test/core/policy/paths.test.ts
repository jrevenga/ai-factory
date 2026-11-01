import { describe, expect, it } from "vitest";
import { classifyPath, isSecretPath, type PathContext } from "../../../src/core/policy/paths.ts";

const posixCtx: PathContext = {
  home: "/home/u",
  piAgentDir: "/home/u/.pi/agent",
  writeRoots: ["/work/root"],
  tmpRoots: ["/tmp"],
};
const winCtx: PathContext = {
  home: "C:\\Users\\u",
  piAgentDir: "C:\\Users\\u\\.pi\\agent",
  writeRoots: ["c:\\repo"],
  tmpRoots: ["C:\\Temp"],
};
const posix = (resolved: string) => ({ input: resolved, resolved, platform: "posix" as const });
const win = (resolved: string) => ({ input: resolved, resolved, platform: "win32" as const });

describe("classifyPath containment", () => {
  it("classifies by path segments, not string prefix", () => {
    expect(classifyPath(posix("/work/root/a"), posixCtx)).toMatchObject({
      within: "write-root",
      root: "/work/root",
      relative: "a",
    });
    expect(classifyPath(posix("/work/root"), posixCtx)).toMatchObject({ within: "write-root", relative: "" });
    expect(classifyPath(posix("/work/x"), posixCtx).within).toBe("outside");
    expect(classifyPath(posix("/work/root-other/x"), posixCtx).within).toBe("outside");
    expect(classifyPath(posix("/work/root/../x"), posixCtx).within).toBe("outside");
    expect(classifyPath(posix("/tmp/y/z"), posixCtx)).toMatchObject({ within: "tmp", root: "/tmp" });
  });

  it("is case-insensitive on win32 and normalizes Git Bash paths", () => {
    expect(classifyPath(win("C:\\Repo\\a"), winCtx)).toMatchObject({ within: "write-root", relative: "a" });
    expect(classifyPath(win("/c/Repo/a"), winCtx).within).toBe("write-root");
    expect(classifyPath(win("C:\\Repo-other\\a"), winCtx).within).toBe("outside");
    expect(classifyPath(win("C:\\Repo\\..\\x"), winCtx).within).toBe("outside");
    expect(classifyPath(win("D:\\repo\\a"), winCtx).within).toBe("outside");
    expect(classifyPath(win("/c/temp/q"), winCtx).within).toBe("tmp");
  });

  it("stays case-sensitive on posix", () => {
    expect(classifyPath(posix("/work/ROOT/a"), posixCtx).within).toBe("outside");
  });

  it("flags secrets independently of containment", () => {
    expect(classifyPath(posix("/work/root/.env"), posixCtx)).toMatchObject({ secret: true, within: "write-root" });
    expect(classifyPath(posix("/work/root/src/a.ts"), posixCtx).secret).toBe(false);
  });
});

describe("isSecretPath", () => {
  const s = (p: string) => isSecretPath(p, { ...posixCtx, platform: "posix" });
  it("matches project secret files", () => {
    expect(s("/proj/.env")).toBe(true);
    expect(s("/proj/sub/.env.local")).toBe(true);
    expect(s("/proj/.env.production")).toBe(true);
    expect(s("/proj/.env.example")).toBe(false);
    expect(s("/proj/.env.sample")).toBe(false);
    expect(s("/proj/.env.template")).toBe(false);
    expect(s("/proj/.environment")).toBe(false);
    expect(s("/proj/.npmrc")).toBe(true);
    expect(s("/proj/.pypirc")).toBe(true);
    expect(s("/proj/certs/server.pem")).toBe(true);
    expect(s("/proj/id_rsa")).toBe(true);
    expect(s("/proj/id_rsa.pub")).toBe(true);
    expect(s("/proj/id_ed25519")).toBe(true);
    expect(s("/proj/readme.md")).toBe(false);
  });
  it("matches home-anchored secrets", () => {
    expect(s("/home/u/.ssh/id_ed25519")).toBe(true);
    expect(s("/home/u/.ssh/config")).toBe(true);
    expect(s("/home/u/.pi/agent/auth.json")).toBe(true);
    expect(s("/home/u/.pi/agent/settings.json")).toBe(false);
    expect(s("/home/u/.claude/settings.json")).toBe(true);
    expect(s("/home/u/.claude.json")).toBe(true);
    expect(s("/home/u/.codex/auth.json")).toBe(true);
    expect(s("/home/u/.codex/config.toml")).toBe(false);
    expect(s("/home/u/.aws/credentials")).toBe(true);
    expect(s("/home/u/.aws/config")).toBe(false);
    expect(s("/home/u/.config/gh/hosts.yml")).toBe(true);
    expect(s("/home/u/.netrc")).toBe(true);
    expect(s("/home/u/.git-credentials")).toBe(true);
    expect(s("/home/u/.docker/config.json")).toBe(true);
    expect(s("/home/u/.kube/config")).toBe(true);
    expect(s("/home/u/.gnupg/pubring.kbx")).toBe(true);
    expect(s("/home/u/.config/gcloud/credentials.db")).toBe(true);
    expect(s("/home/u/.azure/accessTokens.json")).toBe(true);
    expect(s("/home/u/.config/other/x")).toBe(false);
    expect(s("/other/.ssh/x")).toBe(false);
  });
  it("honours a custom Pi agent dir", () => {
    const ctx = { home: "/home/u", piAgentDir: "/data/pi", platform: "posix" as const };
    expect(isSecretPath("/data/pi/auth.json", ctx)).toBe(true);
    expect(isSecretPath("/data/pi/sessions/a.jsonl", ctx)).toBe(false);
  });
  it("is case-insensitive on win32, including Git Bash paths", () => {
    const w = (p: string) => isSecretPath(p, { ...winCtx, platform: "win32" });
    expect(w("C:\\USERS\\U\\.SSH\\id_rsa")).toBe(true);
    expect(w("/c/Users/u/.ssh/key")).toBe(true);
    expect(w("C:\\Repo\\.ENV")).toBe(true);
    expect(w("C:\\Repo\\.Env.Example")).toBe(false);
    expect(w("C:\\Users\\u\\.pi\\agent\\AUTH.JSON")).toBe(true);
    expect(w("C:\\Repo\\a.txt")).toBe(false);
  });
});

describe("fail-closed inputs", () => {
  it("ignores empty and non-absolute roots", () => {
    const cwd = process.cwd();
    for (const root of ["", "x", ".", "..", cwd.slice(1)]) {
      const ctx = { ...posixCtx, writeRoots: [root], tmpRoots: [root] };
      expect(classifyPath(posix(`${cwd}/x/y`), ctx).within).toBe("outside");
      expect(classifyPath(posix("/x/y"), ctx).within).toBe("outside");
    }
    const w = { ...winCtx, writeRoots: ["repo", "\\repo", "C:repo"], tmpRoots: [] };
    expect(classifyPath(win("C:\\repo\\a"), w).within).toBe("outside");
  });

  it("treats a non-absolute resolved path as outside and secret", () => {
    expect(classifyPath(posix("a"), { ...posixCtx, writeRoots: [process.cwd()] })).toMatchObject({
      secret: true,
      within: "outside",
    });
    expect(classifyPath(posix(""), posixCtx)).toMatchObject({ secret: true, within: "outside" });
    expect(classifyPath(win("repo\\a"), winCtx)).toMatchObject({ secret: true, within: "outside" });
    expect(classifyPath(win("\\rooted"), winCtx)).toMatchObject({ secret: true, within: "outside" });
    expect(isSecretPath("rel/x", { home: "/home/u", piAgentDir: "/p", platform: "posix" })).toBe(true);
  });

  it("throws on an empty or relative home or piAgentDir", () => {
    expect(() => isSecretPath("/a", { home: "", piAgentDir: "/p", platform: "posix" })).toThrow();
    expect(() => isSecretPath("/a", { home: "h", piAgentDir: "/p", platform: "posix" })).toThrow();
    expect(() => isSecretPath("/a", { home: "/h", piAgentDir: "", platform: "posix" })).toThrow();
    expect(() => classifyPath(posix("/a"), { ...posixCtx, piAgentDir: "p" })).toThrow();
    expect(() => classifyPath(win("C:\\a"), { ...winCtx, home: "" })).toThrow();
  });

  it("treats any . or .. segment in resolved as outside", () => {
    expect(classifyPath(posix("/work/root/../x"), posixCtx).within).toBe("outside");
    expect(classifyPath(posix("/work/root/link/../x"), posixCtx).within).toBe("outside");
    expect(classifyPath(posix("/work/root/./a"), posixCtx).within).toBe("outside");
    expect(classifyPath(win("C:\\repo\\.\\a"), winCtx).within).toBe("outside");
    expect(classifyPath(win("C:\\repo\\.. \\a"), winCtx).within).toBe("outside");
    expect(classifyPath(posix("/work/root/a/../.env"), posixCtx)).toMatchObject({ secret: true, within: "outside" });
    expect(classifyPath(posix("/work/root/..a/b"), posixCtx).within).toBe("write-root");
  });
});

describe("posix separators and roots", () => {
  it("strips only / and keeps a backslash as a filename character", () => {
    const r = classifyPath(posix("/work/root\\"), posixCtx);
    expect(r.within).toBe("outside");
    expect(classifyPath(posix("/work/root/"), posixCtx)).toMatchObject({ within: "write-root", relative: "" });
    expect(classifyPath(posix("/work/root/a"), { ...posixCtx, writeRoots: ["/work/root/"] }).within).toBe("write-root");
    expect(classifyPath(posix("/anything/x"), { ...posixCtx, writeRoots: ["/"] }).within).toBe("write-root");
  });
});

describe("win32 canonicalization", () => {
  const w = (p: string) => isSecretPath(p, { ...winCtx, platform: "win32" });
  it("catches Windows aliases of secret files", () => {
    expect(w("C:\\repo\\.env ")).toBe(true);
    expect(w("C:\\repo\\.npmrc.")).toBe(true);
    expect(w("C:\\repo\\key.pem.")).toBe(true);
    expect(w("C:\\repo\\.env::$DATA")).toBe(true);
    expect(w("C:\\repo\\.env:s")).toBe(true);
    expect(w("C:\\Users\\u\\.ssh.\\config")).toBe(true);
    expect(w("C:\\Users\\u\\.ssh \\config")).toBe(true);
    expect(w("\\\\?\\C:\\Users\\u\\.aws\\credentials")).toBe(true);
    expect(w("\\\\.\\C:\\Users\\u\\.netrc")).toBe(true);
    expect(w("C:\\repo\\id_rsa.pub")).toBe(true);
    expect(w("C:\\Users\\u\\.CLAUDE\\x")).toBe(true);
    expect(w("C:\\repo\\notes.txt")).toBe(false);
  });
  it("fails closed on a colon after the drive position", () => {
    expect(classifyPath(win("C:\\repo\\a.txt:stream"), winCtx)).toMatchObject({ secret: true, within: "outside" });
    expect(classifyPath(win("C:\\repo\\a:b\\c"), winCtx)).toMatchObject({ secret: true, within: "outside" });
  });
  it("normalizes device prefixes and trailing dots/spaces for containment", () => {
    expect(classifyPath(win("\\\\?\\C:\\repo\\a"), winCtx)).toMatchObject({ within: "write-root", relative: "a" });
    expect(classifyPath(win("C:\\repo\\a. "), winCtx)).toMatchObject({ within: "write-root", relative: "a" });
    expect(classifyPath(win("C:/repo/a"), winCtx).within).toBe("write-root");
    const unc = { ...winCtx, writeRoots: ["\\\\srv\\share\\w"] };
    expect(classifyPath(win("\\\\?\\UNC\\srv\\share\\w\\f"), unc).within).toBe("write-root");
    expect(classifyPath(win("\\\\srv\\share\\w2\\f"), unc).within).toBe("outside");
  });
  it("checks an absolute win32 input on a posix host", () => {
    const r = classifyPath({ input: "C:\\Users\\u\\.ssh\\id", resolved: "C:\\repo\\link", platform: "win32" }, winCtx);
    expect(r.secret).toBe(true);
  });
  it("keeps drive roots and a bare root working", () => {
    const ctx = { ...winCtx, writeRoots: ["C:\\"] };
    expect(classifyPath(win("C:\\x\\y"), ctx)).toMatchObject({ within: "write-root", relative: "x\\y" });
    expect(classifyPath(win("D:\\x"), ctx).within).toBe("outside");
  });
});

describe("win32 shell path conversion (mirrors Pi normalizeWindowsShellPath)", () => {
  const w = (p: string) => classifyPath(win(p), winCtx).within;
  const sec = (p: string) => isSecretPath(p, { ...winCtx, platform: "win32" });
  it("converts /c, /mnt/c and /cygdrive/c", () => {
    expect(w("/c/repo/a")).toBe("write-root");
    expect(w("/C/Repo/a")).toBe("write-root");
    expect(w("/mnt/c/repo/a")).toBe("write-root");
    expect(w("/cygdrive/c/repo/a")).toBe("write-root");
    expect(w("/c")).toBe("outside");
    expect(sec("/mnt/c/Users/u/.ssh/config")).toBe(true);
    expect(sec("/cygdrive/c/Users/u/.aws/credentials")).toBe(true);
    expect(sec("/c/Users/u/.ssh/config")).toBe(true);
  });
  it("does not convert with a backslash, a leading //, or a longer first segment", () => {
    expect(w("/c/repo\\x")).toBe("outside");
    expect(sec("/c/Users/u/.ssh\\config")).toBe(true); // not absolute on win32: fail closed
    expect(w("//c/repo/a")).toBe("outside");
    expect(w("/cc/repo/a")).toBe("outside");
    expect(w("/mnt/repo/a")).toBe("outside");
  });
});

describe("win32 verbatim paths and non-final trailing dots/spaces", () => {
  const ctx = { ...winCtx, writeRoots: ["C:\\repo"] };
  const within = (p: string, c = ctx) => classifyPath(win(p), c).within;
  it("never maps literal verbatim names into the write root", () => {
    expect(within("\\\\?\\C:\\repo \\x")).toBe("outside");
    expect(within("\\\\?\\C:\\repo.\\x")).toBe("outside");
    expect(within("\\\\?\\C:\\...\\x", { ...winCtx, writeRoots: ["C:\\x"] })).toBe("outside");
    expect(within("\\\\?\\C:\\repo\\x.")).toBe("outside");
    expect(within("\\\\?\\C:\\repo\\x ")).toBe("outside");
    expect(within("\\\\?\\C:\\repo\\x")).toBe("write-root");
  });
  it("fails closed on non-final segments that end in dot/space or are all dots", () => {
    expect(within("C:\\repo \\x")).toBe("outside");
    expect(within("C:\\repo.\\x")).toBe("outside");
    expect(within("C:\\repo\\...\\x")).toBe("outside");
    expect(within("C:\\repo\\sub.\\x")).toBe("outside");
    expect(within("C:\\repo\\sub\\x. ")).toBe("write-root"); // only the final segment is trimmed
  });
  it("still computes secret on both the literal and the trimmed form", () => {
    expect(classifyPath(win("C:\\Users\\u\\.ssh.\\config"), winCtx)).toMatchObject({ secret: true, within: "outside" });
    expect(classifyPath(win("\\\\?\\C:\\repo\\.env "), ctx)).toMatchObject({ secret: true, within: "outside" });
  });
});
