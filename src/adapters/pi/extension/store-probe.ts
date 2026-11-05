// Writability probe for FACTORY_HOME, used by the startup handshake.
import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProbeFs {
  writeFile(path: string, data: string, opts: { flag: string }): Promise<void>;
  unlink(path: string): Promise<void>;
}

const NODE_FS: ProbeFs = { writeFile, unlink };

/**
 * Creating and deleting a probe file are one checked operation: either failing means the store is
 * not writable. A failed creation still attempts cleanup (the file may exist despite the error),
 * except on EEXIST, where the file is not ours.
 */
export async function storeWritable(home: string, fs: ProbeFs = NODE_FS): Promise<boolean> {
  const probe = join(home, `.handshake-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await fs.writeFile(probe, "", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") await fs.unlink(probe).catch(() => undefined);
    return false;
  }
  try {
    await fs.unlink(probe);
  } catch {
    return false;
  }
  return true;
}
