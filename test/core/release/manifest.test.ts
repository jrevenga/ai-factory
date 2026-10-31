import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  npmInstallSpec,
  packageRef,
  ReleaseManifest,
  effectiveSource,
  tagFor,
} from "../../../src/core/release/manifest.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const m = ReleaseManifest.parse(JSON.parse(readFileSync(resolve(root, "release.json"), "utf8")));

describe("release manifest", () => {
  it("builds refs from the production source", () => {
    expect(packageRef(m, {})).toBe("git:https://github.com/jrevenga/ai-factory.git@v0.1.0");
    expect(npmInstallSpec(m, {})).toBe("git+https://github.com/jrevenga/ai-factory.git#v0.1.0");
    expect(tagFor("1.2.3")).toBe("v1.2.3");
  });
  it("FACTORY_SOURCE overrides everywhere", () => {
    const env = { FACTORY_SOURCE: "http://127.0.0.1:9/fixture/ai-factory.git" };
    expect(effectiveSource(m, env)).toBe(env.FACTORY_SOURCE);
    expect(packageRef(m, env)).toBe(`git:${env.FACTORY_SOURCE}@v0.1.0`);
    expect(npmInstallSpec(m, env)).toBe(`git+${env.FACTORY_SOURCE}#v0.1.0`);
  });
});
