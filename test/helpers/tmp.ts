import { randomBytes } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export interface Tmp {
  dir: string;
  cleanup(): Promise<void>;
}

/** Creates `<tmpdir>/<prefix> <random>`; the path always contains a space. */
export async function makeTmp(prefix: string): Promise<Tmp> {
  if (prefix === "" || prefix === "." || prefix.includes("..") || /[\\/]/.test(prefix) || prefix.includes("\0")) {
    throw new Error(`makeTmp prefix must be a single path component: ${JSON.stringify(prefix)}`);
  }
  const dir = join(tmpdir(), `${prefix} ${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return {
    dir,
    async cleanup() {
      let real: string;
      try {
        real = await realpath(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      const rel = relative(await realpath(tmpdir()), real);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`refusing to remove a path outside ${tmpdir()}: ${dir} -> ${real}`);
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
