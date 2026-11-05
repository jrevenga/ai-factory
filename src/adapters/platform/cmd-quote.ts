// Serializer for arguments passed through `cmd.exe /d /s /c ""<exe>" <args>"` (Windows .cmd/.bat).
// Constrained on purpose (plan ruling 15): characters that cmd.exe or batch-file parsing would
// interpret are rejected instead of escaped. Pass paths through environment variables where possible.

export class UnsafeCmdArgument extends Error {
  readonly arg: string;
  constructor(arg: string) {
    super(
      `Refusing to pass ${JSON.stringify(arg)} through cmd.exe: arguments must not contain " % ! & | < > ^, CR or LF, or end with a backslash.`,
    );
    this.name = "UnsafeCmdArgument";
    this.arg = arg;
  }
}

const UNSAFE = /["%!&|<>^\r\n]/;
// Whitespace and the separators cmd.exe/batch parsing splits on.
const NEEDS_QUOTES = /[\s,;=()]/;

/** Throws UnsafeCmdArgument unless `value` can be placed inside double quotes on a cmd.exe line verbatim. */
export function assertCmdSafe(value: string): void {
  if (UNSAFE.test(value) || value.endsWith("\\")) throw new UnsafeCmdArgument(value);
}

export function quoteCmdArgs(args: string[]): string {
  return args
    .map((arg) => {
      assertCmdSafe(arg);
      return arg === "" || NEEDS_QUOTES.test(arg) ? `"${arg}"` : arg;
    })
    .join(" ");
}
