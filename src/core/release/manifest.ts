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

/**
 * A source URL that embeds credentials (M3): they would be printed, stored in state.json and written into
 * Pi's package refs. Its message never repeats the URL.
 */
export class CredentialsInSourceUrl extends Error {
  constructor(what: string) {
    super(
      `${what} embeds credentials in its URL (user:password@ or token@), which would be printed and stored in the factory state and Pi settings. ` +
        `Remove them from the URL and let Git supply them: configure a Git credential helper (git config --global credential.helper <helper>, e.g. manager, osxkeychain or libsecret), or use an SSH URL.`,
    );
    this.name = "CredentialsInSourceUrl";
  }
}

/** True for an http(s) URL (also `git+http(s)`) with a user name or password, or any URL with a password. */
export function hasEmbeddedCredentials(url: string): boolean {
  const trimmed = url.trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    if (parsed.password !== "") return true;
    return /^(?:git\+)?https?:$/i.test(parsed.protocol) && parsed.username !== "";
  }
  // Not parseable as a URL: still refuse anything shaped like http(s)://<userinfo>@host.
  return /^(?:git\+)?https?:\/\/[^/?#]*@/i.test(trimmed);
}

/** The source this release installs from; refuses one with embedded credentials (CredentialsInSourceUrl). */
export function effectiveSource(m: ReleaseManifest, env: Env): string {
  const override = sourceOverride(env);
  const source = override ?? m.source.git;
  if (hasEmbeddedCredentials(source)) throw new CredentialsInSourceUrl(override === undefined ? "release.json source.git" : "FACTORY_SOURCE");
  return source;
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
