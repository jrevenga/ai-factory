import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkManifest, updateLockfileHash } from "../../scripts/manifest-check.ts";
import { makeTmp } from "../helpers/tmp.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function copy(): Promise<string> {
  const t = await makeTmp("manifest");
  cleanups.push(t.cleanup);
  for (const f of ["release.json", "package.json", "package-lock.json", "CHANGELOG.md"]) {
    cpSync(join(root, f), join(t.dir, f));
  }
  return t.dir;
}
function edit(dir: string, file: string, fn: (text: string) => string): void {
  const p = join(dir, file);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
}

describe("checkManifest", () => {
  it("the real repo is consistent", () => {
    expect(checkManifest(root)).toEqual([]);
  });
  it("flags a floating peer dependency", async () => {
    const d = await copy();
    edit(d, "package.json", (t) => {
      const pkg = JSON.parse(t) as { peerDependencies: Record<string, string> };
      pkg.peerDependencies["@earendil-works/pi-coding-agent"] = "*";
      return `${JSON.stringify(pkg, null, 2)}\n`;
    });
    const problems = checkManifest(d);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("@earendil-works/pi-coding-agent");
  });
  it("flags version, changelog, range, stateSchemas and install-script drift", async () => {
    const d = await copy();
    edit(d, "release.json", (t) =>
      t
        .replace('"factory": "0.1.0"', '"factory": "0.2.0"')
        .replace(">=1.4.0 <1.5.0", ">=1.5.0 <1.6.0")
        .replace('"managed-settings.json": 1', '"managed-settings.json": 1, "other.json": 1')
        .replace('"fsevents",', ""),
    );
    const text = checkManifest(d).join("\n");
    expect(text).toContain("package.json version");
    expect(text).toContain('no "## [0.2.0]"');
    expect(text).toContain("outside pi.supportedRange");
    expect(text).toContain("stateSchemas keys");
    expect(text).toContain("reviewedInstallScripts");
  });
  it("lockfile hash ignores CRLF, detects change, and update fixes only the hash", async () => {
    const d = await copy();
    edit(d, "package-lock.json", (t) => t.replace(/\n/g, "\r\n"));
    expect(checkManifest(d)).toEqual([]);
    edit(d, "package-lock.json", (t) => `${t} `);
    const problems = checkManifest(d);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("npm run manifest:update");
    const before = JSON.parse(readFileSync(join(d, "release.json"), "utf8"));
    updateLockfileHash(d);
    const after = JSON.parse(readFileSync(join(d, "release.json"), "utf8"));
    expect(after.reviewedInstallScripts).toEqual(before.reviewedInstallScripts);
    expect(checkManifest(d)).toEqual([]);
  });
});
