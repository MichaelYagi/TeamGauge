import { z } from "zod";

// Output of reasoning over a team's WHOLE history (multiple snapshots), not
// one point in time — a synthesized view of the trajectory, not a per-
// snapshot recap. See cumulativeReason.ts.
export const CumulativeReportOutputSchema = z.object({
  summary: z.string(),
  recommendations: z.array(z.string()),
  concerning_trends: z.array(z.string()),
});
export type CumulativeReportOutput = z.infer<typeof CumulativeReportOutputSchema>;

// additionalProperties: false is required on every object node — see the
// same note in schema.ts. This schema has only one object node (the top
// level), but that one still needs it or a Claude call 400s.
export const CUMULATIVE_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Several sentences synthesizing the WHOLE trajectory across every snapshot given — not a description of the latest snapshot alone. Must reference the actual pattern across points (e.g. rising/falling/flat over N checkpoints), not just the most recent numbers.",
    },
    recommendations: {
      type: "array",
      items: { type: "string" },
      description: "Accumulated, named, actionable recommendations grounded in the trajectory as a whole (e.g. sustained patterns across sprints) — not recommendations that could have been made from a single snapshot alone. Each item is one full recommendation sentence naming specific people where relevant.",
    },
    concerning_trends: {
      type: "array",
      items: { type: "string" },
      description: "Specific call-outs of things getting worse across consecutive checkpoints (e.g. \"X's load_score has increased in every one of the last 3 snapshots\") — only include a trend that is actually visible across multiple points, never a single-point observation.",
    },
  },
  required: ["summary", "recommendations", "concerning_trends"],
  additionalProperties: false,
} as const;
