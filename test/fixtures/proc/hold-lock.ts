// Test fixture: acquires the factory lock (FACTORY_HOME from the environment) with the given stale/update
// tuning, prints "held" and keeps refreshing it until killed.
// usage: node --import jiti/register hold-lock.ts <staleMs> <updateMs>
import { factoryPaths } from "../../../src/adapters/platform/paths.ts";
import { acquireLock } from "../../../src/adapters/store/lock.ts";

const stale = Number(process.argv[2] ?? "10000");
const update = Number(process.argv[3] ?? "5000");
await acquireLock(factoryPaths(), {}, { stale, update });
process.stdout.write("held\n");
setInterval(() => {}, 1_000);
