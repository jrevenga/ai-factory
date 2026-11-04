// Writer gate (controller ruling R20): the first process of a bounded child started under the factory
// lock (POSIX). runBounded spawns `node writer-gate.mjs <cmd> <args…>` as the leader of a new process
// group, records that group next to the lock, and only then writes one authorisation byte on fd 3 (a
// dedicated duplex pipe; stdin stays the command's). Before authorisation nothing else runs: EOF or an
// error on fd 3 (the parent died or gave up) makes the gate exit without starting the command, so a
// parent killed between spawn and registration can never leave an unrecorded writer behind.
//
// After authorisation the gate starts the real command in its own process group (not detached), with
// the gate's stdin/stdout/stderr, reports "ok" or the spawn error back on fd 3, ignores INT/TERM/HUP
// (group-wide signals reach the command directly; teardown is always by group) and mirrors the
// command's end: the same exit code, or the same signal re-raised.
// usage: node writer-gate.mjs <cmd> [args…]   (fd 3: control pipe)
import { spawn } from "node:child_process";
import { Socket } from "node:net";

const [cmd, ...args] = process.argv.slice(2);
const control = new Socket({ fd: 3, readable: true, writable: true });
let authorised = false;
const refuse = () => {
  if (!authorised) process.exit(1);
};
control.on("end", refuse);
control.on("close", refuse);
control.on("error", refuse);
control.once("data", () => {
  authorised = true;
  control.pause();
  run();
});

function run() {
  if (cmd === undefined) {
    control.end(JSON.stringify({ error: { message: "writer gate: no command" } }), () => process.exit(1));
    return;
  }
  const child = spawn(cmd, args, { stdio: "inherit", shell: false });
  const ignore = () => {};
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  child.once("spawn", () => {
    for (const sig of signals) process.on(sig, ignore);
    control.end("ok");
  });
  child.once("error", (e) => {
    control.end(JSON.stringify({ error: { code: e.code, message: e.message } }), () => process.exit(1));
  });
  child.once("exit", (code, signal) => {
    for (const sig of signals) process.off(sig, ignore);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
