import { describe, expect, it } from "vitest";
import { redact, summarizeCommand } from "../../../src/core/policy/redact.ts";

describe("redact", () => {
  it("replaces each secret pattern", () => {
    expect(redact("x ghp_abcdefghijklmnopqrstuvwxyz0123456789 y")).toBe("x *** y");
    for (const p of ["gho_", "ghu_", "ghs_"]) {
      expect(redact(`${p}abcdefghijklmnopqrstuvwxyz0123`)).toBe("***");
    }
    expect(redact("github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz")).toBe("***");
    expect(redact("key sk-ant-api03-abcDEF_123-xyz end")).toBe("key *** end");
    expect(redact("sk-abcdefghijklmnopqrstuvwxyz123456")).toBe("***");
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe("***");
    expect(redact("xoxb-123456-abcdef-ghij")).toBe("***");
    expect(redact("xoxp-1-2-3")).toBe("***");
    expect(redact("Authorization: Bearer abc.DEF-123_x==")).toBe("Authorization: Bearer ***");
    expect(redact("a\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\nb")).toBe("a\n***\nb");
    expect(redact("-----BEGIN PRIVATE KEY-----\nzz\n-----END PRIVATE KEY-----")).toBe("***");
    expect(redact("https://u:p@host/x")).toBe("https://***@host/x");
    expect(redact("git clone https://user:s3cr3t@example.com/r.git")).toBe("git clone https://***@example.com/r.git");
  });

  it("redacts key=value style assignments but keeps the key", () => {
    expect(redact("password=hunter2")).toBe("password=***");
    expect(redact("PASSWD: hunter2 rest")).toBe("PASSWD: *** rest");
    expect(redact("secret = abc")).toBe("secret = ***");
    expect(redact("API_KEY=zzz")).toBe("API_KEY=***");
    expect(redact("api-key: zzz")).toBe("api-key: ***");
    expect(redact("token=abc && ls")).toBe("token=*** && ls");
  });

  it("leaves normal text untouched", () => {
    const s = "npm run test -- --grep 'sky-high' src/a.ts at http://host/path?q=1 sk-short";
    expect(redact(s)).toBe(s);
    expect(redact("the password policy is strict")).toBe("the password policy is strict");
  });
});

describe("redact: prefixed and structured keys", () => {
  it("catches keywords inside longer names", () => {
    expect(redact("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=***");
    expect(redact("NPM_TOKEN=npm_xyz")).toBe("NPM_TOKEN=***");
    expect(redact("GITHUB_TOKEN=abc123")).toBe("GITHUB_TOKEN=***");
    expect(redact("MY_API_KEY=zzz")).toBe("MY_API_KEY=***");
    expect(redact("AWS_SECRET_ACCESS_KEY=abc/def+g")).toBe("AWS_SECRET_ACCESS_KEY=***");
    expect(redact("export X_TOKEN2=abc ok")).toBe("export X_TOKEN2=*** ok");
  });
  it("handles flags, JSON and extra credential shapes", () => {
    expect(redact("cli --password hunter2 --x")).toBe("cli --password *** --x");
    expect(redact("cli --token abc123")).toBe("cli --token ***");
    expect(redact("cli --api-key=abc")).toBe("cli --api-key=***");
    expect(redact('{"password": "x y", "n": 1}')).toBe('{"password": "***", "n": 1}');
    expect(redact('{"apiKey":"abc"}')).toBe('{"apiKey":"***"}');
    expect(redact("authorization: bearer abc.def")).toBe("authorization: Bearer ***");
    expect(redact("https://u:p@ss@host/x")).toBe("https://***@host/x");
    expect(redact("https://:pw@host/x")).toBe("https://***@host/x");
    expect(redact("-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----")).toBe("***");
  });
  it("does not touch plain URLs with ports or ssh users", () => {
    expect(redact("http://host:8080/x@y")).toBe("http://host:8080/x@y");
    expect(redact("ssh://git@host:22/r")).toBe("ssh://git@host:22/r");
  });
});

describe("redact: documented over-redaction", () => {
  it("lets key=value cross a newline", () => {
    expect(redact("token:\nvalue next")).toBe("token:\n*** next");
  });
  it("masks everything after an unterminated private key header", () => {
    expect(redact('grep "-----BEGIN RSA PRIVATE KEY-----" f && echo done')).toBe('grep "***');
  });
});

describe("summarizeCommand", () => {
  it("redacts, collapses whitespace and truncates to 500", () => {
    expect(summarizeCommand("echo   a\n\t b  ")).toBe("echo a b");
    expect(summarizeCommand("curl -H 'Authorization: Bearer abc123' x")).toBe("curl -H 'Authorization: Bearer ***' x");
    expect(summarizeCommand("x".repeat(600))).toHaveLength(500);
    expect(summarizeCommand("TOKEN=abc " + "y".repeat(600))).toMatch(/^TOKEN=\*\*\* y+$/);
  });
  it("does not leave a lone surrogate at the cut", () => {
    const out = summarizeCommand("a".repeat(499) + "\u{1F600}" + "b");
    expect(out).toBe("a".repeat(499));
    expect(summarizeCommand("a".repeat(498) + "\u{1F600}b")).toBe("a".repeat(498) + "\u{1F600}");
  });
});
