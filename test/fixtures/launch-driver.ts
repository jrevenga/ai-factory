// Runs `launch` in its own process so tests can signal the launcher. Uses a stub doctor.
import { readFileSync } from "node:fs";
import { factoryPaths } from "../../src/adapters/platform/paths.ts";
import { launch } from "../../src/cli/commands/launch.ts";
import { defaultIO } from "../../src/cli/io.ts";
import { ReleaseManifest } from "../../src/core/release/manifest.ts";

const manifest = ReleaseManifest.parse(JSON.parse(readFileSync("release.json", "utf8")));
const code = await launch({ paths: factoryPaths(process.env), env: process.env, manifest, io: defaultIO(), doctor: async () => [] }, process.argv.slice(2));
process.exit(code);
