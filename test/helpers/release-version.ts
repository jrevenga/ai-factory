// The factory version of the tree under test, read from release.json, and a higher one. Tests that need
// "the current release" or "a newer release" derive them here instead of hardcoding a version, so a
// release bump does not touch the tests.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `factory` in release.json. */
export const RELEASE: string = (JSON.parse(readFileSync(join(ROOT, "release.json"), "utf8")) as { factory: string }).factory;

/** RELEASE with its minor bumped: a release newer than the one under test. */
export const NEWER: string = (() => {
  const [major, minor] = RELEASE.split(".").map(Number);
  return `${major}.${(minor ?? 0) + 1}.0`;
})();
