// Generates schemas/*.schema.json from the zod schemas. `--check` exits 1 if committed files differ.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PersonalConfig, ProjectConfig } from "../src/core/config/schema.ts";
import { CheckRecord, ReviewDisposition } from "../src/core/evidence/records.ts";
import { RunEvent } from "../src/core/ledger/events.ts";
import { Profile } from "../src/core/profiles/schema.ts";
import { ReleaseManifest } from "../src/core/release/manifest.ts";
import { ManagedRecord } from "../src/core/settings/managed.ts";
import { FactoryState } from "../src/core/state/schema.ts";

const SOURCES: Record<string, z.ZodType> = {
  "personal-config.schema.json": PersonalConfig,
  "project-config.schema.json": ProjectConfig,
  "profile.schema.json": Profile,
  "release.schema.json": ReleaseManifest,
  "managed-settings.schema.json": ManagedRecord,
  "state.schema.json": FactoryState,
  "run-event.schema.json": RunEvent,
  "check-record.schema.json": CheckRecord,
  "review-disposition.schema.json": ReviewDisposition,
};

export function generateSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [file, schema] of Object.entries(SOURCES)) {
    out[file] = `${JSON.stringify(z.toJSONSchema(schema, { io: "input" }), null, 2)}\n`;
  }
  return out;
}

/** Returns the names of files that are missing or stale in `dir`. */
export function checkSchemas(dir: string): string[] {
  return Object.entries(generateSchemas())
    .filter(([file, text]) => {
      const p = join(dir, file);
      return !existsSync(p) || readFileSync(p, "utf8") !== text;
    })
    .map(([file]) => file);
}

function main(): void {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
  if (process.argv.includes("--check")) {
    const stale = checkSchemas(dir);
    if (stale.length > 0) {
      console.error(`stale schemas: ${stale.join(", ")} (run \`npm run schemas\`)`);
      process.exit(1);
    }
    console.log("schemas: ok");
    return;
  }
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(generateSchemas())) writeFileSync(join(dir, file), text);
  console.log("schemas: written");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
