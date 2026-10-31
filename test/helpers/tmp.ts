import { randomBytes } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

export interface Tmp {
  dir: string;
  cleanup(): Promise<void>;
}

/** Creates `<tmpdir>/<prefix> <random>`; the path always contains a space. */
export async function makeTmp(prefix: string): Promise<Tmp> {
  const base = tmpdir();
  const dir = join(base, `${prefix} ${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return {
    dir,
    async cleanup() {
      const rel = relative(await realpath(base), await realpath(dir).catch(() => dir));
      const relRaw = relative(base, dir);
      const inside = (r: string) => r !== "" && !r.startsWith("..") && !isAbsolute(r);
      if (!inside(rel) && !inside(relRaw)) {
        throw new Error(`refusing to remove a path outside ${base}: ${dir}`);
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
