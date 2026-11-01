import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBounded } from "../../../src/adapters/platform/process.ts";
import { classifyGitError, cloneTag, GitError, lsRemoteTags, resolveRef } from "../../../src/adapters/vcs/git.ts";
import { makeBareRepo, makeWorkTree, startGitServer, type GitServer } from "../../helpers/git-server.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

describe("classifyGitError", () => {
  it("classifies credential errors (S2 strings)", () => {
    expect(classifyGitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("auth-https");
    expect(classifyGitError("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe("auth-ssh");
  });

  it("classifies missing repositories", () => {
    expect(classifyGitError("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found")).toBe("not-found");
    expect(classifyGitError("fatal: repository 'http://127.0.0.1:5/x/y.git/' not found")).toBe("not-found");
  });

  it("classifies connection failures as network", () => {
    expect(classifyGitError("fatal: unable to access 'http://127.0.0.1:1/x/y.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Couldn't connect to server")).toBe("network");
    expect(classifyGitError("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com")).toBe("network");
    expect(classifyGitError("ssh: connect to host github.com port 22: Connection timed out")).toBe("network");
    expect(classifyGitError("ssh: connect to host example.com port 22: Connection refused")).toBe("network");
  });

  it("falls back to unknown", () => {
    expect(classifyGitError("fatal: something odd happened")).toBe("unknown");
    expect(classifyGitError("")).toBe("unknown");
  });
});

describe("git adapter against a local smart-HTTP server", () => {
  let tmp: Tmp;
  let server: GitServer;
  let url: string;

  beforeAll(async () => {
    tmp = await makeTmp("git-adapter");
    const work = join(tmp.dir, "work tree");
    await makeWorkTree(work, [{ "README.md": "first\n" }, { "README.md": "second\n" }], { annotatedTags: ["v0.0.0-annotated"] });
    const root = join(tmp.dir, "served root");
    await makeBareRepo(work, join(root, "fixture", "ai-factory.git"), [{ name: "v0.0.1-test" }]);
    server = await startGitServer(root);
    url = server.url("fixture/ai-factory.git");
  });

  afterAll(async () => {
    await server?.close();
    await tmp?.cleanup();
  });

  it("lists tags without refs/tags/ and without peeled lines", async () => {
    const tags = await lsRemoteTags(url);
    expect(tags).toContain("v0.0.1-test");
    expect(tags.filter((t) => t === "v0.0.0-annotated")).toHaveLength(1);
    expect(tags.some((t) => t.includes("refs/") || t.includes("^{}"))).toBe(false);
  });

  it("resolves an existing tag and reports a missing one as false", async () => {
    expect(await resolveRef(url, "v0.0.1-test")).toBe(true);
    expect(await resolveRef(url, "v9.9.9")).toBe(false);
  });

  it("clones a tag shallowly (proves smart HTTP)", async () => {
    const dest = join(tmp.dir, "clone dest");
    await cloneTag(url, "v0.0.1-test", dest);
    expect(await readFile(join(dest, "README.md"), "utf8")).toBe("second\n");
    const count = await runBounded("git", ["-C", dest, "rev-list", "--count", "HEAD"], { timeoutMs: 30_000 });
    expect(count.stdout.trim()).toBe("1");
  });

  it("classifies a missing repository as not-found", async () => {
    const err = await lsRemoteTags(server.url("nope/missing.git")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe("not-found");
  });

  it("rejects an unreachable server within 15 s, classified network", async () => {
    const t0 = Date.now();
    const err = await lsRemoteTags("http://127.0.0.1:1/x/y.git").catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe("network");
    expect(await resolveRef("http://127.0.0.1:1/x/y.git", "v1").catch((e: unknown) => (e as GitError).kind)).toBe("network");
  });

  it("classifies a timeout as network", async () => {
    const err = await lsRemoteTags(url, { timeoutMs: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe("network");
  });
});
