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
  const s = (p: string) => isSecretPath(p, posixCtx);
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
    const ctx = { home: "/home/u", piAgentDir: "/data/pi" };
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
