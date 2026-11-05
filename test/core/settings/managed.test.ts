import { describe, expect, it } from "vitest";
import { DESIRED_PI_SETTINGS, planManagedSettings, type ManagedRecord } from "../../../src/core/settings/managed.ts";

const ctx = { now: "2026-10-31T00:00:00.000Z", factoryVersion: "0.1.0" };
const empty: ManagedRecord = { schema: 1, keys: {} };
const rec = (keys: Record<string, unknown>): ManagedRecord => ({
  schema: 1,
  keys: Object.fromEntries(Object.entries(keys).map(([k, value]) => [k, { value, writtenAt: "old", factoryVersion: "0.0.9" }])),
});
const actions = (cs: { key: string; action: string }[]) => Object.fromEntries(cs.map((c) => [c.key, c.action]));

describe("planManagedSettings", () => {
  it("desired values are the telemetry/transport defaults", () => {
    expect(DESIRED_PI_SETTINGS).toEqual({ enableInstallTelemetry: false, transport: "sse" });
  });

  it("sets and records both keys on empty settings", () => {
    const r = planManagedSettings({}, empty, DESIRED_PI_SETTINGS, ctx);
    expect(r.next).toEqual({ enableInstallTelemetry: false, transport: "sse" });
    expect(actions(r.changes)).toEqual({ enableInstallTelemetry: "set", transport: "set" });
    expect(r.record.keys.transport).toEqual({ value: "sse", writtenAt: ctx.now, factoryVersion: "0.1.0" });
  });

  it("does not mutate its inputs", () => {
    const current = { a: 1 };
    planManagedSettings(current, empty, DESIRED_PI_SETTINGS, ctx);
    expect(current).toEqual({ a: 1 });
    expect(empty.keys).toEqual({});
  });

  it("is unchanged when current equals recorded equals desired", () => {
    const cur = { enableInstallTelemetry: false, transport: "sse" };
    const r = planManagedSettings(cur, rec(cur), DESIRED_PI_SETTINGS, ctx);
    expect(actions(r.changes)).toEqual({ enableInstallTelemetry: "unchanged", transport: "unchanged" });
    expect(r.next).toEqual(cur);
    expect(r.record.keys.transport?.writtenAt).toBe("old");
  });

  it("keeps a value the user changed after the factory wrote it", () => {
    const r = planManagedSettings({ enableInstallTelemetry: false, transport: "websocket" }, rec({ enableInstallTelemetry: false, transport: "sse" }), DESIRED_PI_SETTINGS, ctx);
    expect(actions(r.changes).transport).toBe("kept-user-value");
    expect(r.next.transport).toBe("websocket");
    expect(r.record.keys.transport?.value).toBe("sse");
  });

  it("treats a user-deleted recorded key as user-owned", () => {
    const r = planManagedSettings({}, rec({ transport: "sse" }), { transport: "sse" }, ctx);
    expect(actions(r.changes).transport).toBe("kept-user-value");
    expect("transport" in r.next).toBe(false);
  });

  it("leaves a pre-existing foreign value alone and unrecorded", () => {
    const r = planManagedSettings({ transport: "auto" }, empty, DESIRED_PI_SETTINGS, ctx);
    expect(actions(r.changes)).toEqual({ enableInstallTelemetry: "set", transport: "kept-foreign-value" });
    expect(r.next.transport).toBe("auto");
    expect(r.record.keys.transport).toBeUndefined();
  });

  it("updates a still-owned key whose desired value changed (deep equality)", () => {
    const r = planManagedSettings({ x: { a: [1, { b: 2 }] } }, rec({ x: { a: [1, { b: 2 }] } }), { x: { a: [1, { b: 3 }] } }, ctx);
    expect(actions(r.changes).x).toBe("updated");
    expect(r.next.x).toEqual({ a: [1, { b: 3 }] });
    expect(r.record.keys.x).toEqual({ value: { a: [1, { b: 3 }] }, writtenAt: ctx.now, factoryVersion: "0.1.0" });
  });

  it("releases a key no longer desired while it is still the recorded value", () => {
    const r = planManagedSettings({ enableInstallTelemetry: false, transport: "sse" }, rec({ enableInstallTelemetry: false, transport: "sse" }), { enableInstallTelemetry: false }, ctx);
    expect(actions(r.changes)).toEqual({ enableInstallTelemetry: "unchanged", transport: "released" });
    expect("transport" in r.next).toBe(false);
    expect(r.record.keys.transport).toBeUndefined();
  });

  it("keeps a no-longer-desired key the user changed", () => {
    const r = planManagedSettings({ transport: "websocket" }, rec({ transport: "sse" }), {}, ctx);
    expect(actions(r.changes).transport).toBe("kept-user-value");
    expect(r.next.transport).toBe("websocket");
  });

  it("passes unknown keys through and ignores keys neither desired nor recorded", () => {
    const packages = ["git:x@v1", { source: "npm:y" }];
    const r = planManagedSettings({ packages, theme: "dark" }, empty, DESIRED_PI_SETTINGS, ctx);
    expect(r.next.packages).toEqual(packages);
    expect(r.next.theme).toBe("dark");
    expect(r.changes.map((c) => c.key).sort()).toEqual(["enableInstallTelemetry", "transport"]);
  });

  it("preserves unknown metadata on a record entry when updating it", () => {
    const record = { schema: 1 as const, keys: { x: { value: 1, writtenAt: "old", factoryVersion: "0.0.9", note: "keep" } } };
    const r = planManagedSettings({ x: 1 }, record, { x: 2 }, ctx);
    expect(r.record.keys.x).toEqual({ value: 2, writtenAt: ctx.now, factoryVersion: "0.1.0", note: "keep" });
  });
});
