import { describe, expect, it } from "vitest";
import { quoteCmdArgs, UnsafeCmdArgument } from "../../../src/adapters/platform/cmd-quote.ts";

describe("quoteCmdArgs", () => {
  it("quotes arguments containing spaces and leaves others bare", () => {
    expect(quoteCmdArgs(["install", "C:\\a b\\x"])).toBe('install "C:\\a b\\x"');
    expect(quoteCmdArgs(["-g", "--prefix", "C:\\x"])).toBe("-g --prefix C:\\x");
  });

  it("quotes empty arguments and cmd delimiters", () => {
    expect(quoteCmdArgs([""])).toBe('""');
    expect(quoteCmdArgs(["a\tb", "k=v", "a,b", "a;b"])).toBe('"a\tb" "k=v" "a,b" "a;b"');
  });

  it.each(['a"b', "100%", "a!b", "a&b", "a|b", "a<b", "a>b", "a^b", "a\rb", "a\nb", "C:\\dir\\"])("throws on %j", (arg) => {
    let error: unknown;
    try {
      quoteCmdArgs(["ok", arg]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnsafeCmdArgument);
    expect((error as UnsafeCmdArgument).arg).toBe(arg);
  });
});
