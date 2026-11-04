// Test fixture: a factory process that lends its lock (R17). It takes the factory lock (FACTORY_HOME from
// the environment, fast heartbeat), starts a transaction journal, runs borrower.ts through the CLI's
// supervised hand-over runner, then releases the lock, printing each step.
// usage: node --import jiti/register lender.ts <borrowerMode>
import { fileURLToPath } from "node:url";
import { factoryPaths } from "../../../src/adapters/platform/paths.ts";
import { acquireLock } from "../../../src/adapters/store/lock.ts";
import { beginTxn } from "../../../src/adapters/store/transaction.ts";
import { runNodeInherited } from "../../../src/cli/commands/install.ts";

const paths = factoryPaths();
const lock = await acquireLock(paths, {}, { stale: 2000, update: 1000 });
await beginTxn(paths, { id: "lender-txn", kind: "update", from: "0.0.9", to: "0.1.0", snapshot: "lender-txn" });
const borrower = fileURLToPath(new URL("./borrower.ts", import.meta.url));
const code = await runNodeInherited(["--import", "jiti/register", borrower, String(process.pid), process.argv[2] ?? "honor-abort"], process.env);
process.stdout.write(`lender: child exited ${code}\n`);
await lock.release();
process.stdout.write("lender: released\n");
process.exitCode = code;
