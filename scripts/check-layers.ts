// Layer lint: enforces the import rules between core / adapters / cli / extension.
// Run via `npm run lint` (through jiti, no build step) or import `checkLayers` in tests.
import { parse } from "@babel/parser";
import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface LayerViolation {
  file: string;
  line: number;
  specifier: string;
  rule: string;
}

const SCAN_DIRS = ["src", "guard", "scripts", "bin"];
const SCAN_EXT = /\.(ts|mjs)$/;
const IO_BUILTINS = new Set(["fs", "fs/promises", "child_process", "os", "net", "http"]);
const PI_SCOPE = "@earendil-works/";
/** Ruling 14: host-provided by Pi (docs/packages.md); the extension value-imports it for tool parameter schemas. */
const EXTENSION_HOST_PACKAGES = ["typebox"];

function isHostPackage(spec: string): boolean {
  return EXTENSION_HOST_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));
}

type Zone = "core" | "extension" | "adapters" | "cli" | "guard" | "other";

function zoneOf(rel: string): Zone {
  if (rel.startsWith("src/core/")) return "core";
  if (rel.startsWith("src/adapters/pi/extension/")) return "extension";
  if (rel.startsWith("src/adapters/")) return "adapters";
  if (rel.startsWith("src/cli/")) return "cli";
  if (rel.startsWith("guard/")) return "guard";
  return "other";
}

function listFiles(dir: string, out: string[], optional: boolean): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`cannot read directory ${dir}: ${(e as Error).message}`, { cause: e });
  }
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out, false);
    else if (SCAN_EXT.test(e.name)) out.push(p);
  }
}

interface Ref {
  specifier: string;
  line: number;
  typeOnly: boolean;
}

type Node = { type: string; loc?: { start: { line: number } }; [key: string]: unknown };

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

function staticString(n: unknown): string | undefined {
  if (!isNode(n)) return undefined;
  if (n.type === "StringLiteral") return n.value as string;
  if (n.type === "TemplateLiteral") {
    const quasis = n.quasis as Array<{ value: { cooked?: string | null } }>;
    if ((n.expressions as unknown[]).length === 0 && quasis.length === 1) return quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function findRefs(src: string, file: string): Ref[] {
  let ast: Node;
  try {
    ast = parse(src, { sourceType: "module", plugins: ["typescript"] }) as unknown as Node;
  } catch (e) {
    throw new Error(`cannot parse ${file}: ${(e as Error).message}`, { cause: e });
  }
  const refs: Ref[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const c of node) visit(c);
      return;
    }
    if (!isNode(node)) return;
    const line = node.loc?.start.line ?? 0;
    const add = (specifier: string | undefined, typeOnly: boolean) => {
      if (specifier !== undefined) refs.push({ specifier, line, typeOnly });
    };
    switch (node.type) {
      case "ImportDeclaration":
        add(staticString(node.source), node.importKind === "type");
        break;
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source) {
          add(staticString(node.source), node.exportKind === "type");
        }
        break;
      case "TSImportType":
        add(staticString(node.source), true);
        break;
      case "ImportExpression":
        add(staticString(node.source), false);
        break;
      case "CallExpression": {
        const callee = node.callee;
        if (isNode(callee) && callee.type === "Import") add(staticString((node.arguments as unknown[])[0]), false);
        break;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
      visit(node[key]);
    }
  };
  visit(ast);
  return refs;
}

export function checkLayers(root: string): LayerViolation[] {
  const absRoot = resolve(root);
  const files: string[] = [];
  for (const d of SCAN_DIRS) listFiles(join(absRoot, d), files, true);
  files.sort();

  const violations: LayerViolation[] = [];
  for (const abs of files) {
    const rel = relative(absRoot, abs).split(sep).join("/");
    const zone = zoneOf(rel);
    for (const ref of findRefs(readFileSync(abs, "utf8"), rel)) {
      const add = (rule: string) => violations.push({ file: rel, line: ref.line, specifier: ref.specifier, rule });
      const spec = ref.specifier;
      const isRelative = spec.startsWith("./") || spec.startsWith("../");
      if (isRelative) {
        const target = posix.normalize(posix.join(posix.dirname(rel), spec));
        const tz = zoneOf(target);
        if (zone === "core" && tz === "adapters") add("core-no-adapters");
        else if (zone === "core" && tz === "extension") add("core-no-adapters");
        else if (zone === "core" && tz === "cli") add("core-no-cli");
        if ((zone === "adapters" || zone === "extension") && tz === "cli") add("adapters-no-cli");
        if (tz === "extension" && zone !== "extension") add("no-import-extension");
        if (zone === "extension" && tz !== "core" && tz !== "extension") add("extension-core-only");
        continue;
      }
      // Ruling R6: the extension runs inside Pi and needs Node builtins (fs/path/os) for the handshake.
      if (zone === "extension" && isBuiltin(spec)) continue;
      if (zone === "extension" && isHostPackage(spec)) continue;
      if (zone === "extension" && !spec.startsWith(PI_SCOPE)) {
        add("extension-core-only");
        continue;
      }
      const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
      if (zone === "core" && IO_BUILTINS.has(bare)) {
        add("core-no-io-builtins");
        continue;
      }
      if (spec.startsWith(PI_SCOPE)) {
        if (zone === "core") add("core-no-pi");
        else if (zone !== "extension" && zone !== "guard") add("pi-import-type-only");
        else if (!ref.typeOnly) add("pi-import-type-only");
      }
    }
  }
  return violations;
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = checkLayers(root);
  for (const v of violations) {
    console.error(`${v.file}:${v.line}  ${v.rule}  ("${v.specifier}")`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} layer violation(s).`);
    process.exit(1);
  }
  console.log("layers: ok");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
