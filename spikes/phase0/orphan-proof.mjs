// Proof for the Ctrl+C race: the direct child exits at once (streams closed) while a descendant that ignores
// SIGTERM stays alive. The parent must exit on SIGINT only after that descendant is gone.
// usage: node spikes/phase0/orphan-proof.mjs   (run via sigint-orphan-proof.sh, which sends SIGINT)
import { spawnBounded } from "./pi.mjs";

const stamp = () => new Date().toISOString().slice(11, 23);
// The descendant has stdio redirected away from the parent's pipes, so 'close' fires immediately.
const script = `(trap "" TERM; exec sleep 300) >/dev/null 2>&1 </dev/null & exit 0`;
console.log(`${stamp()} start`);
const r = await spawnBounded("/bin/sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] }, {});
console.log(`${stamp()} runner resolved: code=${r.code} orphans=${r.orphans}`);
