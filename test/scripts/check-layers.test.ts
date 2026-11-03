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

  it("extension non-relative imports other than node builtins and pi types -> extension-core-only", async () => {
    const root = await tree({
      "src/adapters/pi/extension/n.ts": 'import fs from "node:fs";\nimport { z } from "zod";\nimport type { T } from "@earendil-works/pi-ai";\nexport { fs, z };\nexport type U = T;\n',
    });
    const v = checkLayers(root);
    expect(v.map((x) => [x.rule, x.specifier])).toEqual([["extension-core-only", "zod"]]);
  });

  it("extension may value-import typebox and its subpaths (ruling 14); zod and look-alikes stay forbidden", async () => {
    const root = await tree({
      "src/adapters/pi/extension/tb.ts":
        'import { Type } from "typebox";\nimport { Value } from "typebox/value";\nimport { z } from "zod";\nimport t from "typebox-extra";\nexport { Type, Value, z, t };\n',
    });
    expect(checkLayers(root).map((x) => [x.rule, x.specifier])).toEqual([
      ["extension-core-only", "zod"],
      ["extension-core-only", "typebox-extra"],
    ]);
  });

  it("extension may import node builtins, prefixed or bare (ruling R6)", async () => {
    const root = await tree({
      "src/adapters/pi/extension/b.ts":
        'import { readFile } from "node:fs/promises";\nimport { join } from "path";\nimport os from "os";\nimport { pathToFileURL } from "node:url";\nexport { readFile, join, os, pathToFileURL };\n',
    });
    expect(checkLayers(root)).toEqual([]);
  });

  it("extension importing a non-builtin package that shadows a builtin-like name stays a violation", async () => {
    const root = await tree({ "src/adapters/pi/extension/p.ts": 'import x from "fs-extra";\nimport y from "node-fetch";\nexport { x, y };\n' });
    expect(checkLayers(root).map((x) => [x.rule, x.specifier])).toEqual([
      ["extension-core-only", "fs-extra"],
      ["extension-core-only", "node-fetch"],
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

  it("regex literal containing import(...) after a statement head -> no violation", async () => {
    const root = await tree({ "src/core/r.ts": 'if (true) /import("node:fs")/.test("");\n' });
    expect(checkLayers(root)).toEqual([]);
  });

  it("import() inside a template substitution -> violation", async () => {
    const root = await tree({ "src/core/u.ts": 'export const text = `${import("node:fs")}`;\n' });
    expect(checkLayers(root).map((x) => x.rule)).toEqual(["core-no-io-builtins"]);
  });

  it("import() after postfix increment and division is still found", async () => {
    const root = await tree({ "src/core/p.ts": 'let n = 1; n++ / 2; export const m = import("node:fs");\n' });
    expect(checkLayers(root).map((x) => x.rule)).toEqual(["core-no-io-builtins"]);
  });

  it("specifier-level type imports are value imports; syntax error names the file", async () => {
    const ext = await tree({
      "src/adapters/pi/extension/t.ts": 'import { type A } from "@earendil-works/pi-ai";\nexport { type B } from "@earendil-works/pi-ai";\nexport type X = A;\n',
    });
    expect(checkLayers(ext).map((x) => [x.rule, x.line])).toEqual([
      ["pi-import-type-only", 1],
      ["pi-import-type-only", 2],
    ]);
    const bad = await tree({ "src/core/z.ts": "import {{{ nope\n" });
    expect(() => checkLayers(bad)).toThrow(/cannot parse src\/core\/z\.ts/);
  });

  it("import() types are type-only dependencies that still obey layers", async () => {
    const root = await tree({ "src/core/it.ts": 'export type X = import("../adapters/x.ts").X;\n' });
    expect(checkLayers(root).map((x) => x.rule)).toEqual(["core-no-adapters"]);
    const ext = await tree({ "src/adapters/pi/extension/it.ts": 'export type Y = import("@earendil-works/pi-ai").Y;\n' });
    expect(checkLayers(ext)).toEqual([]);
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
