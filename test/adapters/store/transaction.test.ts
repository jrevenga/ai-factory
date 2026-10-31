import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factoryPaths, type FactoryPaths } from "../../../src/adapters/platform/paths.ts";
import { beginTxn, clearTxn, readTxn, TxnPending } from "../../../src/adapters/store/transaction.ts";
import { isolatedEnv } from "../../helpers/isolated-env.ts";
import { makeTmp, type Tmp } from "../../helpers/tmp.ts";

let tmp: Tmp;
let paths: FactoryPaths;

beforeEach(async () => {
  tmp = await makeTmp("txn");
  paths = factoryPaths(isolatedEnv(tmp.dir));
});
afterEach(async () => {
  await tmp.cleanup();
});

const T = { id: "20261031T090807Z-0.1.0-to-0.2.0", kind: "update", from: "0.1.0", to: "0.2.0", snapshot: "20261031T090807Z-0.1.0-to-0.2.0" } as const;

describe("journal", () => {
  it("readTxn is undefined when no transaction is pending", async () => {
    expect(await readTxn(paths)).toBeUndefined();
  });

  it("beginTxn writes the journal with startedAt and readTxn returns it", async () => {
    await beginTxn(paths, { ...T, now: new Date("2026-10-31T09:08:07.000Z") });
    expect(await readTxn(paths)).toEqual({ ...T, startedAt: "2026-10-31T09:08:07.000Z" });
  });

  it("refuses a second beginTxn and keeps the first journal", async () => {
    await beginTxn(paths, T);
    const err = await beginTxn(paths, { ...T, id: "other", kind: "rollback" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxnPending);
    expect((err as TxnPending).existing?.id).toBe(T.id);
    expect((await readTxn(paths))?.id).toBe(T.id);
  });

  it("clearTxn removes the journal and is idempotent", async () => {
    await beginTxn(paths, T);
    await clearTxn(paths);
    expect(existsSync(paths.txn)).toBe(false);
    await expect(clearTxn(paths)).resolves.toBeUndefined();
    await beginTxn(paths, T);
    expect((await readTxn(paths))?.id).toBe(T.id);
  });
});
