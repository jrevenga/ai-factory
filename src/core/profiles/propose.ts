import type { Profile } from "./schema.ts";

export type LoginState = "present" | "absent" | "invalid" | "unknown";

const PREFERENCE = ["claude-codex", "codex-only"];
const rank = (p: Profile): number => {
  const i = PREFERENCE.indexOf(p.name);
  return i === -1 ? PREFERENCE.length : i;
};

/** First profile (claude-codex preferred) whose required providers are all logged in. */
export function proposeProfile(
  logins: { claude: LoginState; codex: LoginState },
  profiles: Profile[],
): Profile | undefined {
  return [...profiles]
    .sort((a, b) => rank(a) - rank(b))
    .find((p) => p.requires.every((r) => logins[r] === "present"));
}
