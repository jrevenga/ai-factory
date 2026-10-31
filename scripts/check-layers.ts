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

interface Tok {
  kind: "word" | "str" | "punct";
  text: string; // word text, string value (null-ish "" when not static), or punctuation char
  line: number;
  static: boolean; // for str: false for template literals with substitutions
}

// Minimal lexer: skips comments, keeps string/template literal values, skips regex literals.
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const isWordStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);

  // Skips a template body starting after the opening backtick; returns value and whether static.
  const readTemplate = (): { value: string; isStatic: boolean } => {
    let value = "";
    let isStatic = true;
    while (i < n && src[i] !== "`") {
      const c = src[i] as string;
      if (c === "\\") {
        value += src[i + 1] ?? "";
        if (src[i + 1] === "\n") line++;
        i += 2;
      } else if (c === "$" && src[i + 1] === "{") {
        isStatic = false;
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const d = src[i] as string;
          if (d === "\n") line++;
          if (d === "`") {
            i++;
            readTemplate();
            i++;
            continue;
          }
          if (d === '"' || d === "'") {
            i = skipString(d);
            continue;
          }
          if (d === "{") depth++;
          else if (d === "}") depth--;
          i++;
        }
      } else {
        if (c === "\n") line++;
        value += c;
        i++;
      }
    }
    return { value, isStatic };
  };
  const skipString = (q: string): number => {
    let j = i + 1;
    while (j < n && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  };

  while (i < n) {
    const c = src[i] as string;
    if (c === "\n") {
      line++;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === "\n") line++;
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") {
          value += src[j + 1] ?? "";
          j += 2;
        } else value += src[j++];
      }
      toks.push({ kind: "str", text: value, line, static: true });
      i = j + 1;
    } else if (c === "`") {
      const startLine = line;
      i++;
      const t = readTemplate();
      i++;
      toks.push({ kind: "str", text: t.value, line: startLine, static: t.isStatic });
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWord(src[j] as string)) j++;
      toks.push({ kind: "word", text: src.slice(i, j), line, static: true });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j] as string)) j++;
      toks.push({ kind: "word", text: src.slice(i, j), line, static: true });
      i = j;
    } else if (c === "/" && regexAllowed(toks)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const d = src[j] as string;
        if (d === "\\") j++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      i = j + 1;
      toks.push({ kind: "word", text: "/regex/", line, static: true });
    } else {
      toks.push({ kind: "punct", text: c, line, static: true });
      i++;
    }
  }
  return toks;
}

function regexAllowed(toks: Tok[]): boolean {
  const prev = toks[toks.length - 1];
  if (!prev) return true;
  if (prev.kind === "str") return false;
  if (prev.kind === "word") return ["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new"].includes(prev.text);
  return ![")", "]", "}"].includes(prev.text);
}

interface Ref {
  specifier: string;
  line: number;
  typeOnly: boolean;
}

function findRefs(src: string): Ref[] {
  const t = tokenize(src);
  const refs: Ref[] = [];
  const word = (k: number, w: string) => t[k]?.kind === "word" && t[k]?.text === w;
  const punct = (k: number, p: string) => t[k]?.kind === "punct" && t[k]?.text === p;
  const str = (k: number) => (t[k]?.kind === "str" ? t[k] : undefined);
  for (let k = 0; k < t.length; k++) {
    const tok = t[k] as Tok;
    if (tok.kind !== "word" || punct(k - 1, ".")) continue;
    if (tok.text === "import") {
      if (punct(k + 1, "(")) {
        const a = str(k + 2);
        if (a?.static && (punct(k + 3, ")") || punct(k + 3, ","))) {
          refs.push({ specifier: a.text, line: tok.line, typeOnly: false });
        }
        continue;
      }
      if (punct(k + 1, ".")) continue;
      const side = str(k + 1);
      if (side) {
        refs.push({ specifier: side.text, line: tok.line, typeOnly: false });
        continue;
      }
      const typeOnly = word(k + 1, "type") && !word(k + 2, "from") && !punct(k + 2, ",");
      for (let j = k + 1; j < t.length && !punct(j, ";"); j++) {
        const s = str(j + 1);
        if (word(j, "from") && s) {
          refs.push({ specifier: s.text, line: tok.line, typeOnly });
          break;
        }
      }
    } else if (tok.text === "export") {
      const typed = word(k + 1, "type") && (punct(k + 2, "{") || punct(k + 2, "*"));
      if (!(typed || punct(k + 1, "{") || punct(k + 1, "*"))) continue;
      for (let j = k + 1; j < t.length && !punct(j, ";"); j++) {
        const s = str(j + 1);
        if (word(j, "from") && s) {
          refs.push({ specifier: s.text, line: tok.line, typeOnly: typed });
          break;
        }
      }
    }
  }
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
