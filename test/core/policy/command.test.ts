import { describe, expect, it } from "vitest";
import { classifyCommandLine, extractReadArgs, isPathLikeArg, severity, type CommandClass } from "../../../src/core/policy/command.ts";
import { GIT_READ_GRAMMARS, type Grammar } from "../../../src/core/policy/command-rules.ts";
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
      const f = entry.facts;
      if (f === undefined) return;
      if (f.pathArgs) expect(r.pathArgs, "pathArgs").toEqual(f.pathArgs);
      if (f.inputPaths) expect(r.inputPaths, "inputPaths").toEqual(f.inputPaths);
      if (f.readArgs) expect(r.readArgs, "readArgs").toEqual(f.readArgs);
      if (f.logicalPaths) expect(r.logicalPaths, "logicalPaths").toEqual(f.logicalPaths);
      if (f.trackedContent !== undefined) expect(r.trackedContent, "trackedContent").toBe(f.trackedContent);
      if (f.nonDirPaths) expect(r.segments.flatMap((s) => s.nonDirPaths ?? []), "nonDirPaths").toEqual(f.nonDirPaths);
    });
  }

  it("covers every review finding with facts or a gate outcome (fix round 4)", () => {
    expect(GATE_CORPUS.filter((e) => e.gate !== undefined).length).toBeGreaterThanOrEqual(40);
    expect(GATE_CORPUS.filter((e) => e.facts !== undefined).length).toBeGreaterThanOrEqual(40);
  });
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
    expect(classify("head -n 5 ~/.aws/credentials x").readArgs).toEqual(["~/.aws/credentials", "x"]);
    // R40: `-n` takes a count, so its value is not a file (the old fixture `head -n <secret>` was not a read).
    expect(classify("head -n ~/.aws/credentials x").readArgs).toEqual(["x"]);
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

  it("reports git -C directories as read paths (R24); git -C is unknown (R41)", () => {
    const r = classify("git -C ../other status");
    expect(r.class).toBe("unknown");
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
    ["touch -d yesterday x", "local-write"],
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

describe("classifyCommandLine: staging that can sweep secrets (R37)", () => {
  it("git add with -A/--all/-u/--update, `.`, a trailing-slash directory, no pathspec, pathspec magic or an unlisted option is unknown", () => {
    for (const cmd of [
      "git add -A",
      "git add --all",
      "git add -u",
      "git add --update",
      "git add -Av a.ts",
      "git add .",
      "git add ./",
      "git add -- .",
      "git add src/",
      "git add ..",
      "git add",
      "git add -v",
      "git add ':(glob)src'",
      "git add :/",
      "git add --renormalize a.ts",
      "git add --no-ignore-removal a.ts",
      "git add -e a.ts",
    ]) {
      const c = classify(cmd);
      expect(c.class, cmd).toBe("unknown");
      expect(c.allowlisted, cmd).toBe(false);
    }
  });

  it("git add of explicit file paths stays an allowlisted local write and reports every path as an input path", () => {
    for (const [cmd, paths] of [
      ["git add a.ts", ["a.ts"]],
      ["git add -v src/a.ts b.md", ["src/a.ts", "b.md"]],
      ["git add -- -odd.ts", ["-odd.ts"]],
      ["git add -N new.ts", ["new.ts"]],
      ["git add .env", [".env"]],
    ] as const) {
      const c = classify(cmd);
      expect(c.class, cmd).toBe("local-write");
      expect(c.allowlisted, cmd).toBe(true);
      expect(c.inputPaths, cmd).toEqual(paths);
      expect(c.segments[0]!.stagePaths, cmd).toEqual(paths);
    }
  });

  it("git commit with -a/--all, with pathspecs or with an unlisted option is unknown; a plain commit stays allowlisted", () => {
    for (const cmd of ["git commit -a -m x", "git commit -am x", "git commit --all -m x", "git commit -m x a.ts", "git commit -m x -- a.ts", "git commit -F msg.txt", "git commit -m x -i a.ts"]) {
      expect(classify(cmd).class, cmd).toBe("unknown");
    }
    for (const cmd of ['git commit -m "feat: x"', "git commit -q -m x", "git commit --allow-empty -m x --no-verify", "git commit -qm x", "git commit --message=x -s"]) {
      const c = classify(cmd);
      expect(c.class, cmd).toBe("local-write");
      expect(c.allowlisted, cmd).toBe(true);
    }
    expect(classify("git commit --amend -m x").class).toBe("destructive");
  });

  it("git stash with -u/--include-untracked/-a/--all is unknown; git stash push -m stays allowlisted", () => {
    for (const cmd of ["git stash push -u", "git stash push --include-untracked", "git stash push -a", "git stash push --all", "git stash push -um wip"]) {
      expect(classify(cmd).class, cmd).toBe("unknown");
    }
    expect(classify("git stash push -m wip")).toMatchObject({ class: "local-write", allowlisted: true });
  });
});

describe("classifyCommandLine: option grammar (R40)", () => {
  // One unmodelled option per allowlisted program or git subcommand: each must be `unknown`, never allowlisted.
  const families = [
    "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "grep x", "fd x", "tree", "pwd", "which", "whereis", "type",
    "file", "stat", "du", "df", "printf", "true", "false", "basename", "dirname", "realpath", "readlink", "date", "sleep",
    "diff", "cmp", "jq .", "find .", "git status", "git log", "git diff", "git show", "git rev-parse", "git ls-files", "git blame",
    "git describe", "git fetch", "git stash push", "git restore --staged", "git commit -m x", "git add", "git branch", "git tag",
    "git config --get", "git remote", "cp a", "mv a", "mkdir", "touch", "tee", "rm", "rmdir", "sed -i", "curl https://x",
    "wget https://x", "gh api", "vitest", "jest", "tsc", "eslint", "prettier --check", "pytest", "go test", "cargo test",
    "uv run pytest", "npx --no-install vitest", "npm exec --no -- jest",
  ];
  for (const fam of families) {
    it(`${fam} with an unmodelled option is unknown`, () => {
      const r = classify(`${fam} --zz-unmodelled b`);
      expect(r.class, r.reasons.join("; ")).toBe("unknown");
      expect(r.allowlisted).toBe(false);
    });
  }

  it("parses short bundles letter by letter: a value option takes the rest of the bundle or the next word", () => {
    expect(classify("du -sX auth .").readArgs).toEqual(["auth", "."]);
    expect(classify("du -sXauth .").readArgs).toEqual(["auth", "."]);
    expect(classify("du --exclude-from=auth .").readArgs).toEqual(["auth", "."]);
    expect(classify("du --exclude-from auth .").readArgs).toEqual(["auth", "."]);
    expect(classify("git ls-files -z -X auth").readArgs).toEqual(["auth"]);
    expect(classify("ls -la src").readArgs).toEqual(["src"]);
    expect(classify("ls -l -- -a").readArgs).toEqual(["-a"]);
  });

  it("an unmodelled letter anywhere in a bundle is unknown", () => {
    for (const cmd of ["ls -laj", "cat -nQ x", "wc -lO x", "diff -qj a b", "git ls-files -zQ"]) expect(classify(cmd).class, cmd).toBe("unknown");
  });

  it("a value option without its value is unknown", () => {
    for (const cmd of ["head -n", "sort -k", "du -X", "git log -n"]) expect(classify(cmd).class, cmd).toBe("unknown");
  });

  it("-- ends options: later dash-prefixed words are operands and count toward limits", () => {
    expect(classify("uniq -- -a").class).toBe("read-only");
    expect(classify("uniq -- -a -b").class).toBe("unknown");
    expect(classify("tr -- -a").readArgs).toEqual([]);
    expect(classify("cat -- --zz").readArgs).toEqual(["--zz"]);
  });

  it("opaque values and opaque operands are not read facts", () => {
    expect(classify("echo ~/.aws/credentials").readArgs).toEqual([]);
    expect(classify("basename /h/.aws/credentials").readArgs).toEqual([]);
    expect(classify("grep -e a/b src/x.ts").readArgs).toEqual(["src/x.ts"]);
    expect(classify("grep a/b src/x.ts").readArgs).toEqual(["src/x.ts"]);
    expect(classify("tr a/ b/").readArgs).toEqual([]);
  });

  it("an option after the first operand is still reported as a possible file (POSIX option order)", () => {
    expect(classify("cat a.txt -n").readArgs).toEqual(["a.txt", "-n"]);
    expect(classify("head x -n 5").readArgs).toEqual(["x", "-n", "5"]);
  });

  it("write commands reject an option after an operand (it would be a write target under POSIX option order)", () => {
    for (const cmd of ["cp a b -f", "mv a b -f", "mkdir a -p", "touch a -c", "tee a -a", "rm a -f", "rmdir a -p"]) {
      expect(classify(cmd).class, cmd).toBe("unknown");
    }
    expect(classify("cp -f a b").class).toBe("local-write");
  });

  it("read-path option values become read facts", () => {
    expect(classify("date -r ~/.aws/credentials").readArgs).toEqual(["~/.aws/credentials"]);
    expect(classify("grep --exclude-from=pats x a.txt").readArgs).toEqual(["pats", "a.txt"]);
    expect(classify("find . -newer ~/.aws/credentials").readArgs).toEqual([".", "~/.aws/credentials"]);
    expect(classify("realpath --relative-to=/h/x y").readArgs).toEqual(["/h/x", "y"]);
  });

  it("go flags use single-dash long names", () => {
    expect(classify("go test -run TestX -count=1 ./...").class).toBe("local-write");
    expect(classify("go test -exec=x ./...").class).toBe("unknown");
    expect(classify("go test -toolexec x ./...").class).toBe("unknown");
    expect(classify("go build -o=bin/x ./cmd").pathArgs).toEqual(["bin/x"]);
  });

  it("runner options that write files outside the project are unknown", () => {
    for (const cmd of [
      "vitest run --outputFile=../x.json",
      "jest --outputFile ../x.json",
      "eslint -o ../x.txt .",
      "tsc --outDir ../x",
      "pytest --junitxml=../x.xml",
      "prettier --check --cache-location=../x .",
      "cargo build --target-dir ../x",
      "cargo test -- --logfile ../x",
    ]) {
      expect(classify(cmd).class, cmd).toBe("unknown");
    }
  });

  it("eslint --fix and prettier --write report their operands as writes that must be files (R43)", () => {
    const e = classify("eslint --fix src/a.ts");
    expect(e.pathArgs).toEqual(["src/a.ts"]);
    expect(e.segments[0]!.nonDirPaths).toEqual(["src/a.ts"]);
    expect(classify("prettier --write src").segments[0]!.nonDirPaths).toEqual(["src"]);
  });
});

describe("classifyCommandLine: git content (R41)", () => {
  it("reports logical paths for rev:path, :path, :N:path and -L forms", () => {
    expect(classify("git show HEAD^:config/.env").logicalPaths).toEqual(["config/.env"]);
    expect(classify("git show main:./a/b").logicalPaths).toEqual(["./a/b"]);
    expect(classify("git log -L :fn:src/a.ts").logicalPaths).toEqual(["src/a.ts"]);
    expect(classify("git diff HEAD -- .env").logicalPaths).toEqual(["HEAD", ".env"]);
  });

  it("flags content-printing git commands only", () => {
    for (const cmd of ["git diff", "git diff --cached", "git show", "git log -p", "git log --patch", "git log -S x", "git log -G x", "git log --cc", "git log -u", "git blame a.ts", "git status -v"]) {
      expect(classify(cmd).trackedContent, cmd).toBe(true);
    }
    for (const cmd of ["git status", "git log --oneline", "git log --stat", "git rev-parse HEAD", "git ls-files", "git describe --tags", "ls"]) {
      expect(classify(cmd).trackedContent, cmd).toBe(false);
    }
  });

  it("git -C stays a hard class when the subcommand is one, and is unknown otherwise", () => {
    expect(classify("git -C ../x push").class).toBe("remote-mutating");
    expect(classify("git -C ../x reset --hard").class).toBe("destructive");
    expect(classify("git -C ../x log").class).toBe("unknown");
  });

  it("git fetch accepts remote and branch names only (no refspec writes, no URLs)", () => {
    expect(classify("git fetch origin main").class).toBe("read-only");
    expect(classify("git fetch --prune origin").class).toBe("read-only");
    expect(classify("git fetch origin main:main").class).toBe("unknown");
    expect(classify("git fetch https://h/r").class).toBe("unknown");
  });
});

describe("classifyCommandLine: gh api read grammar (R40)", () => {
  it("allows GET options and keeps mutations remote", () => {
    expect(classify("gh api repos/o/r --jq .name").class).toBe("read-only");
    expect(classify("gh api --paginate repos/o/r/pulls").class).toBe("read-only");
    expect(classify("gh api repos/o/r --zz").class).toBe("unknown");
    expect(classify("gh api -f a=b repos/o/r").class).toBe("remote-mutating");
  });
});

describe("classifyCommandLine: fix round 5 (R45-R47)", () => {
  // N1: every git diff/log/show option that takes a separate value, followed by --no-index (git pre-scans argv).
  const valued = (g: Grammar) => [
    ...Object.entries(g.short ?? {}).filter(([, k]) => typeof k === "string" && k !== "flag" && k !== "opt-opaque").map(([c]) => `-${c}`),
    ...Object.entries(g.long ?? {}).filter(([, k]) => typeof k === "string" && k !== "flag" && k !== "opt-opaque").map(([n]) => n),
  ];
  for (const sub of ["diff", "log", "show"]) {
    const opts = valued(GIT_READ_GRAMMARS[sub]!);
    it(`git ${sub}: --no-index as the separate value of any option is unknown (${opts.length} options)`, () => {
      expect(opts.length).toBeGreaterThan(10);
      for (const o of [...opts, "-U", "--unified"]) {
        const r = classify(`git ${sub} ${o} --no-index a b`);
        expect(r.class, `${o}: ${r.reasons.join("; ")}`).toBe("unknown");
      }
    });
  }

  it("R45: raw-scanned git options are unknown anywhere, without lowering a hard class", () => {
    for (const cmd of [
      "git diff --no-index=x a b",
      "git status --no-index",
      "git log -- --no-index",
      "git log --end-of-options HEAD",
      "git log --literal-pathspecs",
      "git log --glob-pathspecs",
      "git log --noglob-pathspecs",
      "git log --icase-pathspecs",
      "git log --grep x --git-dir=y",
      "git log --work-tree x",
      "git show --exec-path=x",
      "git log --config-env=a=B",
    ]) {
      expect(classify(cmd).class, cmd).toBe("unknown");
    }
    expect(classify("git push --no-index").class).toBe("remote-mutating");
    expect(classify("git reset --hard --end-of-options").class).toBe("destructive");
  });

  it("N2: -U/--unified never consume the next word", () => {
    expect(classify("git show -U HEAD:.env").logicalPaths).toEqual([".env"]);
    expect(classify("git diff --unified HEAD:.env HEAD:notes.txt").logicalPaths).toEqual([".env", "notes.txt"]);
    expect(classify("git log -U -1").class).toBe("read-only");
    expect(classify("git log -U -1").trackedContent).toBe(true);
    expect(classify("git diff -pU3 HEAD").logicalPaths).toEqual(["HEAD"]);
  });

  it("N3: --check makes git log content-printing", () => {
    expect(classify("git log --check").trackedContent).toBe(true);
    expect(classify("git log --oneline --check -3").trackedContent).toBe(true);
  });

  it("stat-only diff and show print no content; any content option or blob-capable show operand does", () => {
    for (const cmd of ["git show --stat", "git show --numstat HEAD", "git show --shortstat HEAD^2", "git show --name-status main^", "git diff --stat HEAD^", "git diff --name-only -- src", "git show --stat -- src"]) {
      expect(classify(cmd), cmd).toMatchObject({ class: "read-only", trackedContent: false });
    }
    for (const cmd of ["git show --stat main", "git show --stat -u", "git diff --stat --patch-with-stat", "git show --name-only --word-diff", "git diff --stat -U1"]) {
      expect(classify(cmd), cmd).toMatchObject({ class: "read-only", trackedContent: true });
    }
  });

  it("R46: backup-writing options are unknown; plain sed -i keeps its rule", () => {
    for (const cmd of ["cp -S x a b", "cp -bf a b", "cp --backup a b", "mv -S x a b", "mv --backup=simple a b", "mv --suffix=x a b", "sed -i.orig s/a/b/ f", "sed -ibak s/a/b/ f", "sed --in-place=.b s/a/b/ f"]) {
      expect(classify(cmd).class, cmd).toBe("unknown");
    }
    expect(classify("sed -i s/a/b/ f").class).toBe("local-write");
    expect(classify("sed --in-place s/a/b/ f").class).toBe("local-write");
  });

  it("R47: git fetch takes a remote name (no path, dot or URL) first, reported for the directory check", () => {
    for (const cmd of ["git fetch ../x", "git fetch /x", "git fetch ~/x", "git fetch .", "git fetch x.bundle", "git fetch file:///x", "git fetch -- ../x", "git fetch origin ../x"]) {
      expect(classify(cmd).class, cmd).toBe("unknown");
    }
    const r = classify("git fetch upstream main");
    expect(r.class).toBe("read-only");
    expect(r.segments[0]!.nonDirPaths).toEqual(["upstream"]);
    expect(classify("git fetch --prune").class).toBe("read-only");
  });

  it("R48: git show --stat with a ref selector option prints content; with HEAD it does not", () => {
    for (const sel of ["--tags", "--branches", "--remotes", "--all", "--glob=refs/*", "--exclude=x", "--reflog", "--stdin", "--walk-reflogs", "--bisect", "--alternate-refs", "--indexed-objects", "--single-worktree"]) {
      const r = classify(`git show --stat ${sel}`);
      expect(r.class === "read-only" ? r.trackedContent : true, sel).toBe(true);
    }
    expect(classify("git show --stat --tags")).toMatchObject({ class: "read-only", trackedContent: true });
    expect(classify("git show --stat HEAD")).toMatchObject({ class: "read-only", trackedContent: false });
  });

  it("R48: git fetch reports <name>, <name>.git and <name>.bundle as entries that must not exist", () => {
    expect(classify("git fetch backup").segments[0]!.absentPaths).toEqual(["backup", "backup.git", "backup.bundle"]);
    expect(classify("git fetch origin").class).toBe("read-only");
  });

  it("echo prints unknown options as text", () => {
    expect(classify("echo --zz-unmodelled b").class).toBe("read-only");
    expect(classify("echo -e --x").readArgs).toEqual([]);
  });
});
