import { z } from "zod";

export const ROLES = ["orchestrator", "implementer", "reviewer", "researcher"] as const;
const Role = z.looseObject({ model: z.string(), options: z.record(z.string(), z.unknown()).optional() });

export const Profile = z.looseObject({
  schema: z.literal(1),
  name: z.string(),
  requires: z.array(z.enum(["claude", "codex"])),
  roles: z.looseObject({
    orchestrator: Role,
    implementer: Role,
    reviewer: Role,
    researcher: Role,
  }),
});
export type Profile = z.infer<typeof Profile>;
