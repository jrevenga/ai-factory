import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CredentialsInSourceUrl,
  hasEmbeddedCredentials,
  npmInstallSpec,
  packageRef,
  ReleaseManifest,
  effectiveSource,
  sourceOverride,
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
  it("an empty FACTORY_SOURCE counts as unset", () => {
    const env = { FACTORY_SOURCE: "" };
    expect(effectiveSource(m, env)).toBe("https://github.com/jrevenga/ai-factory.git");
    expect(packageRef(m, env)).toBe("git:https://github.com/jrevenga/ai-factory.git@v0.1.0");
    expect(npmInstallSpec(m, env)).toBe("git+https://github.com/jrevenga/ai-factory.git#v0.1.0");
    expect(sourceOverride(env)).toBeUndefined();
    expect(sourceOverride({ FACTORY_SOURCE: "http://127.0.0.1:9/x.git" })).toBe("http://127.0.0.1:9/x.git");
  });
});

describe("source URLs with embedded credentials (M3)", () => {
  it.each([
    ["https://user:s3cret@github.com/o/ai-factory.git", true],
    ["https://ghp_s3cret@github.com/o/ai-factory.git", true],
    ["HTTP://user@127.0.0.1:9/x.git", true],
    ["git+https://user:s3cret@github.com/o/ai-factory.git", true],
    ["ssh://git:s3cret@example.com/o/x.git", true],
    ["https://github.com/o/ai-factory.git", false],
    ["http://127.0.0.1:9/fixture/ai-factory.git", false],
    ["https://github.com/o/ai-factory.git@v0.1.0", false],
    ["git@github.com:o/ai-factory.git", false],
    ["ssh://git@github.com/o/ai-factory.git", false],
    ["file:///tmp/ai-factory.git", false],
  ])("%s → %s", (url, expected) => {
    expect(hasEmbeddedCredentials(url)).toBe(expected);
  });

  it("every source helper refuses FACTORY_SOURCE with credentials, without repeating them", () => {
    const env = { FACTORY_SOURCE: "https://user:s3cret@github.com/o/ai-factory.git" };
    for (const f of [effectiveSource, packageRef, npmInstallSpec]) {
      const e = (() => {
        try {
          f(m, env);
        } catch (x) {
          return x;
        }
        return undefined;
      })();
      expect(e).toBeInstanceOf(CredentialsInSourceUrl);
      expect((e as Error).message).toContain("FACTORY_SOURCE");
      expect((e as Error).message).toContain("credential helper");
      expect((e as Error).message).not.toContain("s3cret");
    }
  });
});
