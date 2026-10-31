import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCommand, piPrintEnv, TEST_PI_VERSION } from "./pi-harness.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const AGENT = join("/tmp", "run 1", "pi agent");

describe("piPrintEnv", () => {
  it("without env: isolated FACTORY_HOME next to the agent dir, host FACTORY_HOME ignored", () => {
    vi.stubEnv("FACTORY_HOME", join(homedir(), ".factory"));
    const env = piPrintEnv(AGENT);
    expect(env.FACTORY_HOME).toBe(join("/tmp", "run 1", "factory home"));
    expect(env.PI_CODING_AGENT_DIR).toBe(AGENT);
    expect(env.PI_OFFLINE).toBe("1");
    expect(env.PI_TELEMETRY).toBe("0");
  });

  it("env without FACTORY_HOME gets the isolated default; a given FACTORY_HOME is kept", () => {
    expect(piPrintEnv(AGENT, { PATH: "/bin" }).FACTORY_HOME).toBe(join("/tmp", "run 1", "factory home"));
    expect(piPrintEnv(AGENT, { FACTORY_HOME: "/x y" }).FACTORY_HOME).toBe("/x y");
  });

  it("collapses casing variants of the isolated keys to one canonical key", () => {
    const env = piPrintEnv(AGENT, { factory_home: "/lower case", pi_coding_agent_dir: "/other" });
    expect(env.FACTORY_HOME).toBe("/lower case");
    expect(env.PI_CODING_AGENT_DIR).toBe(AGENT);
    expect(Object.keys(env).filter((k) => /^(factory_home|pi_coding_agent_dir)$/i.test(k)).sort()).toEqual(["FACTORY_HOME", "PI_CODING_AGENT_DIR"]);
  });

  it("refuses the real default factory home and Pi agent dir", () => {
    expect(() => piPrintEnv(AGENT, { FACTORY_HOME: join(homedir(), ".factory") })).toThrow(/real/);
    expect(() => piPrintEnv(AGENT, { FACTORY_HOME: "~/.factory" })).toThrow(/real/);
    expect(() => piPrintEnv(join(homedir(), ".pi", "agent"), { FACTORY_HOME: "/x y" })).toThrow(/real/);
  });
});

describe("installCommand", () => {
  it("installs the pinned Pi into the staging prefix without scripts", () => {
    const { args } = installCommand("/c/staging 1", "/t/env dir", {});
    expect(args).toEqual(expect.arrayContaining(["install", "--prefix", "/c/staging 1", "--ignore-scripts", `@earendil-works/pi-coding-agent@${TEST_PI_VERSION}`]));
  });

  it("isolates npm and factory state under envDir and drops inherited casing variants", () => {
    const { env } = installCommand("/c/staging 1", "/t/env dir", {
      PATH: "/bin",
      NPM_CONFIG_CACHE: "/home/me/.npm",
      Npm_Config_Prefix: "/home/me/.local",
      FACTORY_HOME: join(homedir(), ".factory"),
      PI_CODING_AGENT_DIR: join(homedir(), ".pi", "agent"),
    });
    expect(env.PATH).toBe("/bin");
    expect(env.npm_config_cache).toBe(join("/t/env dir", "npm cache"));
    expect(env.npm_config_prefix).toBe(join("/t/env dir", "npm prefix"));
    expect(env.FACTORY_HOME).toBe(join("/t/env dir", "factory home"));
    expect(env.PI_CODING_AGENT_DIR).toBe(join("/t/env dir", "pi agent"));
    expect(env.NPM_CONFIG_CACHE).toBeUndefined();
    expect(env.Npm_Config_Prefix).toBeUndefined();
  });
});
