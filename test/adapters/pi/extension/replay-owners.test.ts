import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimReplay,
  claimSteps,
  processStart,
  REPLAY_OWNERS,
  replayOwnersDir,
  type ClaimStep,
  type OwnersFs,
  type ReplayClaim,
} from "../../../../src/adapters/pi/extension/replay-owners.ts";
import { makeTmp } from "../../../helpers/tmp.ts";

/** R61: the replay is owned per work tree (`replayOwnersDir`), not per run. */
const DIR = replayOwnersDir("/runs/p", "/work/tree");
const X = "20261104T100000Z-40";
const A = "20261104T110000Z-50";
const B = "20261104T110500Z-60";
const C = "20261104T111000Z-70";
const D = "20261104T111500Z-80";
const E = "20261104T112000Z-90";
const pidOf = (runId: string) => Number(runId.slice(runId.lastIndexOf("-") + 1));

const errno = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });

/** One shared in-memory directory tree (files only; directories are implicit), with per-actor views that log removals. */
class MemFs {
  readonly files = new Map<string, string>();
  readonly unreadable = new Set<string>();
  readonly removals: Array<{ actor: string; path: string }> = [];
  view(actor: string): OwnersFs {
    return {
      mkdirp: () => undefined,
      writeNew: (p, text) => {
        if (this.files.has(p)) throw errno("EEXIST", p);
        this.files.set(p, text);
      },
      rename: (from, to) => {
        const text = this.files.get(from);
        if (text === undefined) throw errno("ENOENT", from);
        this.files.delete(from);
        this.files.set(to, text);
      },
      list: (dir) => [...this.files.keys()].filter((p) => p.startsWith(`${dir}${sep}`)).map((p) => p.slice(dir.length + 1)),
      read: (p) => {
        if (this.unreadable.has(p)) throw errno("EACCES", p);
        const text = this.files.get(p);
        if (text === undefined) throw errno("ENOENT", p);
        return text;
      },
      remove: (p) => {
        if (this.files.delete(p)) this.removals.push({ actor, path: p });
      },
      exists: (p) => this.files.has(p),
    };
  }
  names(): string[] {
    return this.list();
  }
  list(): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(`${DIR}${sep}`)).map((p) => p.slice(DIR.length + 1)).sort();
  }
  entryOf(runId: string): string | undefined {
    return this.list().find((n) => !n.startsWith(".") && (JSON.parse(this.files.get(`${DIR}${sep}${n}`) ?? "{}") as { runId?: string }).runId === runId);
  }
}

/** Controllable liveness: pids in `dead` are gone; `starts` overrides a pid's current start identity. */
class Probe {
  readonly dead = new Set<number>();
  readonly starts = new Map<number, string>();
  isAlive = (pid: number) => !this.dead.has(pid);
  startOf = (pid: number) => (this.dead.has(pid) ? undefined : (this.starts.get(pid) ?? `s${pid}`));
}

let counter = 0;
const random = () => (++counter).toString(16).padStart(16, "0");
afterEach(() => {
  counter = 0;
});

function opts(fs: MemFs, probe: Probe, actor: string) {
  return { fs: fs.view(actor), startOf: probe.startOf, random, now: () => new Date("2026-11-04T12:00:00.000Z") };
}

/** A contender driven one pause point at a time. */
class Contender {
  readonly gen: Generator<ClaimStep, ReplayClaim | undefined, void>;
  claim: ReplayClaim | undefined;
  finished = false;
  released = false;
  last: ClaimStep | undefined;
  readonly runId: string;
  constructor(runId: string, fs: MemFs, probe: Probe) {
    this.runId = runId;
    this.gen = claimSteps(DIR, runId, probe.isAlive, opts(fs, probe, runId));
  }
  /** Advance to the next pause point (or the end). */
  step(): void {
    const r = this.gen.next();
    if (r.done) {
      this.finished = true;
      this.claim = r.value;
    } else this.last = r.value;
  }
  until(step: ClaimStep): void {
    while (!this.finished && this.last !== step) this.step();
    expect(this.last).toBe(step);
  }
  run(): ReplayClaim | undefined {
    while (!this.finished) this.step();
    return this.claim;
  }
  get owning(): boolean {
    return this.claim !== undefined && !this.released;
  }
  release(): void {
    this.claim?.release();
    this.released = true;
  }
}

/** Seeds the leftover entry of X, a session that died while it owned the replay. */
function deadX(fs: MemFs, probe: Probe): string {
  const name = `40-s40-${"dead".padStart(16, "0")}`;
  fs.files.set(`${DIR}${sep}${name}`, JSON.stringify({ runId: X, pid: 40, start: "s40", createdAt: "2026-11-04T10:00:00.000Z" }));
  probe.dead.add(pidOf(X));
  return name;
}

/** The key property of R52: no process ever removes an entry whose owner is alive, other than its own. */
function expectNoLiveEntryRemovedByOthers(fs: MemFs, probe: Probe, entryOwner: Map<string, string>): void {
  for (const { actor, path } of fs.removals) {
    const owner = entryOwner.get(path);
    if (owner === undefined || owner === actor) continue;
    expect(probe.isAlive(pidOf(owner)), `${actor} removed ${owner}'s entry while ${owner} was alive`).toBe(false);
  }
}

describe("claimReplay (R52: create-then-list unique owner entries)", () => {
  it("a lone contender owns the replay; its entry is complete, uniquely named, and removed on release", () => {
    const fs = new MemFs();
    const probe = new Probe();
    const claim = claimReplay(DIR, A, probe.isAlive, opts(fs, probe, A));
    expect(claim).toBeDefined();
    const names = fs.names();
    expect(names).toEqual([`50-s50-${"1".padStart(16, "0")}`]);
    expect(JSON.parse(fs.files.get(`${DIR}${sep}${names[0]}`) ?? "")).toEqual({ runId: A, pid: 50, start: "s50", createdAt: "2026-11-04T12:00:00.000Z" });
    expect(claim?.owns()).toBe(true);
    claim?.release();
    expect(claim?.owns()).toBe(false);
    expect(fs.names()).toEqual([]);
  });

  it("the entry is written to a temp name first and appears under its final name only complete", () => {
    const fs = new MemFs();
    const probe = new Probe();
    const a = new Contender(A, fs, probe);
    a.until("written");
    expect(fs.names()).toEqual([`.50-s50-${"1".padStart(16, "0")}.tmp`]);
    a.until("created");
    expect(fs.names()).toEqual([`50-s50-${"1".padStart(16, "0")}`]);
  });

  it("another live entry makes the contender back off and remove only its own entry", () => {
    const fs = new MemFs();
    const probe = new Probe();
    const b = claimReplay(DIR, B, probe.isAlive, opts(fs, probe, B));
    const bEntry = fs.entryOf(B);
    expect(claimReplay(DIR, A, probe.isAlive, opts(fs, probe, A))).toBeUndefined();
    expect(fs.names()).toEqual([bEntry]);
    expect(b?.owns()).toBe(true);
  });

  it("entries of dead owners are pruned and the contender proceeds", () => {
    const fs = new MemFs();
    const probe = new Probe();
    deadX(fs, probe);
    // A live pid whose start identity changed: the recorded owner is gone and the pid was reused.
    claimReplay(DIR, B, probe.isAlive, opts(fs, probe, B));
    probe.starts.set(pidOf(B), "reused");
    const claim = claimReplay(DIR, A, probe.isAlive, opts(fs, probe, A));
    expect(claim).toBeDefined();
    expect(fs.names()).toEqual([fs.entryOf(A)]);
  });

  it("an entry without a recorded start identity is judged by its pid alone", () => {
    const fs = new MemFs();
    const probe = new Probe();
    fs.files.set(`${DIR}${sep}60-none-ffff`, JSON.stringify({ runId: B, pid: 60, createdAt: "x" }));
    expect(claimReplay(DIR, A, probe.isAlive, opts(fs, probe, A))).toBeUndefined();
    probe.dead.add(60);
    expect(claimReplay(DIR, A, probe.isAlive, opts(fs, probe, A))).toBeDefined();
  });

  it("an unreadable or unparsable entry counts as live: it blocks and is kept (fail closed)", () => {
    for (const bad of ["unreadable", "{not json", JSON.stringify({ runId: B }), ""]) {
      const fs = new MemFs();
      const probe = new Probe();
      fs.files.set(`${DIR}${sep}60-s60-junk`, bad);
      if (bad === "unreadable") fs.unreadable.add(`${DIR}${sep}60-s60-junk`);
      expect(claimReplay(DIR, A, probe.isAlive, opts(fs, probe, A)), bad).toBeUndefined();
      expect(fs.names()).toEqual(["60-s60-junk"]);
    }
  });

  it("a leftover temp file of a dead writer is pruned; a live writer's temp is not an entry and does not block", () => {
    const fs = new MemFs();
    const probe = new Probe();
    fs.files.set(`${DIR}${sep}.40-s40-aaaa.tmp`, "{");
    fs.files.set(`${DIR}${sep}.60-s60-bbbb.tmp`, "{");
    probe.dead.add(40);
    const claim = claimReplay(DIR, A, probe.isAlive, opts(fs, probe, A));
    expect(claim).toBeDefined();
    expect(fs.names()).toEqual([".60-s60-bbbb.tmp", fs.entryOf(A)].sort());
  });

  it("a contender whose temp file was pruned before its rename backs off", () => {
    const fs = new MemFs();
    const probe = new Probe();
    const a = new Contender(A, fs, probe);
    a.until("written");
    fs.files.clear();
    expect(a.run()).toBeUndefined();
    expect(fs.names()).toEqual([]);
  });

  it("an entry that vanished between the listing and its read (released or pruned) does not block", () => {
    const fs = new MemFs();
    const probe = new Probe();
    const b = claimReplay(DIR, B, probe.isAlive, opts(fs, probe, B));
    const a = new Contender(A, fs, probe);
    a.until("listed");
    b?.release();
    expect(a.run()).toBeDefined();
  });

  it("an error after the entry exists removes the contender's own entry and is thrown", () => {
    const fs = new MemFs();
    const probe = new Probe();
    const view = fs.view(A);
    const failing: OwnersFs = {
      ...view,
      list: () => {
        throw errno("EIO", DIR);
      },
    };
    expect(() => claimReplay(DIR, A, probe.isAlive, { ...opts(fs, probe, A), fs: failing })).toThrow(/EIO/);
    expect(fs.names()).toEqual([]);
  });

  it("owns() is false once the contender's own entry is gone", () => {
    const fs = new MemFs();
    const probe = new Probe();
    const claim = claimReplay(DIR, A, probe.isAlive, opts(fs, probe, A));
    fs.files.clear();
    expect(claim?.owns()).toBe(false);
  });
});

describe("claimReplay: schedules of Codex's re-reviews r2 and r3, adapted (never two owners)", () => {
  it("r2: stale-view contender A, live holder B, third contender C in the window: C never proceeds while B replays", () => {
    const fs = new MemFs();
    const probe = new Probe();
    const owner = new Map<string, string>();
    // B owns and is replaying; X died later, leaving its entry.
    const b = new Contender(B, fs, probe);
    expect(b.run()).toBeDefined();
    owner.set(`${DIR}${sep}${fs.entryOf(B)}`, B);
    deadX(fs, probe);
    owner.set(`${DIR}${sep}${fs.entryOf(X)}`, X);
    // A lists (a view about to go stale: X dead, B live) and pauses before classifying.
    const a = new Contender(A, fs, probe);
    a.until("listed");
    owner.set(`${DIR}${sep}${fs.entryOf(A)}`, A);
    // C runs in that window and prunes X; A's view of X is now stale.
    const c = new Contender(C, fs, probe);
    expect(c.run()).toBeUndefined();
    expect(fs.entryOf(X)).toBeUndefined();
    a.step();
    expect(a.run()).toBeUndefined();
    expect(b.owning && b.claim?.owns()).toBe(true);
    expect(fs.names()).toEqual([fs.entryOf(B)]);
    expectNoLiveEntryRemovedByOthers(fs, probe, owner);
  });

  it("r3: A and D inspect dead X, C pauses after its scan, B replays; cleanup never deletes B's entry and E never joins B", () => {
    const fs = new MemFs();
    const probe = new Probe();
    const owner = new Map<string, string>();
    const record = (runId: string) => {
      const n = fs.entryOf(runId);
      if (n !== undefined) owner.set(`${DIR}${sep}${n}`, runId);
    };
    deadX(fs, probe);
    record(X);
    const owners = (cs: Contender[]) => cs.filter((c) => c.owning).map((c) => c.runId);
    // 1. A and D inspect dead X; C pauses after its admission scan.
    const a = new Contender(A, fs, probe);
    const d = new Contender(D, fs, probe);
    const c = new Contender(C, fs, probe);
    a.until("listed");
    record(A);
    d.until("listed");
    record(D);
    c.until("classified");
    record(C);
    // 2. B contends while A, C and D are mid-protocol: their entries are live, so B backs off.
    const b = new Contender(B, fs, probe);
    b.run();
    record(B);
    const all = [a, b, c, d];
    expect(owners(all).length).toBeLessThanOrEqual(1);
    // 3-6. Every remaining contender finishes in the order of the original schedule (A, C, D).
    a.run();
    expect(owners(all).length).toBeLessThanOrEqual(1);
    c.run();
    expect(owners(all).length).toBeLessThanOrEqual(1);
    d.run();
    expect(owners(all).length).toBeLessThanOrEqual(1);
    // 7. C exits; E arrives while the owner (if any) is still replaying.
    const e = new Contender(E, fs, probe);
    const current = owners(all);
    e.run();
    record(E);
    if (current.length === 1) expect(e.claim).toBeUndefined();
    expect(owners([...all, e]).length).toBeLessThanOrEqual(1);
    // X was pruned; no live entry other than the owner's is left behind.
    expect(fs.entryOf(X)).toBeUndefined();
    expect(fs.names().length).toBe(owners([...all, e]).length);
    expectNoLiveEntryRemovedByOthers(fs, probe, owner);
  });
});

/** All interleavings of the given per-actor action counts (multiset permutations). */
function* interleavings(counts: number[], prefix: number[] = []): Generator<number[]> {
  if (counts.every((n) => n === 0)) {
    yield prefix;
    return;
  }
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i] as number;
    if (n === 0) continue;
    counts[i] = n - 1;
    yield* interleavings(counts, [...prefix, i]);
    counts[i] = n;
  }
}

/** Mulberry32: a small seeded PRNG so sampled schedules are reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs one schedule: each actor makes its claim one pause point at a time, then (when it owns) replays for one step
 * and releases. Checks after every action that at most one actor owns and that every owner still sees its entry.
 */
function runSchedule(runIds: string[], order: number[], kill?: { actor: number; at: number }): { owners: number; fs: MemFs; probe: Probe } {
  const fs = new MemFs();
  const probe = new Probe();
  const owner = new Map<string, string>();
  deadX(fs, probe);
  owner.set(`${DIR}${sep}${fs.entryOf(X)}`, X);
  const cs = runIds.map((r) => new Contender(r, fs, probe));
  const phase = cs.map(() => 0);
  let everOwned = 0;
  order.forEach((i, k) => {
    const c = cs[i] as Contender;
    if (kill !== undefined && k === kill.at) probe.dead.add(pidOf(runIds[kill.actor] as string));
    if (probe.dead.has(pidOf(c.runId))) return; // a dead actor does nothing more
    if (!c.finished) {
      c.step();
      const n = fs.entryOf(c.runId);
      if (n !== undefined) owner.set(`${DIR}${sep}${n}`, c.runId);
      if (c.finished && c.claim !== undefined) everOwned++;
    } else if (c.owning && phase[i] === 0) {
      expect(c.claim?.owns()).toBe(true); // replaying a manifest
      phase[i] = 1;
    } else if (c.owning) c.release();
    const live = cs.filter((x) => x.owning && !probe.dead.has(pidOf(x.runId)));
    expect(live.length, `order ${order.join("")}`).toBeLessThanOrEqual(1);
  });
  expectNoLiveEntryRemovedByOthers(fs, probe, owner);
  return { owners: everOwned, fs, probe };
}

describe("claimReplay: interleavings (mutual exclusion over progress)", () => {
  // Each actor: 5 claim actions (written, created, listed, classified, decision) + replay + release.
  const ACTIONS = 7;

  it("two simultaneous contenders over every interleaving: at most one proceeds at any time", () => {
    let schedules = 0;
    let bothBackedOff = 0;
    for (const order of interleavings([ACTIONS, ACTIONS])) {
      const r = runSchedule([A, B], order);
      schedules++;
      if (r.owners === 0) bothBackedOff++;
    }
    expect(schedules).toBe(3432);
    // Some schedules make both back off (safe; retried at a later startup), and sequential ones let one proceed.
    expect(bothBackedOff).toBeGreaterThan(0);
    expect(runSchedule([A, B], [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]).owners).toBe(2);
  });

  it("three contenders over 4000 seeded random interleavings: at most one proceeds at any time", () => {
    const rand = prng(52);
    for (let s = 0; s < 4000; s++) {
      const pool = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = pool[i] as number;
        pool[i] = pool[j] as number;
        pool[j] = t;
      }
      runSchedule([A, B, C], pool);
    }
  });

  it("a contender that dies at any point never leaves the others two owners, and its entry is later pruned", () => {
    const base = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1];
    for (let at = 0; at < base.length; at++) {
      for (const order of [base, [...base.slice(7), ...base.slice(0, 7)], base.map((_, k) => (k % 2) as number)]) {
        const r = runSchedule([A, B], order, { actor: 0, at });
        // After the death, a fresh contender can always proceed: A's leftover entry is dead.
        const f = claimReplay(DIR, C, r.probe.isAlive, opts(r.fs, r.probe, C));
        const liveOwner = r.fs.entryOf(B) !== undefined;
        if (!liveOwner) expect(f, `at ${at}`).toBeDefined();
        f?.release();
        expect(r.fs.entryOf(A)).toBeUndefined();
      }
    }
  });
});

describe("claimReplay on the real filesystem", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  async function ownersDir(): Promise<string> {
    const t = await makeTmp("owners");
    cleanups.push(t.cleanup);
    const project = join(t.dir, "runs", "p");
    mkdirSync(project, { recursive: true });
    return replayOwnersDir(project, join(t.dir, "work tree"));
  }

  it("creates the owners directory, writes a complete entry, leaves no temp file, and releases it", async () => {
    const d = await ownersDir();
    const claim = claimReplay(d, A, () => true);
    expect(claim).toBeDefined();
    const names = readdirSync(d);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^50-none-[0-9a-f]{16}$/);
    expect(JSON.parse(readFileSync(join(d, names[0] as string), "utf8"))).toMatchObject({ runId: A, pid: 50 });
    expect(claimReplay(d, B, () => true)).toBeUndefined();
    expect(readdirSync(d)).toEqual(names);
    claim?.release();
    expect(readdirSync(d)).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("records this process's start identity; a live pid with another start identity is a dead owner", async () => {
    const d = await ownersDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${process.pid}-1-aaaa`), JSON.stringify({ runId: X, pid: process.pid, start: "1", createdAt: "x" }));
    const own = `20261104T120000Z-${process.pid}`;
    const claim = claimReplay(d, own, () => true);
    expect(claim).toBeDefined();
    const names = readdirSync(d);
    expect(names).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-${processStart(process.pid)}-[0-9a-f]{16}$`))]);
    expect(JSON.parse(readFileSync(join(d, names[0] as string), "utf8"))).toMatchObject({ pid: process.pid, start: processStart(process.pid) });
    // That entry is alive for any other contender.
    expect(claimReplay(d, A, () => true)).toBeUndefined();
  });
});

describe("replayOwnersDir (R61)", () => {
  it("keys the owners directory by the work tree, below the project ledger's replay.owners", () => {
    const a = replayOwnersDir("/runs/p", "/work/tree");
    expect(a).toMatch(new RegExp(`^/runs/p/${REPLAY_OWNERS}/[0-9a-f]{32}$`.replaceAll("/", "[\\\\/]")));
    expect(replayOwnersDir("/runs/p", "/work/tree")).toBe(a);
    expect(replayOwnersDir("/runs/p", "/work/other")).not.toBe(a);
  });
});
