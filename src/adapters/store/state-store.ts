// Reading and writing the factory's own documents under FACTORY_HOME, and the shipped profiles.
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { PersonalConfig } from "../../core/config/schema.ts";
import { Profile } from "../../core/profiles/schema.ts";
import { STATE_DOCS } from "../../core/release/manifest.ts";
import { ManagedRecord } from "../../core/settings/managed.ts";
import { FactoryState, schemaOf, type StateDoc } from "../../core/state/schema.ts";
import { MalformedJson, readJson, writeJsonAtomic } from "../platform/json-file.ts";
import type { FactoryPaths } from "../platform/paths.ts";

/** On-disk location of a state document. */
export function stateDocPath(paths: FactoryPaths, doc: StateDoc): string {
  switch (doc) {
    case "config.json":
      return paths.config;
    case "state.json":
      return paths.state;
    case "managed-settings.json":
      return paths.managedSettings;
  }
}

async function readParsed<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | undefined> {
  const raw = await readJson(path);
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new MalformedJson(path, new Error(parsed.error.message));
  return parsed.data;
}

async function writeParsed<S extends z.ZodType>(paths: FactoryPaths, path: string, schema: S, value: z.infer<S>): Promise<void> {
  const parsed = schema.parse(value);
  await mkdir(paths.home, { recursive: true });
  await writeJsonAtomic(path, parsed);
}

export function readState(paths: FactoryPaths): Promise<FactoryState | undefined> {
  return readParsed(paths.state, FactoryState);
}

export function writeState(paths: FactoryPaths, state: FactoryState): Promise<void> {
  return writeParsed(paths, paths.state, FactoryState, state);
}

export function readPersonalConfig(paths: FactoryPaths): Promise<PersonalConfig | undefined> {
  return readParsed(paths.config, PersonalConfig);
}

export function writePersonalConfig(paths: FactoryPaths, config: PersonalConfig): Promise<void> {
  return writeParsed(paths, paths.config, PersonalConfig, config);
}

/** Every `*.json` profile in `dir`, in file-name order. An invalid profile throws naming its file. */
export async function loadProfiles(dir: string): Promise<Profile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  const out: Profile[] = [];
  for (const name of names) {
    const profile = await readParsed(join(dir, name), Profile);
    if (profile !== undefined) out.push(profile);
  }
  return out;
}

/** The `schema` of each present state document. A present document without an integer `schema` is malformed. */
export async function docSchemas(paths: FactoryPaths): Promise<Partial<Record<StateDoc, number>>> {
  const out: Partial<Record<StateDoc, number>> = {};
  for (const doc of STATE_DOCS) {
    const path = stateDocPath(paths, doc);
    const raw = await readJson(path);
    if (raw === undefined) continue;
    const schema = schemaOf(raw);
    if (schema === undefined) throw new MalformedJson(path, new Error("missing integer \"schema\" field"));
    out[doc] = schema;
  }
  return out;
}

/** This CLI's reader of each state document. */
const READERS: Record<StateDoc, z.ZodType> = {
  "config.json": PersonalConfig,
  "state.json": FactoryState,
  "managed-settings.json": ManagedRecord,
};

export interface StateDocProblem {
  doc: StateDoc;
  path: string;
  detail: string;
}

export interface StateDocsInspection {
  /** The `schema` of each present document that has one. */
  schemas: Partial<Record<StateDoc, number>>;
  problems: StateDocProblem[];
}

/**
 * Checks every present state document without changing anything: it must be JSON with an integer
 * `schema`, and a document at the schema this CLI reads (`readable`) must pass this CLI's real reader.
 * A document at another schema is only reported in `schemas`; callers decide what that means.
 */
export async function inspectStateDocs(paths: FactoryPaths, readable: Record<StateDoc, number>): Promise<StateDocsInspection> {
  const schemas: Partial<Record<StateDoc, number>> = {};
  const problems: StateDocProblem[] = [];
  for (const doc of STATE_DOCS) {
    const path = stateDocPath(paths, doc);
    let raw: unknown;
    try {
      raw = await readJson(path);
    } catch (e) {
      if (!(e instanceof MalformedJson)) throw e;
      problems.push({ doc, path, detail: `it is not valid JSON (${(e.cause as Error).message})` });
      continue;
    }
    if (raw === undefined) continue;
    const schema = schemaOf(raw);
    if (schema === undefined) {
      problems.push({ doc, path, detail: 'it has no integer "schema" field' });
      continue;
    }
    schemas[doc] = schema;
    if (schema !== readable[doc]) continue;
    const parsed = READERS[doc].safeParse(raw);
    if (!parsed.success) problems.push({ doc, path, detail: `it does not match its format: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` });
  }
  return { schemas, problems };
}
