import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkLayers } from "../../scripts/check-layers.ts";
import { makeTmp } from "../helpers/tmp.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tree(files: Record<string, string>): Promise<string> {
  const t = await makeTmp("layers");
  cleanups.push(t.cleanup);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(t.dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return t.dir;
}

describe("checkLayers", () => {
  it("core importing adapters -> core-no-adapters at line 1", async () => {
    const root = await tree({ "src/core/a.ts": 'import { x } from "../adapters/x.ts";\nexport const a = x;\n' });
    const v = checkLayers(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "core-no-adapters", line: 1, specifier: "../adapters/x.ts" });
    expect(v[0]?.file).toContain("a.ts");
  });

  it("core importing node:fs -> core-no-io-builtins", async () => {
    const root = await tree({ "src/core/b.ts": 'import fs from "node:fs";\nexport default fs;\n' });
    expect(checkLayers(root).map((x) => x.rule)).toEqual(["core-no-io-builtins"]);
  });

  it("core importing cli and pi -> core-no-cli, core-no-pi", async () => {
    const root = await tree({
      "src/core/c.ts": 'export * from "../cli/main.ts";\nconst m = import("@earendil-works/pi-ai");\n',
    });
    expect(checkLayers(root).map((x) => x.rule).sort()).toEqual(["core-no-cli", "core-no-pi"]);
  });

  it("adapters importing cli -> adapters-no-cli", async () => {
    const root = await tree({ "src/adapters/store/s.ts": 'import { m } from "../../cli/main.ts";\nexport { m };\n' });
    expect(checkLayers(root).map((x) => x.rule)).toEqual(["adapters-no-cli"]);
  });

  it("extension value import of pi -> pi-import-type-only; import type is fine", async () => {
    const root = await tree({
      "src/adapters/pi/extension/c.ts": 'import { Foo } from "@earendil-works/pi-coding-agent";\nexport { Foo };\n',
      "src/adapters/pi/extension/ok.ts": 'import type { Foo } from "@earendil-works/pi-coding-agent";\nexport type X = Foo;\n',
    });
    const v = checkLayers(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: "pi-import-type-only", line: 1 });
    expect(v[0]?.file).toContain("c.ts");
  });

  it("extension importing outside core/itself -> extension-core-only", async () => {
    const root = await tree({ "src/adapters/pi/extension/d.ts": 'import { r } from "../runtime.ts";\nexport { r };\n' });
    expect(checkLayers(root).map((x) => x.rule)).toEqual(["extension-core-only"]);
  });

  it("cli importing the extension -> no-import-extension", async () => {
    const root = await tree({ "src/cli/e.ts": 'import "../adapters/pi/extension/index.ts";\n' });
    expect(checkLayers(root).map((x) => x.rule)).toEqual(["no-import-extension"]);
  });

  it("cli importing adapters/pi/runtime.ts -> no violation", async () => {
    const root = await tree({ "src/cli/f.ts": 'import { r } from "../adapters/pi/runtime.ts";\nexport { r };\n' });
    expect(checkLayers(root)).toEqual([]);
  });

  it("guard value-importing pi is a violation, import type is fine", async () => {
    const root = await tree({
      "guard/g.ts": 'import { a } from "@earendil-works/pi-ai";\nexport { a };\n',
      "guard/h.ts": 'import type { a } from "@earendil-works/pi-ai";\nexport type T = a;\n',
    });
    const v = checkLayers(root);
    expect(v.map((x) => x.rule)).toEqual(["pi-import-type-only"]);
  });

  it("scripts importing pi is a violation", async () => {
    const root = await tree({ "scripts/s.ts": 'import type { a } from "@earendil-works/pi-ai";\n' });
    expect(checkLayers(root).map((x) => x.rule)).toEqual(["pi-import-type-only"]);
  });

  it("extension non-relative imports other than pi types -> extension-core-only", async () => {
    const root = await tree({
      "src/adapters/pi/extension/n.ts": 'import fs from "node:fs";\nimport { z } from "zod";\nimport type { T } from "@earendil-works/pi-ai";\nexport { fs, z };\nexport type U = T;\n',
    });
    const v = checkLayers(root);
    expect(v.map((x) => [x.rule, x.specifier])).toEqual([
      ["extension-core-only", "node:fs"],
      ["extension-core-only", "zod"],
    ]);
  });

  it("dynamic template-literal import of node:fs in core -> violation", async () => {
    const root = await tree({ "src/core/t.ts": "export const m = import(`node:fs`);\n" });
    expect(checkLayers(root).map((x) => x.rule)).toEqual(["core-no-io-builtins"]);
  });

  it("import text inside strings, templates and comments -> no violation", async () => {
    const root = await tree({
      "src/core/s.ts": [
        "const a = \"import('node:fs')\";",
        "const b = `import fs from 'node:fs' ${1 + 1}`;",
        "// import fs from 'node:fs';",
        "/* import('node:os') */",
        "const c = /import\\('x'\\)/;",
        "const d = { import: 1 }.import;",
        "export { a, b, c, d };",
        "",
      ].join("\n"),
    });
    expect(checkLayers(root)).toEqual([]);
  });

  it("multi-line imports, import type and export-from are classified correctly", async () => {
    const root = await tree({
      "src/core/m.ts": 'import {\n  a,\n  b,\n} from\n  "../adapters/x.ts";\nimport type { T } from "../cli/y.ts";\nexport type { U } from "../cli/z.ts";\nexport { a, b };\n',
    });
    const v = checkLayers(root);
    expect(v.map((x) => [x.rule, x.line])).toEqual([
      ["core-no-adapters", 1],
      ["core-no-cli", 6],
      ["core-no-cli", 7],
    ]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable source directory fails the scan with its path", async () => {
    const root = await tree({ "src/core/ok.ts": "export {};\n" });
    chmodSync(join(root, "src"), 0o000);
    try {
      expect(() => checkLayers(root)).toThrow(/src/);
    } finally {
      chmodSync(join(root, "src"), 0o755);
    }
  });

  it("the real repository has no violations", () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    expect(checkLayers(repo)).toEqual([]);
  });
});
