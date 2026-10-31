// Verifies release.json against package.json, package-lock.json and CHANGELOG.md.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogVersions } from "../src/core/release/changelog.ts";
import { ReleaseManifest, STATE_DOCS } from "../src/core/release/manifest.ts";
import { satisfies } from "../src/core/release/semver.ts";

const FIX = "run `npm run manifest:update`";

export function lockfileSha256(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

function installScriptPackages(lock: { packages?: Record<string, { hasInstallScript?: boolean }> }): string[] {
  return Object.entries(lock.packages ?? {})
    .filter(([, v]) => v.hasInstallScript === true)
    .map(([k]) => k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length))
    .sort();
}

export function checkManifest(root: string): string[] {
  const problems: string[] = [];
  const read = (f: string): string => readFileSync(join(root, f), "utf8");
  const parsed = ReleaseManifest.safeParse(JSON.parse(read("release.json")));
  if (!parsed.success) return [`release.json is invalid: ${parsed.error.message}`];
  const m = parsed.data;
  const pkg = JSON.parse(read("package.json")) as { version?: string; peerDependencies?: Record<string, string> };
  const peerName = m.pi.package;

  if (pkg.version !== m.factory) {
    problems.push(`release.json factory ${m.factory} != package.json version ${pkg.version}`);
  }
  const peer = pkg.peerDependencies?.[peerName];
  if (peer !== m.pi.version) {
    problems.push(`package.json peer dependency ${peerName} is ${peer} but release.json pi.version is ${m.pi.version}`);
  }
  try {
    if (!satisfies(m.pi.version, m.pi.supportedRange)) {
      problems.push(`pi.version ${m.pi.version} is outside pi.supportedRange ${m.pi.supportedRange}`);
    }
  } catch (e) {
    problems.push(`pi.supportedRange: ${(e as Error).message}`);
  }

  const lockText = read("package-lock.json");
  const sha = lockfileSha256(lockText);
  if (sha !== m.lockfileSha256) {
    problems.push(`lockfileSha256 is stale (package-lock.json is ${sha}); review the dependency change, then ${FIX}`);
  }
  const actual = installScriptPackages(JSON.parse(lockText));
  const reviewed = [...m.reviewedInstallScripts].sort();
  if (JSON.stringify(actual) !== JSON.stringify(reviewed)) {
    problems.push(
      `reviewedInstallScripts [${reviewed.join(", ")}] != lockfile packages with install scripts [${actual.join(", ")}]; review them and edit release.json by hand`,
    );
  }

  if (!changelogVersions(read("CHANGELOG.md")).includes(m.factory)) {
    problems.push(`CHANGELOG.md has no "## [${m.factory}]" section`);
  }
  const keys = Object.keys(m.stateSchemas).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...STATE_DOCS].sort())) {
    problems.push(`stateSchemas keys [${keys.join(", ")}] != [${[...STATE_DOCS].join(", ")}]`);
  }
  return problems;
}

/** Rewrites only lockfileSha256; reviewedInstallScripts stays a manual review list. */
export function updateLockfileHash(root: string): void {
  const p = join(root, "release.json");
  const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  m.lockfileSha256 = lockfileSha256(readFileSync(join(root, "package-lock.json"), "utf8"));
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv.includes("--update")) {
    updateLockfileHash(root);
    console.log("manifest: lockfileSha256 updated (reviewedInstallScripts is manual)");
    return;
  }
  const problems = checkManifest(root);
  if (problems.length > 0) {
    for (const p of problems) console.error(`manifest: ${p}`);
    process.exit(1);
  }
  console.log("manifest: ok");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
