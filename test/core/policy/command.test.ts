import { describe, expect, it } from "vitest";
import { classifyCommandLine, extractReadArgs, isPathLikeArg, severity, type CommandClass } from "../../../src/core/policy/command.ts";
import { GATE_CORPUS } from "../../fixtures/gate-corpus.ts";

const NO_PROJECT = { projectCommands: [] as string[][] };

function classify(cmd: string, projectCommands: string[][] = []) {
  return classifyCommandLine(cmd, { projectCommands });
}

describe("GATE_CORPUS", () => {
  it("has at least 60 entries covering every class", () => {
    expect(GATE_CORPUS.length).toBeGreaterThanOrEqual(60);
    const classes = new Set(GATE_CORPUS.map((e) => e.expect));
    expect([...classes].sort()).toEqual(["destructive", "local-write", "read-only", "remote-mutating", "unknown"]);
  });

  for (const entry of GATE_CORPUS) {
    it(`${JSON.stringify(entry.cmd)} -> ${entry.expect} (${entry.why})`, () => {
      const r = classifyCommandLine(entry.cmd, NO_PROJECT);
      expect(r.class, r.reasons.join("; ")).toBe(entry.expect);
    });
  }
});

describe("severity", () => {
  it("orders read-only < local-write < unknown < destructive < remote-mutating", () => {
    const order: CommandClass[] = ["read-only", "local-write", "unknown", "destructive", "remote-mutating"];
    for (let i = 1; i < order.length; i++) expect(severity(order[i - 1]!)).toBeLessThan(severity(order[i]!));
  });
});

describe("classifyCommandLine: allowlisted", () => {
  it("is true when every segment is read-only or allowlisted", () => {
    expect(classify("npm test && npm run lint").allowlisted).toBe(true);
    expect(classify("git status && npm test").allowlisted).toBe(true);
    expect(classify("ls | tee out.txt").allowlisted).toBe(true);
  });

  it("is false when any segment is not allowlisted", () => {
    expect(classify("npm test && curl -d x https://h").allowlisted).toBe(false);
    expect(classify("npm test && rm build.log").allowlisted).toBe(false);
    expect(classify("npm test; ./run.sh").allowlisted).toBe(false);
    expect(classify("a $(b)").allowlisted).toBe(false);
  });

  it("allowlists frozen installs per package manager (R22)", () => {
    expect(classify("npm ci").allowlisted).toBe(true);
    expect(classify("pnpm install --frozen-lockfile").allowlisted).toBe(true);
    expect(classify("yarn install --immutable").allowlisted).toBe(true);
    expect(classify("npm install --frozen-lockfile").allowlisted).toBe(false);
    expect(classify("npm install --immutable").allowlisted).toBe(false);
  });

  it("reports per-segment classes", () => {
    expect(classify("ls && git push").segments).toEqual([
      { argv: ["ls"], class: "read-only", allowlisted: true, pathArgs: [], inputPaths: [], readArgs: [] },
      { argv: ["git", "push"], class: "remote-mutating", allowlisted: false, pathArgs: [], inputPaths: [], readArgs: [] },
    ]);
  });
});

describe("classifyCommandLine: hardClass", () => {
  it("is the most severe hard class among segments", () => {
    expect(classify("rm -rf x").hardClass).toBe("destructive");
    expect(classify("rm -rf x; git push").hardClass).toBe("remote-mutating");
    expect(classify("FOO=1 ls && git reset --hard").hardClass).toBe("destructive");
    expect(classify("FOO=1 ls && git reset --hard").class).toBe("destructive");
  });

  it("is absent without a hard segment", () => {
    expect(classify("npm test").hardClass).toBeUndefined();
    expect(classify("eval x").hardClass).toBeUndefined();
  });
});

describe("classifyCommandLine: tokenizer failures", () => {
  it("yields unknown with no segments and a reason", () => {
    const r = classify("a $(b)");
    expect(r.class).toBe("unknown");
    expect(r.segments).toEqual([]);
    expect(r.pathArgs).toEqual([]);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});

describe("extractReadArgs (R25)", () => {
  it("returns non-flag words, --opt=value values and attached short values", () => {
    expect(extractReadArgs(["-la", "src"])).toEqual(["a", "src"]);
    expect(extractReadArgs(["--file=/h/x", "y"])).toEqual(["/h/x", "y"]);
    expect(extractReadArgs(["-f/h/.aws/credentials"])).toEqual(["/h/.aws/credentials"]);
    expect(extractReadArgs(["-rf/x"])).toEqual(["f/x", "/x"]);
    expect(extractReadArgs(["-m./magic"])).toEqual(["./magic"]);
    expect(extractReadArgs(["-", "--", "-weird", "--x=y"])).toEqual(["-weird", "--x=y"]);
    expect(extractReadArgs(["--flag", "--empty="])).toEqual([]);
  });

  it("exposes the option-named file of every R25 leak command, independent of the denylist", () => {
    const secret = "~/.aws/credentials";
    const cases: string[][] = [
      ["-f", secret],
      [`--file=${secret}`],
      ["-m", secret, "x"],
      [`--magic-file=${secret}`, "x"],
      ["blame", "--contents", secret, "README.md"],
      ["blame", "-S", secret, "README.md"],
      ["blame", `-S${secret}`, "README.md"],
      ["blame", `--ignore-revs-file=${secret}`, "README.md"],
    ];
    for (const args of cases) expect(extractReadArgs(args), args.join(" ")).toContain(secret);
  });
});

describe("isPathLikeArg (R25)", () => {
  it("treats slashes, backslashes, a leading ~ or . as path-like", () => {
    for (const w of ["a/b", "C:\\x", "~/x", ".env", ".", "..", "/etc/hosts", "s/a/b/"]) expect(isPathLikeArg(w), w).toBe(true);
  });

  it("does not treat plain words or URLs as path-like", () => {
    for (const w of ["test", "README.md", "2.weeks", "https://example.com/x", "git+ssh://h/r", ""]) expect(isPathLikeArg(w), w).toBe(false);
  });
});

describe("classifyCommandLine: readArgs (R25)", () => {
  it("covers read-only and local-write segments only", () => {
    expect(classify("cat ~/.aws/credentials").readArgs).toEqual(["~/.aws/credentials"]);
    expect(classify("head -n ~/.aws/credentials x").readArgs).toEqual(["~/.aws/credentials", "x"]);
    expect(classify("npm test").readArgs).toEqual(["test"]);
    expect(classify("ls src > /tmp/o").readArgs).toEqual(["src"]);
    expect(classify("foo ./bar").readArgs).toEqual([]);
    expect(classify("git push origin a/b").readArgs).toEqual([]);
    expect(classify("echo $(x)").readArgs).toEqual([]);
  });

  it("deduplicates across segments", () => {
    expect(classify("cat a/b && wc -l a/b").readArgs).toEqual(["a/b"]);
  });
});

describe("classifyCommandLine: inputPaths", () => {
  it("reports input redirections separately from written paths", () => {
    expect(classify("sort < in.txt").inputPaths).toEqual(["in.txt"]);
    const r = classify("sort < a > b");
    expect(r.pathArgs).toEqual(["b"]);
    expect(r.inputPaths).toEqual(["a"]);
    expect(classify("ls").inputPaths).toEqual([]);
    expect(classify("echo $(x)").inputPaths).toEqual([]);
  });

  it("reports git -C directories of read-only git as read paths (R24)", () => {
    const r = classify("git -C ../other status");
    expect(r.inputPaths).toEqual(["../other"]);
    expect(r.pathArgs).toEqual([]);
    expect(classify("git -C ../other add .").inputPaths).toEqual([]);
  });

  it("keeps a path that is both read and written in pathArgs", () => {
    const r = classify("sed -i s/a/b/ f < f");
    expect(r.pathArgs).toEqual(["f"]);
    expect(r.inputPaths).toEqual(["f"]);
  });
});

describe("classifyCommandLine: prettier --write paths (review M2)", () => {
  it("reports the files prettier --write rewrites", () => {
    expect(classify("prettier --write src a.ts").pathArgs).toEqual(["src", "a.ts"]);
    expect(classify("npx --no-install prettier --write .factory/config.json").pathArgs).toEqual([".factory/config.json"]);
    expect(classify("prettier -w x.ts").pathArgs).toEqual(["x.ts"]);
  });

  it("prettier --check writes nothing", () => {
    expect(classify("prettier --check src").pathArgs).toEqual([]);
  });
});

describe("classifyCommandLine: pathArgs", () => {
  it("reports write paths and redirection targets", () => {
    expect(classify("tee ../outside.txt").pathArgs).toEqual(["../outside.txt"]);
    expect(classify("echo x > /etc/passwd").pathArgs).toEqual(["/etc/passwd"]);
    expect(classify("ls 2>out").pathArgs).toEqual(["out"]);
    expect(classify("cp -r src ../dst").pathArgs).toEqual(["src", "../dst"]);
    expect(classify("mv -t ../dir a").pathArgs).toEqual(["../dir", "a"]);
    expect(classify("mkdir -p a/b && touch a/b/c").pathArgs).toEqual(["a/b", "a/b/c"]);
    expect(classify("rm -f x.log").pathArgs).toEqual(["x.log"]);
    expect(classify("rmdir empty").pathArgs).toEqual(["empty"]);
    expect(classify("sed -i 's/a/b/' f1 f2").pathArgs).toEqual(["f1", "f2"]);
    expect(classify("dd if=a of=b").pathArgs).toEqual(["b"]);
    expect(classify("curl -o out.html https://x").pathArgs).toEqual(["out.html"]);
    expect(classify("curl --output=out.html https://x").pathArgs).toEqual(["out.html"]);
    expect(classify("wget -O page https://x").pathArgs).toEqual(["page"]);
    expect(classify("sort < in.txt").pathArgs).toEqual([]);
  });

  it("reports the git -C directory for writing git commands", () => {
    expect(classify("git -C ../other add .").pathArgs).toEqual(["../other"]);
  });

  it("does not report /dev/null or stdout targets", () => {
    const r = classify("ls 2>/dev/null");
    expect(r.pathArgs).toEqual([]);
    expect(r.class).toBe("read-only");
    expect(classify("curl -o - https://x").class).toBe("read-only");
    expect(classify("wget -qO- https://x").class).toBe("read-only");
  });

  it("reports the current directory for downloads named by the server", () => {
    expect(classify("wget https://x/file.tgz").pathArgs).toEqual(["."]);
    expect(classify("curl -O https://x/file.tgz").pathArgs).toEqual(["."]);
  });
});

describe("classifyCommandLine: project-declared commands", () => {
  const declared = [["./scripts/check.sh", "--all"], ["git", "push"]];

  it("allowlists a segment whose argv equals a declared command", () => {
    const r = classify("./scripts/check.sh   '--all'", declared);
    expect(r.allowlisted).toBe(true);
    expect(r.class).toBe("local-write");
  });

  it("does not match on a raw-string prefix", () => {
    expect(classify("./scripts/check.sh", declared).class).toBe("unknown");
    expect(classify("./scripts/check.sh --all --evil", declared).allowlisted).toBe(false);
  });

  it("never lets a declared command escape a hard class", () => {
    const r = classify("git push", declared);
    expect(r.class).toBe("remote-mutating");
    expect(r.allowlisted).toBe(false);
  });

  it("still applies the environment rule to declared commands", () => {
    expect(classify("FOO=1 ./scripts/check.sh --all", declared).class).toBe("unknown");
    expect(classify("CI=1 ./scripts/check.sh --all", declared).allowlisted).toBe(true);
  });
});

describe("classifyCommandLine: rule details", () => {
  const cases: [string, CommandClass][] = [
    ["git branch new-branch", "unknown"],
    ["git branch --list 'feat/x'", "read-only"],
    ["git tag", "read-only"],
    ["git tag -l v1", "read-only"],
    ["git tag v2", "unknown"],
    ["git fetch origin", "read-only"],
    ["git fetch --upload-pack=x origin", "unknown"],
    ["git log --output=x", "unknown"],
    ["git restore --staged a.ts", "local-write"],
    ["git restore --staged --worktree a.ts", "destructive"],
    ["git checkout -b feat/y", "local-write"],
    ["git checkout main", "destructive"],
    ["git stash push -m wip", "local-write"],
    ["git stash list", "read-only"],
    ["git stash clear", "destructive"],
    ["git update-ref -d refs/heads/x", "destructive"],
    ["git filter-branch", "destructive"],
    ["git push -f", "remote-mutating"],
    ["git --no-pager log", "read-only"],
    ["git --version", "read-only"],
    ["git switch -c x -f", "destructive"],
    ["git exec-path", "unknown"],
    ["npm --version", "read-only"],
    ["npm install", "unknown"],
    ["npm ci", "local-write"],
    ["yarn install --immutable", "local-write"],
    ["bun test", "local-write"],
    ["npm unpublish x", "remote-mutating"],
    ["npm deprecate x msg", "remote-mutating"],
    ["npm dist-tag add x@1 latest", "remote-mutating"],
    ["pnpm --filter x publish", "remote-mutating"],
    ["npm exec some-pkg", "unknown"],
    ["npm exec --no -- some-pkg", "unknown"],
    ["npx --no-install prettier --check .", "local-write"],
    ["npx --no-install prettier .", "unknown"],
    ["vitest run", "local-write"],
    ["jest --ci", "local-write"],
    ["tsc --noEmit", "local-write"],
    ["eslint .", "local-write"],
    ["prettier --write src", "local-write"],
    ["pytest -x", "local-write"],
    ["uv sync --frozen", "local-write"],
    ["uv sync", "unknown"],
    ["go test ./...", "local-write"],
    ["go test -exec x ./...", "unknown"],
    ["go build -o ../bin/x ./cmd", "local-write"],
    ["cargo clippy", "local-write"],
    ["cargo build --config x", "unknown"],
    ["make test", "local-write"],
    ["make deploy", "unknown"],
    ["make -f other.mk test", "unknown"],
    ["shred x", "destructive"],
    ["mkfs.ext4 /dev/sdb", "destructive"],
    ["chown u x", "destructive"],
    ["truncate -s 0 x", "destructive"],
    ["chmod 644 x", "unknown"],
    ["rm --no-preserve-root x", "destructive"],
    ["rm -fv x", "local-write"],
    ["rm --weird x", "unknown"],
    ["touch -d yesterday x", "unknown"],
    ["sed 's/a/b/' f", "unknown"],
    ["sed -i -e 's/a/b/' f", "local-write"],
    ["sed -i 's/a/b/;w x' f", "unknown"],
    ["sed -i '1d' f", "unknown"],
    ["gh api -X GET repos/o/r", "read-only"],
    ["gh api --method=PATCH repos/o/r", "remote-mutating"],
    ["gh api repos/o/r --input body.json", "remote-mutating"],
    ["gh auth status", "unknown"],
    ["gh release create v1", "remote-mutating"],
    ["curl -X DELETE https://x", "remote-mutating"],
    ["curl --data-raw x https://x", "remote-mutating"],
    ["curl -F a=b https://x", "remote-mutating"],
    ["curl -T f https://x", "remote-mutating"],
    ["curl --post301 https://x", "remote-mutating"],
    ["curl --config cfg https://x", "unknown"],
    ["curl -sSL https://x", "read-only"],
    ["curl -X GET https://x", "read-only"],
    ["curl --unknown-flag https://x", "unknown"],
    ["curl example.com", "unknown"],
    ["wget --method=PUT https://x", "remote-mutating"],
    ["wget --execute=x https://x", "unknown"],
    ["scp a host:b", "remote-mutating"],
    ["rsync -a a b", "unknown"],
    ["docker push img", "remote-mutating"],
    ["docker ps", "unknown"],
    ["kubectl delete pod x", "remote-mutating"],
    ["kubectl get pods", "unknown"],
    ["terraform destroy", "remote-mutating"],
    ["terraform plan", "unknown"],
    ["vercel", "remote-mutating"],
    ["netlify deploy", "remote-mutating"],
    ["fly deploy", "remote-mutating"],
    ["aws --version", "read-only"],
    ["gcloud --version", "read-only"],
    ["az login", "remote-mutating"],
    ["uniq in out", "unknown"],
    ["uniq -c in", "read-only"],
    ["fd -x rm", "unknown"],
    ["date -s now", "unknown"],
    ["file -C", "unknown"],
    ["tree -o out", "unknown"],
    ["jq -i . f", "unknown"],
    ["find . -fprint out", "unknown"],
    ["find . -ok rm ;", "unknown"],
    ["node app.js", "unknown"],
    ["node -p 1", "unknown"],
    ["bash script.sh", "unknown"],
    ["sh", "unknown"],
    ["perl -e 1", "unknown"],
    ["deno eval 1", "unknown"],
    ["timeout 5 ls", "unknown"],
    ["nohup ls", "unknown"],
    ["exec ls", "unknown"],
    ["source x", "unknown"],
    [". x", "unknown"],
    ["> out", "unknown"],
    ["/bin/ls", "unknown"],
    ["LS", "unknown"],
    ["ls.exe", "unknown"],
    ["/usr/bin/rm -rf x", "destructive"],
    ["TZ=UTC date", "read-only"],
    ["LANG=C LC_ALL=C NO_COLOR=1 FORCE_COLOR=0 TERM=dumb NODE_ENV=test ls", "read-only"],
    ["GIT_SSH_COMMAND=x git push", "unknown"],
    ["CI=1", "unknown"],
  ];
  for (const [cmd, expected] of cases) {
    it(`${JSON.stringify(cmd)} -> ${expected}`, () => {
      const r = classify(cmd);
      expect(r.class, r.reasons.join("; ")).toBe(expected);
    });
  }

  it("go build -o reports the output path", () => {
    expect(classify("go build -o ../bin/x ./cmd").pathArgs).toEqual(["../bin/x"]);
  });
});

describe("classifyCommandLine: link-preserving copies and moves before another segment (R28)", () => {
  it("a recursive or link-preserving cp followed by another segment is unknown", () => {
    for (const cp of ["cp -r evil out", "cp -R evil out", "cp -a evil out", "cp -rf evil out", "cp -P a b", "cp -s a b", "cp --recursive evil out", "cp --archive evil out", "cp --no-dereference a b", "cp --preserve=links a b"]) {
      for (const join of [" && ", "; ", " | ", "\n"]) {
        const c = classify(`${cp}${join}cat out/x`);
        expect(c.segments[0]?.class, `${cp}${JSON.stringify(join)}`).toBe("unknown");
        expect(c.reasons.join(" ")).toContain("R28");
        expect(c.allowlisted).toBe(false);
      }
    }
  });
  it("any mv followed by another segment is unknown (a directory or a symlink keeps its links)", () => {
    expect(classify("mv evil out && cat out/x").segments[0]?.class).toBe("unknown");
    expect(classify("mv a b; ls").segments[0]?.class).toBe("unknown");
  });
  it("is unchanged when the copy is the last segment, or is a plain dereferencing copy", () => {
    expect(classify("cp -r evil out").class).toBe("local-write");
    expect(classify("ls && cp -r evil out").class).toBe("local-write");
    expect(classify("mv a b").class).toBe("local-write");
    // R32 makes recursive dereferencing copies unknown on their own; a plain dereferencing copy stays.
    expect(classify("cp -L a.txt out && cat out/x").segments[0]?.class).toBe("local-write");
    expect(classify("cp a b && cat b").segments[0]?.class).toBe("local-write");
  });
  it("reports pathArgs, inputPaths and readArgs per segment", () => {
    const c = classify("cp a.txt out.txt && cat ./out.txt < in.txt > log.txt");
    expect(c.segments[0]!.pathArgs).toContain("out.txt");
    expect(c.segments[1]).toMatchObject({ pathArgs: ["log.txt"], inputPaths: ["in.txt"], readArgs: ["./out.txt"] });
  });
});

describe("classifyCommandLine: recursive copies that follow links (R32)", () => {
  it("a recursive cp with -L/--dereference is unknown even as the only segment", () => {
    for (const cp of ["cp -rL evil out2", "cp -RL evil out2", "cp -aL evil out2", "cp -r -L evil out2", "cp --recursive --dereference evil out2", "cp -r --deref evil out2"]) {
      const c = classify(cp);
      expect(c.class, cp).toBe("unknown");
      expect(c.reasons.join(" "), cp).toContain("R32");
    }
  });
  it("a non-recursive dereferencing copy keeps its class (its source argument is checked through its facts)", () => {
    expect(classify("cp -L link out").class).toBe("local-write");
  });
});
