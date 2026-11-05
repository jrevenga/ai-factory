import { describe, expect, it } from "vitest";
import { redirectTargets, tokenizeCommandLine, type Segment } from "../../../src/core/policy/shell.ts";

function segments(cmd: string): Segment[] {
  const r = tokenizeCommandLine(cmd);
  if (!r.ok) throw new Error(`expected ok for ${JSON.stringify(cmd)}, got: ${r.reason}`);
  return r.segments;
}

function argvs(cmd: string): string[][] {
  return segments(cmd).map((s) => s.argv);
}

describe("tokenizeCommandLine: words and quotes", () => {
  it("splits plain words", () => {
    expect(segments("ls -la  src")).toEqual([{ assignments: {}, argv: ["ls", "-la", "src"], redirections: [] }]);
  });

  it("keeps quoted text literal and concatenates adjacent parts", () => {
    expect(argvs(`echo 'a b' "c d" e'f'"g"`)).toEqual([["echo", "a b", "c d", "efg"]]);
    expect(argvs(`echo "" ''`)).toEqual([["echo", "", ""]]);
    expect(argvs(`echo 'a;b|c&&d>e'`)).toEqual([["echo", "a;b|c&&d>e"]]);
    expect(argvs(`echo "line1\nline2"`)).toEqual([["echo", "line1\nline2"]]);
  });

  it("accepts tabs as blanks and a leading ~/ in an unquoted word", () => {
    expect(argvs("cat\t~/notes.txt")).toEqual([["cat", "~/notes.txt"]]);
    expect(segments("echo x >~/out")[0]?.redirections).toEqual([{ op: ">", target: "~/out" }]);
  });
});

describe("tokenizeCommandLine: operators", () => {
  it("splits operators glued to words (adjacency)", () => {
    expect(segments("a&&b")).toEqual([
      { assignments: {}, argv: ["a"], redirections: [] },
      { assignments: {}, argv: ["b"], redirections: [], joinedBy: "&&" },
    ]);
    expect(segments("x>f")).toEqual([{ assignments: {}, argv: ["x"], redirections: [{ op: ">", target: "f" }] }]);
    expect(segments("a;b").map((s) => [s.argv, s.joinedBy])).toEqual([
      [["a"], undefined],
      [["b"], ";"],
    ]);
    expect(segments("a|b").map((s) => [s.argv, s.joinedBy])).toEqual([
      [["a"], undefined],
      [["b"], "|"],
    ]);
    expect(segments("a||b")[1]?.joinedBy).toBe("||");
    expect(segments("a>>f")[0]?.redirections).toEqual([{ op: ">>", target: "f" }]);
    expect(segments("a<f")[0]?.redirections).toEqual([{ op: "<", target: "f" }]);
    expect(segments("a&>f")[0]).toEqual({ assignments: {}, argv: ["a"], redirections: [{ op: "&>", target: "f" }] });
  });

  it("treats newline as a list operator and skips blank lines and continuations", () => {
    expect(segments("ls\ngit push").map((s) => [s.argv, s.joinedBy])).toEqual([
      [["ls"], undefined],
      [["git", "push"], "\n"],
    ]);
    expect(segments("\n\nls\n\n").map((s) => s.argv)).toEqual([["ls"]]);
    expect(segments("a &&\n  b")[1]?.joinedBy).toBe("&&");
    expect(segments("a;\nb")[1]?.joinedBy).toBe(";");
    expect(segments("ls;").map((s) => s.argv)).toEqual([["ls"]]);
  });

  it("recognizes fd-digit redirections only for an unquoted standalone 2", () => {
    expect(segments("ls 2>out")[0]).toEqual({ assignments: {}, argv: ["ls"], redirections: [{ op: "2>", target: "out" }] });
    expect(segments("ls 2>> out")[0]?.redirections).toEqual([{ op: "2>>", target: "out" }]);
    expect(segments("ls2>out")[0]).toEqual({ assignments: {}, argv: ["ls2"], redirections: [{ op: ">", target: "out" }] });
    expect(segments(`ls "2">out`)[0]).toEqual({ assignments: {}, argv: ["ls", "2"], redirections: [{ op: ">", target: "out" }] });
  });

  it("reports file redirection targets and ignores 2>&1", () => {
    const segs = segments("echo x > out.txt 2>&1");
    expect(segs[0]?.redirections).toEqual([
      { op: ">", target: "out.txt" },
      { op: "2>&1", target: "" },
    ]);
    expect(redirectTargets(segs)).toEqual(["out.txt"]);
    expect(redirectTargets(segments("sort < in.txt > 'out file' && ls 2>err"))).toEqual(["in.txt", "out file", "err"]);
  });

  it("accepts redirections before the command word", () => {
    expect(segments(">out echo x")[0]).toEqual({ assignments: {}, argv: ["echo", "x"], redirections: [{ op: ">", target: "out" }] });
  });
});

describe("tokenizeCommandLine: assignments", () => {
  it("collects leading NAME=value words only", () => {
    expect(segments(`CI=1 FOO="a b" npm test X=1`)[0]).toEqual({
      assignments: { CI: "1", FOO: "a b" },
      argv: ["npm", "test", "X=1"],
      redirections: [],
    });
  });

  it("does not treat a quoted name or an invalid name as an assignment", () => {
    expect(segments(`"CI"=1 ls`)[0]?.argv).toEqual(["CI=1", "ls"]);
    expect(segments(`C""I=1 ls`)[0]?.argv).toEqual(["CI=1", "ls"]);
    expect(segments(`1X=1 ls`)[0]?.argv).toEqual(["1X=1", "ls"]);
  });

  it("keeps an assignment-only segment with an empty argv", () => {
    expect(segments("PATH=/tmp; ls")[0]).toEqual({ assignments: { PATH: "/tmp" }, argv: [], redirections: [] });
  });

  it("stores __proto__ as a plain key", () => {
    const seg = segments("__proto__=x ls")[0];
    expect(Object.keys(seg?.assignments ?? {})).toEqual(["__proto__"]);
    expect(seg?.assignments["__proto__"]).toBe("x");
  });
});

describe("tokenizeCommandLine: fails closed", () => {
  const rejected: string[] = [
    "a $(b)",
    "a `b`",
    "echo $HOME",
    "ls # x",
    "echo a\\ b",
    "{ ls; }",
    "(ls)",
    "ls *.ts",
    "ls ?",
    "ls [ab]",
    "echo !x",
    "echo a~/x",
    "x=~/a ls",
    `echo "~/x"`,
    "echo '~/x'",
    "echo ~",
    "ls &",
    "ls & ls",
    "ls &&& ls",
    "a &&",
    "a |",
    "&& a",
    "; a",
    "a ;; b",
    "a | | b",
    "a\n;b",
    "echo 'x",
    'echo "x',
    "cat <<EOF\nx\nEOF",
    "cat <<<x",
    "cat <(ls)",
    "ls |& cat",
    "ls 1>out",
    "ls 0<in",
    "ls 12>out",
    "ls 2<in",
    "ls >&2",
    "ls 2>&12",
    "ls 2 >&1",
    "ls >",
    "ls > | x",
    "ls <> f",
    "ls >| f",
    "ls &>> f",
    "ls\r\n",
    "ls\u0000",
    "ls​",
    "ls -la",
    "ls ",
    "",
    "   \n\t",
    "if true; then ls; fi",
    "while true; do ls; done",
    "time ls",
    "x".repeat(100_001),
  ];
  for (const cmd of rejected) {
    it(`rejects ${JSON.stringify(cmd.length > 40 ? `${cmd.slice(0, 20)}...` : cmd)}`, () => {
      const r = tokenizeCommandLine(cmd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    });
  }
});
