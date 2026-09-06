import { z } from "zod";

// Mirrors claude.md's "Multi-Team Config Format". `sources` keys map 1:1 to
// provider names, so adding a provider never changes this schema.

export const JiraSourceSchema = z.union([
  z.object({ json: z.string() }),
  z.object({ url: z.string() }),
  z.object({ jql: z.string() }),
]);
export type JiraSource = z.infer<typeof JiraSourceSchema>;

export const TeamSourcesSchema = z.object({
  jira: JiraSourceSchema.optional(),
  github: z.unknown().optional(),
  csv: z.string().optional(),
  url: z.string().optional(),
  manual: z.unknown().optional(),
});
export type TeamSources = z.infer<typeof TeamSourcesSchema>;

export const TeamDefinitionSchema = z.object({
  name: z.string(),
  sprint: z.string(),
  sources: TeamSourcesSchema,
  // Path to a roster file (name -> free-form role label). Optional — role
  // info isn't always available, and absent entries just leave role unknown.
  roster: z.string().optional(),
});
export type TeamDefinition = z.infer<typeof TeamDefinitionSchema>;

export const MultiTeamConfigSchema = z.object({
  teams: z.array(TeamDefinitionSchema).min(1),
});
export type MultiTeamConfig = z.infer<typeof MultiTeamConfigSchema>;
