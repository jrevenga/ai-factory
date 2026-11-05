// node:sqlite is still flagged experimental on the supported Node versions; hide only that notice and
// pass every other warning through untouched.
export function installWarningFilter(proc) {
  const emitWarning = proc.emitWarning;
  proc.emitWarning = function (warning, ...args) {
    const first = args[0];
    const type = typeof first === "string" ? first : (first?.type ?? warning?.name);
    const message = typeof warning === "string" ? warning : (warning?.message ?? "");
    if (type === "ExperimentalWarning" && /SQLite/.test(message)) return;
    return emitWarning.call(proc, warning, ...args);
  };
}
