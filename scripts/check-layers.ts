// Layer lint: enforces the import rules between core / adapters / cli / extension.
// Run via `npm run lint` (through jiti, no build step) or import `checkLayers` in tests.
import { readdirSync, readFileSync } from "node:fs";
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

type Zone = "core" | "extension" | "adapters" | "cli" | "guard" | "other";

function zoneOf(rel: string): Zone {
  if (rel.startsWith("src/core/")) return "core";
  if (rel.startsWith("src/adapters/pi/extension/")) return "extension";
  if (rel.startsWith("src/adapters/")) return "adapters";
  if (rel.startsWith("src/cli/")) return "cli";
  if (rel.startsWith("guard/")) return "guard";
  return "other";
}

function listFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else if (SCAN_EXT.test(e.name)) out.push(p);
  }
}

// Replace comments with spaces (keeping newlines) while leaving string literals intact.
function maskComments(src: string): string {
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/g;
  return src.replace(re, (m) => (m.startsWith("//") || m.startsWith("/*") ? m.replace(/[^\n]/g, " ") : m));
}

interface Ref {
  specifier: string;
  line: number;
  typeOnly: boolean;
}

function findRefs(src: string): Ref[] {
  const text = maskComments(src);
  const refs: Ref[] = [];
  const lineAt = (idx: number) => text.slice(0, idx).split("\n").length;
  // import "x" | import ... from "x" | export ... from "x"
  const stat = /\b(import|export)\b(\s+type\b)?([^;"'`]*?\bfrom\s*|\s*)(["'])((?:\\.|(?!\4)[^\\\n])+)\4/g;
  for (let m; (m = stat.exec(text)); ) {
    const kw = m[1];
    const between = m[3] ?? "";
    if (kw === "export" && !/\bfrom\s*$/.test(between)) continue;
    if (kw === "import" && between.trim() === "" && m[2]) continue;
    refs.push({ specifier: m[5] ?? "", line: lineAt(m.index), typeOnly: Boolean(m[2]) });
  }
  const dyn = /\bimport\s*\(\s*(["'])((?:\\.|(?!\1)[^\\\n])+)\1\s*\)/g;
  for (let m; (m = dyn.exec(text)); ) {
    refs.push({ specifier: m[2] ?? "", line: lineAt(m.index), typeOnly: false });
  }
  return refs;
}

export function checkLayers(root: string): LayerViolation[] {
  const absRoot = resolve(root);
  const files: string[] = [];
  for (const d of SCAN_DIRS) listFiles(join(absRoot, d), files);
  files.sort();

  const violations: LayerViolation[] = [];
  for (const abs of files) {
    const rel = relative(absRoot, abs).split(sep).join("/");
    const zone = zoneOf(rel);
    for (const ref of findRefs(readFileSync(abs, "utf8"))) {
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
