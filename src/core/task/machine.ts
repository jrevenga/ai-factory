// The machine-owned section of a task file (M §7.1, §14 row 5): written by extension code only.
export const MACHINE_OPEN = "<!-- machine: written by code only -->";
export const MACHINE_CLOSE = "<!-- /machine -->";

const ORDER = ["phase", "base", "checkpoint", "worktree", "run"];
const SEP = " · ";

export interface ParsedMachine {
  fields: Record<string, string>;
  /** Offset of MACHINE_OPEN. */
  start: number;
  /** Offset just after MACHINE_CLOSE. */
  end: number;
}

export function parseMachine(md: string): ParsedMachine | undefined {
  const start = md.indexOf(MACHINE_OPEN);
  if (start < 0) return undefined;
  const closeAt = md.indexOf(MACHINE_CLOSE, start + MACHINE_OPEN.length);
  if (closeAt < 0) return undefined;
  const inner = md.slice(start + MACHINE_OPEN.length, closeAt).trim();
  const fields: Record<string, string> = {};
  for (const part of inner.split(SEP)) {
    const i = part.indexOf(": ");
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 2).trim();
  }
  return { fields, start, end: closeAt + MACHINE_CLOSE.length };
}

export function renderMachine(fields: Record<string, string>): string {
  const keys = [...ORDER.filter((k) => k in fields), ...Object.keys(fields).filter((k) => !ORDER.includes(k))];
  return `${MACHINE_OPEN}\n${keys.map((k) => `${k}: ${fields[k]}`).join(SEP)}\n${MACHINE_CLOSE}`;
}

export function replaceMachine(md: string, fields: Record<string, string>): string {
  const block = renderMachine(fields);
  const existing = parseMachine(md);
  if (existing) return md.slice(0, existing.start) + block + md.slice(existing.end);
  const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (fm) {
    const at = fm[0].length;
    return `${md.slice(0, at)}${block}\n\n${md.slice(at)}`;
  }
  return `${block}\n\n${md}`;
}

/** True when the machine block (or its presence) differs between the two texts. */
export function touchesMachine(before: string, after: string): boolean {
  const slice = (md: string): string | undefined => {
    const p = parseMachine(md);
    return p ? md.slice(p.start, p.end) : undefined;
  };
  return slice(before) !== slice(after);
}
