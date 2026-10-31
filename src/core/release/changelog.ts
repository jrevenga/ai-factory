import { compareSemver } from "./semver.ts";

const HEADING = /^## \[(\d+\.\d+\.\d+)\]/;

export function changelogVersions(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((l) => HEADING.exec(l)?.[1])
    .filter((v): v is string => v !== undefined);
}

/** Sections with `from < version <= to`, newest first. */
export function changelogBetween(markdown: string, from: string, to: string): string {
  const sections: Array<{ version: string; lines: string[] }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const v = HEADING.exec(line)?.[1];
    if (v !== undefined) sections.push({ version: v, lines: [line] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections
    .filter((s) => compareSemver(s.version, from) > 0 && compareSemver(s.version, to) <= 0)
    .sort((a, b) => compareSemver(b.version, a.version))
    .map((s) => s.lines.join("\n").trimEnd())
    .join("\n\n");
}
