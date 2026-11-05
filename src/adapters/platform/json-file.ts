// JSON documents on disk: tolerant read (missing → undefined) and atomic write (tmp + fsync + rename).
import { randomBytes } from "node:crypto";
import { open, readFile, rename as fsRename, rm } from "node:fs/promises";

export class MalformedJson extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`Malformed JSON in ${path}: ${(cause as Error).message}. Fix or remove the file and retry.`, { cause });
    this.name = "MalformedJson";
    this.path = path;
  }
}

export async function readJson(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new MalformedJson(path, e);
  }
}

const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 50;

export interface RenameDeps {
  rename: (from: string, to: string) => Promise<void>;
  platform: NodeJS.Platform;
  delayMs: number;
}

/** Rename; on Windows retries EPERM/EBUSY (a reader or antivirus holding the target) up to 5 times. */
export async function renameWithRetry(
  from: string,
  to: string,
  deps: RenameDeps = { rename: fsRename, platform: process.platform, delayMs: RENAME_RETRY_MS },
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const transient = deps.platform === "win32" && (code === "EPERM" || code === "EBUSY");
      if (!transient || attempt >= RENAME_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, deps.delayMs));
    }
  }
}

/** Writes `value` as 2-space-indented JSON plus a newline; readers see the old or the new file, never a partial one. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError(`writeJsonAtomic: value for ${path} is not JSON-serializable`);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(`${text}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
