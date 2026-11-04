// Test fixture: a factory process that lends its lock (R17). It takes the factory lock (FACTORY_HOME from
// the environment, fast heartbeat), starts a transaction journal, runs borrower.ts through the CLI's
// supervised hand-over runner (with the lock's writer-group registry), then reports whether the
// borrower's installer is still alive and releases the lock, printing each step.
// usage: node --import jiti/register lender.ts <borrowerMode>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { factoryPaths } from "../../../src/adapters/platform/paths.ts";
import { acquireLock, isPidAlive, writerGroupsPath } from "../../../src/adapters/store/lock.ts";
import { beginTxn } from "../../../src/adapters/store/transaction.ts";
import { runNodeInherited } from "../../../src/cli/commands/install.ts";

const paths = factoryPaths();
const lock = await acquireLock(paths, {}, { stale: 2000, update: 1000 });
await beginTxn(paths, { id: "lender-txn", kind: "update", from: "0.0.9", to: "0.1.0", snapshot: "lender-txn" });
const borrower = fileURLToPath(new URL("./borrower.ts", import.meta.url));
const code = await runNodeInherited(["--import", "jiti/register", borrower, String(process.pid), process.argv[2] ?? "honor-abort"], process.env, {
  writerGroups: writerGroupsPath(paths),
});
process.stdout.write(`lender: child exited ${code}\n`);
const installerPid = join(paths.home, "installer.pid");
if (existsSync(installerPid)) process.stdout.write(`lender: installer alive=${isPidAlive(Number(readFileSync(installerPid, "utf8")))}\n`);
await lock.release();
process.stdout.write("lender: released\n");
process.exitCode = code;
