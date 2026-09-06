import { z } from "zod";

// Mirrors the canonical schema in claude.md. Never change shape here without
// updating claude.md and design.md first.

export const SignalsSchema = z.object({
  work_items: z.number(),
  cycle_time_hours: z.number(),
  blocked_items: z.number(),
  priority_pressure: z.string(),
  context_switching_index: z.number(),
  unplanned_work_ratio: z.number(),
});
export type Signals = z.infer<typeof SignalsSchema>;

export const ProviderOutputSchema = z.object({
  signals: SignalsSchema,
});
export type ProviderOutput = z.infer<typeof ProviderOutputSchema>;

export const EngineerSchema = z.object({
  name: z.string(),
  role: z.string(),
  signals: SignalsSchema,
  derived_metrics: z.object({
    load_score: z.number(),
    burnout_risk: z.string(),
    // Deterministic closeout stats, not derived from load_score — see
    // src/providers/common/computeSignals.ts. resolved_count is a plain
    // count of resolved issues; velocity is story points on those issues
    // when the source tracks them, else the same resolved_count.
    resolved_count: z.number(),
    velocity: z.number(),
    // The roster capacity/tolerance multiplier actually applied to compute
    // load_score above (defaults to 1 when no roster/weight was supplied).
    // Exposed so both a human and the reasoning step can see *why* two
    // people with the same raw signals ended up with different load_score.
    weight: z.number(),
  }),
  recommendations: z.object({
    redistribute_to: z.array(z.string()),
    reduce_scope: z.array(z.string()),
    notes: z.string(),
  }),
});
export type Engineer = z.infer<typeof EngineerSchema>;

// Team-wide rollups, computed deterministically (sums/weighted averages over
// engineers — no reasoning) so the report has real comparative numbers
// (velocity, closeout counts/times) available even before the reasoning
// step runs, and so the reasoning step has accurate figures to reference
// instead of re-deriving (or guessing at) them.
export const TeamMetricsSchema = z.object({
  total_work_items: z.number(),
  total_resolved: z.number(),
  team_velocity: z.number(),
  team_avg_cycle_time_hours: z.number(),
});
export type TeamMetrics = z.infer<typeof TeamMetricsSchema>;

export const TeamReportSchema = z.object({
  team: z.object({
    name: z.string(),
    sprint: z.string(),
    members: z.number(),
  }),
  engineers: z.array(EngineerSchema),
  team_metrics: TeamMetricsSchema,
  team_recommendations: z.object({
    redistribute_work: z.array(z.string()),
    sprint_feasibility: z.string(),
    notes: z.string(),
  }),
});
export type TeamReport = z.infer<typeof TeamReportSchema>;

export const ReportsPayloadSchema = z.object({
  reports: z.array(TeamReportSchema),
});
export type ReportsPayload = z.infer<typeof ReportsPayloadSchema>;

export function emptyRecommendations(): Engineer["recommendations"] {
  return { redistribute_to: [], reduce_scope: [], notes: "" };
}

export function emptyTeamRecommendations(): TeamReport["team_recommendations"] {
  return { redistribute_work: [], sprint_feasibility: "", notes: "" };
}
