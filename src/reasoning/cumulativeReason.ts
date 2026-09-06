import type { TeamTrend } from "../normalization/trend.js";
import { CUMULATIVE_JSON_SCHEMA, CumulativeReportOutputSchema, type CumulativeReportOutput } from "./cumulativeSchema.js";
import type { ReasoningContext, ReasoningProvider } from "./types.js";

const UNASSIGNED = "Unassigned";

// Distinct from buildPrompt (types.ts), which reasons over ONE snapshot.
// This reasons over the WHOLE sequence of snapshots for a team — the point
// is patterns only visible across multiple checkpoints (a metric rising
// every sprint, a backlog that never shrinks), which a single-snapshot
// prompt structurally cannot see.
export function buildTrendPrompt(trend: TeamTrend, ctx: ReasoningContext = {}): string {
  const hasUnassigned = trend.engineers.some((e) => e.name === UNASSIGNED);

  const lines = [
    `You are looking at "${trend.team}"'s workload history across ${trend.points.length} saved checkpoint(s) (sprints and/or within-sprint updates), in chronological order.`,
    "Your job is to synthesize the TRAJECTORY — patterns that only exist because there are multiple points — not to describe the latest checkpoint alone. A single-point observation (\"load_score is 45\") belongs in a per-sprint report, not here; only include something if it's true ACROSS the sequence (rising, falling, flat, or oscillating over multiple checkpoints).",
    "Base every claim strictly on the data given — never invent a fact, a name, a number, or a number of checkpoints not present in the data.",

    ctx.charter ? `This team's charter / area of responsibility: ${ctx.charter}` : null,

    "Field meanings:",
    "- points: team-wide totals/averages at each checkpoint, in order.",
    "- deltas: the change between each consecutive pair of points (already computed for you — do not recompute, just interpret).",
    "- engineers[].points / engineers[].deltas: the same, per person. A person may have fewer points than the team if they weren't on every snapshot (joined/departed partway, or simply had no assigned work that checkpoint).",

    hasUnassigned
      ? `"${UNASSIGNED}" in the engineers list is a shared backlog bucket, not a person — never recommend redistributing "from" or "to" it. If its trend is worth mentioning, frame it as backlog health (growing/shrinking relative to team velocity over time), never as a person's workload.`
      : null,

    ctx.freeText ? `Team-supplied context, treat as ground truth:\n${ctx.freeText}` : null,

    "concerning_trends must each cite the specific checkpoints/dates that show the pattern, not just assert it. recommendations must name specific people when the trend is about a person, and must be something only visible from the accumulated data (e.g. \"Y's cycle time has increased in each of the last 3 checkpoints — investigate now before it becomes the team norm\"), not a generic restatement of the summary.",

    "Data:",
    JSON.stringify(trend, null, 2),
  ];

  return lines.filter((line): line is string => line !== null).join("\n\n");
}

export async function reasonAboutTrend(
  trend: TeamTrend,
  provider: ReasoningProvider,
  ctx?: ReasoningContext,
): Promise<CumulativeReportOutput> {
  const result = await provider.chat(buildTrendPrompt(trend, ctx), CUMULATIVE_JSON_SCHEMA);
  return CumulativeReportOutputSchema.parse(result);
}
