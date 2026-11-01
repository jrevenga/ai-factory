import { z } from "zod";

export const STATE_DOCS = ["config.json", "state.json", "managed-settings.json"] as const;

export const ReleaseManifest = z.looseObject({
  schema: z.literal(1),
  factory: z.string(),
  source: z.looseObject({ git: z.string() }),
  stateSchemas: z.looseObject({
    "config.json": z.number().int().positive(),
    "state.json": z.number().int().positive(),
    "managed-settings.json": z.number().int().positive(),
  }),
  node: z.looseObject({ min: z.string() }),
  pi: z.looseObject({
    package: z.literal("@earendil-works/pi-coding-agent"),
    version: z.string(),
    supportedRange: z.string(),
  }),
  companions: z.looseObject({
    "pi-claude-bridge": z.looseObject({ source: z.string(), when: z.literal("claude") }),
  }),
  lockfileSha256: z.string(),
  reviewedInstallScripts: z.array(z.string()),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

export type Env = Readonly<Record<string, string | undefined>>;

/** The `FACTORY_SOURCE` override, or undefined when unset or empty (an empty value counts as unset, as for FACTORY_HOME). */
export function sourceOverride(env: Env): string | undefined {
  const v = env.FACTORY_SOURCE;
  return v === undefined || v === "" ? undefined : v;
}

export function effectiveSource(m: ReleaseManifest, env: Env): string {
  return sourceOverride(env) ?? m.source.git;
}

export function tagFor(version: string): string {
  return `v${version}`;
}

export function packageRef(m: ReleaseManifest, env: Env): string {
  return `git:${effectiveSource(m, env)}@${tagFor(m.factory)}`;
}

export function npmInstallSpec(m: ReleaseManifest, env: Env): string {
  return `git+${effectiveSource(m, env)}#${tagFor(m.factory)}`;
}
