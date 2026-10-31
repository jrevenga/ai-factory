import { writeFileSync } from "node:fs";
import ms from "ms";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const marker = process.env.SPIKE_MARKER;
    if (marker) {
      writeFileSync(
        marker,
        JSON.stringify({ loaded: true, nonce: process.env.SPIKE_NONCE, ms: ms("2h") }),
      );
    }
    pi.events.emit("factory:handshake", { version: "0.1.0" });
  });
}
