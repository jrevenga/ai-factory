// The CLI's only window to the terminal, injectable so commands are testable without a TTY.
import { createInterface } from "node:readline/promises";

export interface CliIO {
  out(s: string): void;
  err(s: string): void;
  /** Asks a yes/no question; without a TTY it answers false. */
  confirm(question: string): Promise<boolean>;
  isTTY: boolean;
}

export function defaultIO(): CliIO {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    out: (s) => void process.stdout.write(s.endsWith("\n") ? s : `${s}\n`),
    err: (s) => void process.stderr.write(s.endsWith("\n") ? s : `${s}\n`),
    isTTY,
    async confirm(question) {
      if (!isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
  };
}
