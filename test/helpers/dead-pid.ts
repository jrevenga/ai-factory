import { spawn } from "node:child_process";
import { isPidAlive } from "../../src/adapters/store/lock.ts";

/** Pid of a child this test spawned and awaited, so it is known to be dead (re-checked before returning). */
export async function deadPid(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    if (pid !== undefined && !isPidAlive(pid)) return pid;
  }
  throw new Error("could not obtain a dead pid");
}
