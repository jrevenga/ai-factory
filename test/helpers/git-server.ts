// Local smart-HTTP git server for release fixtures (plan ruling 7). Pi 1.4.0 rejects `git:file://`
// refs but accepts `git:http://127.0.0.1:<port>/<a>/<b>.git@<tag>`, and dumb HTTP cannot serve
// shallow clones, so each request is bridged to `git http-backend` (CGI; ships with Git on Linux and
// Git for Windows). No shell is used, so it works the same on Windows.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { runBounded } from "../../src/adapters/platform/process.ts";

export interface GitServer {
  /** `http://127.0.0.1:<port>/<repoRelPath>` (forward slashes). */
  url(repoRelPath: string): string;
  /** Stops listening, drops open connections and kills running http-backend children. */
  close(): Promise<void>;
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const IDENTITY = ["-c", "user.name=factory-test", "-c", "user.email=factory-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

/** Runs git for fixture setup; throws with stderr on failure. */
async function gitOk(args: string[], cwd?: string): Promise<string> {
  const r = await runBounded("git", [...IDENTITY, ...args], { cwd, env: { ...process.env, ...GIT_ENV }, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.code}, timedOut ${r.timedOut}):\n${r.stderr}`);
  return r.stdout;
}

/**
 * Creates a git work tree at `dir` with one commit per entry of `commits` (file path → content, paths
 * with `/` create directories) on branch `main`, then the given annotated tags at HEAD.
 */
export async function makeWorkTree(dir: string, commits: Record<string, string>[], opts: { annotatedTags?: string[] } = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await gitOk(["init", "--quiet", "--initial-branch=main"], dir);
  for (const [i, files] of commits.entries()) {
    for (const [rel, content] of Object.entries(files)) {
      const file = join(dir, ...rel.split("/"));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await gitOk(["add", "--all"], dir);
    await gitOk(["commit", "--quiet", "--allow-empty", "-m", `fixture commit ${i + 1}`], dir);
  }
  for (const tag of opts.annotatedTags ?? []) await gitOk(["tag", "-a", tag, "-m", tag], dir);
}

/** Bare clone of the work tree at `dest`, with lightweight `tags` at `ref` (default HEAD), replacing same-named tags. */
export async function makeBareRepo(fromWorkTree: string, dest: string, tags: { name: string; ref?: string }[]): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await gitOk(["clone", "--quiet", "--bare", "--", fromWorkTree, dest]);
  for (const t of tags) await gitOk(["-C", dest, "tag", "--force", t.name, t.ref ?? "HEAD"]);
}

/** Splits CGI output into headers and the start of the body once the blank line has arrived. */
function splitCgiHeaders(buf: Buffer): { head: string; body: Buffer } | undefined {
  const crlf = buf.indexOf("\r\n\r\n");
  const lf = buf.indexOf("\n\n");
  if (crlf < 0 && lf < 0) return undefined;
  const useCrlf = crlf >= 0 && (lf < 0 || crlf < lf);
  const end = useCrlf ? crlf : lf;
  return { head: buf.subarray(0, end).toString("latin1"), body: buf.subarray(end + (useCrlf ? 4 : 2)) };
}

function respondCgi(child: ChildProcess, res: ServerResponse): void {
  let pending: Buffer = Buffer.alloc(0);
  let headersSent = false;
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdout?.on("data", (chunk: Buffer) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const parsed = splitCgiHeaders(pending);
    if (!parsed) return;
    headersSent = true;
    let status = 200;
    for (const line of parsed.head.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
      else res.appendHeader(name, value);
    }
    res.statusCode = status;
    if (parsed.body.length > 0) res.write(parsed.body);
  });
  child.on("error", (e) => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`git http-backend could not start: ${e.message}\n`);
  });
  child.on("close", (code) => {
    if (!headersSent && !res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`git http-backend exited with ${code} before sending headers\n${stderr}`);
      return;
    }
    res.end();
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(", ") : v;
}

/** Starts a smart-HTTP git server for the repositories under `projectRoot` on 127.0.0.1 (random port). */
export async function startGitServer(projectRoot: string): Promise<GitServer> {
  const root = resolve(projectRoot);
  const children = new Set<ChildProcess>();

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...GIT_ENV,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(u.pathname),
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: u.search.replace(/^\?/, ""),
      CONTENT_TYPE: header(req, "content-type") ?? "",
      REMOTE_ADDR: req.socket.remoteAddress ?? "127.0.0.1",
      GATEWAY_INTERFACE: "CGI/1.1",
      SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
    };
    // Without CONTENT_LENGTH http-backend reads the (de-chunked) body until EOF.
    const length = header(req, "content-length");
    if (length !== undefined) env.CONTENT_LENGTH = length;
    else delete env.CONTENT_LENGTH;
    // git gzips large upload-pack requests; http-backend inflates them itself when told.
    const encoding = header(req, "content-encoding");
    if (encoding !== undefined) env.HTTP_CONTENT_ENCODING = encoding;
    const protocol = header(req, "git-protocol");
    if (protocol !== undefined) env.HTTP_GIT_PROTOCOL = protocol;

    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.stdin?.on("error", () => {});
    req.pipe(child.stdin!);
    respondCgi(child, res);
    res.on("close", () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: (repoRelPath) => `http://127.0.0.1:${port}/${repoRelPath.replace(/\\/g, "/").replace(/^\/+/, "")}`,
    async close() {
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      const exits = [...children].map(
        (c) =>
          new Promise<void>((r) => {
            if (c.exitCode !== null || c.signalCode !== null) return r();
            c.once("close", () => r());
            c.kill();
          }),
      );
      await Promise.all([closed, ...exits]);
    },
  };
}
