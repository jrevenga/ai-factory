import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryPaths } from "../../../src/adapters/platform/paths.ts";

describe("factoryPaths", () => {
  it("derives every path from FACTORY_HOME and PI_CODING_AGENT_DIR", () => {
    const home = resolve("/a b");
    const agent = resolve("/c d");
    expect(factoryPaths({ FACTORY_HOME: "/a b", PI_CODING_AGENT_DIR: "/c d" })).toEqual({
      home,
      config: join(home, "config.json"),
      state: join(home, "state.json"),
      managedSettings: join(home, "managed-settings.json"),
      memoryDb: join(home, "memory.db"),
      backups: join(home, "backups"),
      sessions: join(home, "sessions"),
      lock: join(home, "factory.lock"),
      txn: join(home, "txn.json"),
      piPrefixes: join(home, "pi"),
      piAgentDir: agent,
      piSettings: join(agent, "settings.json"),
      piExtensions: join(agent, "extensions"),
    });
  });

  it("defaults to ~/.factory and ~/.pi/agent (empty values count as unset)", () => {
    const p = factoryPaths({ FACTORY_HOME: "", PI_CODING_AGENT_DIR: "" });
    expect(p.home).toBe(join(homedir(), ".factory"));
    expect(p.piAgentDir).toBe(join(homedir(), ".pi", "agent"));
  });

  it("expands a leading ~ like Pi does", () => {
    const p = factoryPaths({ FACTORY_HOME: "~/f h", PI_CODING_AGENT_DIR: "~" });
    expect(p.home).toBe(join(homedir(), "f h"));
    expect(p.piAgentDir).toBe(homedir());
  });
});
