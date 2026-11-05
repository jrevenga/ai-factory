// Contender ids, profile baselines, provider mapping and the pinned tool versions (Phase 3 rulings 4, 6, 13).
import { z } from "zod";
import type { Profile } from "../profiles/schema.ts";

export const PROVIDER_IDS = ["claude", "codex"] as const;
export const ProviderId = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderId>;

export const CONTENDER_IDS = [
  "claude-code",
  "claude-code-superpowers",
  "pi-bridge",
  "codex",
  "codex-superpowers",
  "pi-codex",
  "oracle",
  "noop",
] as const;
export const ContenderId = z.enum(CONTENDER_IDS);
export type ContenderId = z.infer<typeof ContenderId>;

export const PROFILE_NAMES = ["claude-codex", "codex-only"] as const;
export const ProfileName = z.enum(PROFILE_NAMES);
export type ProfileName = z.infer<typeof ProfileName>;

const BASELINES: Record<ProfileName, readonly ContenderId[]> = {
  "claude-codex": ["claude-code", "claude-code-superpowers", "pi-bridge"],
  "codex-only": ["codex", "codex-superpowers", "pi-codex"],
};

/** The baselines compared against the factory for a profile, in report order (ruling 6). */
export function baselinesFor(profile: ProfileName): ContenderId[] {
  return [...BASELINES[profile]];
}

/** The reference contender of a profile: the plain CLI (ruling 14). */
export function referenceContender(profile: ProfileName): ContenderId {
  return BASELINES[profile][0] as ContenderId;
}

/** The provider whose usage a contender is expected to report; `null` for the non-model contenders (ruling 13). */
export function expectedProvider(contender: ContenderId): ProviderId | null {
  switch (contender) {
    case "claude-code":
    case "claude-code-superpowers":
    case "pi-bridge":
      return "claude";
    case "codex":
    case "codex-superpowers":
    case "pi-codex":
      return "codex";
    default:
      return null;
  }
}

/** The implementer model with its `provider/` prefix stripped, as the CLIs take it (ruling 6). */
export function baselineModel(profile: Profile): string {
  const model = profile.roles.implementer.model;
  const slash = model.indexOf("/");
  return slash < 0 ? model : model.slice(slash + 1);
}

const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);

/** `evals/contenders.json`. */
export const ContenderPins = z.strictObject({
  schema: z.literal(1),
  claude: z.strictObject({ version: z.string().min(1) }),
  codex: z.strictObject({ version: z.string().min(1) }),
  superpowers: z.strictObject({ git: z.string().min(1), tag: z.string().min(1), version: z.string().min(1) }),
});
export type ContenderPins = z.infer<typeof ContenderPins>;

/** `tools/superpowers.lock.json`, written by `factory eval setup`. */
export const ToolsLock = z.strictObject({
  schema: z.literal(1),
  superpowers: z.strictObject({ tag: z.string().min(1), commit: Sha40 }),
  bridge: z.strictObject({ version: z.string().min(1) }),
});
export type ToolsLock = z.infer<typeof ToolsLock>;
