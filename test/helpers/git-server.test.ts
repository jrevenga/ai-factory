import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBounded } from "../../src/adapters/platform/process.ts";
import { isPidAlive } from "../../src/adapters/store/lock.ts";
import { makeBareRepo, makeWorkTree, startGitServer, type GitServer } from "./git-server.ts";
import { makeTmp, type Tmp } from "./tmp.ts";

function post(url: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...headers, "Content-Length": String(body.length) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

const IGNORE_TERM = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "proc", "ignore-term.mjs");
const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

async function waitForPid(file: string): Promise<number> {
  const t0 = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - t0 > 10_000) throw new Error(`no pid file ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return Number(readFileSync(file, "utf8"));
}

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;

describe("startGitServer / makeBareRepo", () => {
  let tmp: Tmp;
  let server: GitServer;
  let head: string;

  beforeAll(async () => {
    tmp = await makeTmp("git-server");
    const work = join(tmp.dir, "work tree");
    await makeWorkTree(work, [{ "a.txt": "a\n" }]);
    const bare = join(tmp.dir, "root", "fixture", "repo.git");
    await makeBareRepo(work, bare, [{ name: "v1.0.0" }, { name: "v1.0.1", ref: "HEAD" }]);
    head = (await runBounded("git", ["-C", bare, "rev-parse", "HEAD"], { timeoutMs: 30_000, env: NO_PROMPT })).stdout.trim();
    server = await startGitServer(join(tmp.dir, "root"));
  });

  afterAll(async () => {
    await server?.close();
    await tmp?.cleanup();
  });

  it("builds URLs on 127.0.0.1 with the repo path", () => {
    expect(server.url("fixture/repo.git")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/fixture\/repo\.git$/);
  });

  it("serves the tags created by makeBareRepo through git", async () => {
    const r = await runBounded("git", ["ls-remote", "--tags", server.url("fixture/repo.git")], {
      timeoutMs: 30_000,
      env: NO_PROMPT,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${head}\trefs/tags/v1.0.0`);
    expect(r.stdout).toContain(`${head}\trefs/tags/v1.0.1`);
  });

  it("maps the CGI Status header to the HTTP status", async () => {
    expect(await get(server.url("missing/repo.git") + "/info/refs?service=git-upload-pack")).toBe(404);
    expect(await get(server.url("fixture/repo.git") + "/info/refs?service=git-upload-pack")).toBe(200);
  });

  it("decodes gzip request bodies", async () => {
    const body = gzipSync(Buffer.from(`${pkt(`want ${head}\n`)}0000${pkt("done\n")}`));
    const r = await post(server.url("fixture/repo.git") + "/git-upload-pack", { "Content-Type": "application/x-git-upload-pack-request", "Content-Encoding": "gzip" }, body);
    expect(r.status).toBe(200);
    const text = r.body.toString("latin1");
    expect(text).toContain("NAK");
    expect(text).toContain("PACK");
  });

  it("refuses connections after close", async () => {
    const t = await makeTmp("git-server-close");
    try {
      const s = await startGitServer(t.dir);
      const u = s.url("a/b.git");
      await s.close();
      await expect(get(u)).rejects.toThrow();
    } finally {
      await t.cleanup();
    }
  });

  it("a stalled CGI worker is killed at the request timeout and answered 504", async () => {
    const t = await makeTmp("git-server-stall");
    const pidFile = join(t.dir, "worker.pid");
    const s = await startGitServer(t.dir, { requestTimeoutMs: 500, backend: { cmd: process.execPath, args: [IGNORE_TERM, pidFile] } });
    try {
      const t0 = Date.now();
      expect(await get(s.url("a/b.git") + "/info/refs")).toBe(504);
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(isPidAlive(await waitForPid(pidFile))).toBe(false);
    } finally {
      await s.close();
      await t.cleanup();
    }
  });

  it("close() tears down a worker that ignores SIGTERM within a bounded time", async () => {
    const t = await makeTmp("git-server-close-stall");
    const pidFile = join(t.dir, "worker.pid");
    const s = await startGitServer(t.dir, { requestTimeoutMs: 120_000, backend: { cmd: process.execPath, args: [IGNORE_TERM, pidFile] } });
    try {
      const pending = get(s.url("a/b.git") + "/info/refs").catch(() => "closed");
      const pid = await waitForPid(pidFile);
      const t0 = Date.now();
      await s.close();
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(isPidAlive(pid)).toBe(false);
      expect(await pending).toBe("closed");
    } finally {
      await t.cleanup();
    }
  });
});
