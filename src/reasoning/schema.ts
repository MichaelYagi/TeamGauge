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
// additionalProperties: false is required on every object node here — the
// Claude API's structured-output validator (output_config.format) rejects
// any object schema that omits it, even though Ollama's structured output
// doesn't enforce this. Omitting it on a nested object (not just the top
// level) is enough to fail a Claude call with a 400.
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
          notes: { type: "string", description: "Several sentences of full analysis for this person, grounded in the data — this is where explanations belong, not in the arrays above. The FIRST sentence must state whether this person reads as overloaded, underutilized, or stable THIS sprint, followed by the specific grounded comparison that shows it." },
        },
        required: ["name", "redistribute_to", "reduce_scope", "notes"],
        additionalProperties: false,
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
        notes: {
          type: "string",
          description:
            'REQUIRED to be a structured write-up using these EXACT markdown section headings, in this order, each with 1-3 sentences: "## Throughput" (this sprint\'s velocity/resolved count against team_metrics, and against the stated sprint goal if one was given), "## Cycle Time" (whether team_avg_cycle_time_hours reads healthy or concerning, and why), "## Who Needs Attention" (name the specific engineers who read as overloaded or underutilized THIS sprint, each with the one comparison that shows it), and "## Leadership Actions" (2-3 concrete, named next steps). Add a "## Unassigned" section, in the same position, only if "Unassigned" appears among engineers. This is NOT a few plain sentences — a response with no markdown headings at all does not satisfy this field.',
        },
      },
      required: ["redistribute_work", "sprint_feasibility", "notes"],
      additionalProperties: false,
    },
  },
  required: ["engineer_recommendations", "team_recommendations"],
  additionalProperties: false,
} as const;
