import { z } from "zod";

// What the reasoning provider (Ollama by default, or Claude) must return.
// Matches the shape of the canonical schema's recommendation fields exactly
// so merging the result back into a TeamReport is a straight assignment.
export const EngineerRecommendationSchema = z.object({
  name: z.string(),
  redistribute_to: z.array(z.string()),
  reduce_scope: z.array(z.string()),
  notes: z.string(),
});

export const TeamRecommendationsOutputSchema = z.object({
  engineer_recommendations: z.array(EngineerRecommendationSchema),
  team_recommendations: z.object({
    redistribute_work: z.array(z.string()),
    sprint_feasibility: z.string(),
    notes: z.string(),
  }),
});
export type TeamRecommendationsOutput = z.infer<typeof TeamRecommendationsOutputSchema>;

// Hand-written JSON Schema mirror of the above, for providers (Ollama) that
// take a raw JSON Schema for structured output rather than a Zod schema.
export const RECOMMENDATIONS_JSON_SCHEMA = {
  type: "object",
  properties: {
    engineer_recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Must exactly match an engineer name from the input data." },
          redistribute_to: {
            type: "array",
            items: { type: "string" },
            description: "Short list of engineer NAMES ONLY this person's work should move to — no explanation here, just names (put the reasoning in notes instead).",
          },
          reduce_scope: {
            type: "array",
            items: { type: "string" },
            description: "Short list of specific work categories/types to cut or defer for this person — brief phrases, not full sentences (put the reasoning in notes instead).",
          },
          notes: { type: "string", description: "The full analysis and reasoning for this person, several sentences, grounded in the data — this is where explanations belong, not in the arrays above." },
        },
        required: ["name", "redistribute_to", "reduce_scope", "notes"],
      },
    },
    team_recommendations: {
      type: "object",
      properties: {
        redistribute_work: {
          type: "array",
          items: { type: "string" },
          description: "Short list of engineer NAMES ONLY who are overloaded and need relief — no explanation here, just names (put the reasoning in notes instead).",
        },
        sprint_feasibility: { type: "string", description: "A short phrase or label, e.g. \"on track\", \"at risk\", \"unlikely\" — not a paragraph." },
        notes: { type: "string", description: "The full team-wide analysis, several sentences, grounded in team_metrics and named cross-engineer comparisons — this is where explanations belong, not in the arrays above." },
      },
      required: ["redistribute_work", "sprint_feasibility", "notes"],
    },
  },
  required: ["engineer_recommendations", "team_recommendations"],
} as const;
