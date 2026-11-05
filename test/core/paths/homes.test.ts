import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expandHome, resolveFactoryHome, resolvePiAgentDir, withAbsoluteDirs } from "../../../src/core/paths/homes.ts";

const HOME = resolve("/users/a b");

describe("resolveFactoryHome / resolvePiAgentDir", () => {
  it("defaults to <home>/.factory and <home>/.pi/agent; empty values count as unset", () => {
    expect(resolveFactoryHome({}, HOME)).toBe(join(HOME, ".factory"));
    expect(resolveFactoryHome({ FACTORY_HOME: "" }, HOME)).toBe(join(HOME, ".factory"));
    expect(resolvePiAgentDir({}, HOME)).toBe(join(HOME, ".pi", "agent"));
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "" }, HOME)).toBe(join(HOME, ".pi", "agent"));
  });

  it("uses the variables when set, made absolute", () => {
    expect(resolveFactoryHome({ FACTORY_HOME: resolve("/x y/f") }, HOME)).toBe(resolve("/x y/f"));
    expect(resolveFactoryHome({ FACTORY_HOME: "rel dir" }, HOME)).toBe(resolve("rel dir"));
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: resolve("/p q") }, HOME)).toBe(resolve("/p q"));
  });

  it("expands a leading ~ against the given home", () => {
    expect(resolveFactoryHome({ FACTORY_HOME: "~/f h" }, HOME)).toBe(join(HOME, "f h"));
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "~" }, HOME)).toBe(HOME);
  });
});

describe("expandHome", () => {
  it("expands ~\\ only on Windows", () => {
    expect(expandHome("~\\x", HOME, "win32")).toBe(join(HOME, "x"));
    expect(expandHome("~\\x", HOME, "linux")).toBe(resolve("~\\x"));
  });

  it("leaves ~user and inner ~ alone", () => {
    expect(expandHome("~bob/x", HOME, "linux")).toBe(resolve("~bob/x"));
    expect(expandHome("/a/~/b", HOME, "linux")).toBe(resolve("/a/~/b"));
  });
});

describe("withAbsoluteDirs (I4)", () => {
  const CWD = resolve("/work dir");

  it("makes relative directory overrides absolute against the caller's directory and keeps everything else", () => {
    const env = { FACTORY_HOME: "factory", PI_CODING_AGENT_DIR: "agent", OTHER: "x" };
    expect(withAbsoluteDirs(env, HOME, CWD)).toEqual({ FACTORY_HOME: join(CWD, "factory"), PI_CODING_AGENT_DIR: join(CWD, "agent"), OTHER: "x" });
    expect(env.FACTORY_HOME).toBe("factory"); // the input is not changed
  });

  it("expands ~, keeps absolute values, and leaves unset or empty overrides alone", () => {
    expect(withAbsoluteDirs({ FACTORY_HOME: "~/f", PI_CODING_AGENT_DIR: resolve("/p") }, HOME, CWD)).toEqual({ FACTORY_HOME: join(HOME, "f"), PI_CODING_AGENT_DIR: resolve("/p") });
    expect(withAbsoluteDirs({ FACTORY_HOME: "" }, HOME, CWD)).toEqual({ FACTORY_HOME: "" });
    expect(withAbsoluteDirs({}, HOME, CWD)).toEqual({});
  });
});
