import type { EngineerTrend, TeamTrend } from "../normalization/trend.js";
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
    "- deltas: the change between each consecutive pair of points, but ONLY for pairs that are actually comparable (already computed for you — do not recompute, just interpret).",
    "- engineers[].points / engineers[].deltas: the same, per person. A person may have fewer points than the team if they weren't on every snapshot (joined/departed partway, or simply had no assigned work that checkpoint).",
    "IMPORTANT: some adjacent entries in `points` share the exact same date but are DIFFERENT sprints — this happens when several sprints are imported from one bulk export (e.g. a backlog spanning many past sprints) and saved together. Two checkpoints on the same date are NOT a real before/after: no time actually passed between them, so any apparent rise or fall is meaningless, not a trend. This is exactly why `deltas` skips that pair — if two consecutive `points` entries don't have a matching entry in `deltas`, that gap is intentional. Never compute or describe your own comparison between two same-date points; only ever interpret the pairs that already appear in `deltas`.",

    hasUnassigned
      ? `"${UNASSIGNED}" in the engineers list is a shared backlog bucket, not a person — never recommend redistributing "from" or "to" it. If its trend is worth mentioning, frame it as backlog health (growing/shrinking relative to team velocity over time), never as a person's workload.`
      : null,

    ctx.freeText ? `Team-supplied context, treat as ground truth:\n${ctx.freeText}` : null,

    "concerning_trends must each cite the specific checkpoints/dates that show the pattern, not just assert it. recommendations must name specific people when the trend is about a person, and must be something only visible from the accumulated data (e.g. \"Y's cycle time has increased in each of the last 3 checkpoints — investigate now before it becomes the team norm\"), not a generic restatement of the summary.",
    "Write in plain, clear sentences a busy manager could skim in seconds — one idea per sentence, citing the dates/checkpoints that prove the pattern, but not every number available at each of them. State the trend and what it means before the supporting evidence, not the other way around.",

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

// Same shape and same underlying idea as buildTrendPrompt (a trajectory
// synthesis, not a single-point recap) — but scoped to ONE person's own
// points/deltas instead of the whole team's, triggered on demand per
// engineer rather than bundled into the team-wide accumulated call. Kept
// as a genuinely separate prompt (not buildTrendPrompt reused with a
// smaller data slice) because the framing is different throughout: "you
// are looking at X's history" reads naturally, "you are looking at the
// team's history" fed one person's data does not, and a few team-only
// concepts (team_metrics, the Unassigned backlog-health framing) don't
// apply to an individual at all.
export function buildPersonTrendPrompt(personTrend: EngineerTrend, teamName: string, ctx: ReasoningContext = {}): string {
  const lines = [
    `You are looking at ${personTrend.name}'s own workload history on team "${teamName}", across ${personTrend.points.length} saved checkpoint(s) (sprints and/or within-sprint updates) they appeared in, in chronological order.`,
    "Your job is to synthesize THEIR trajectory — patterns that only exist because there are multiple points for this person — not to describe their latest checkpoint alone. A single-point observation belongs in a per-sprint report, not here; only include something if it's true ACROSS the sequence (rising, falling, flat, or oscillating over multiple checkpoints).",
    "Base every claim strictly on the data given — never invent a fact, a name, a number, or a checkpoint not present in it.",

    ctx.charter ? `This team's charter / area of responsibility: ${ctx.charter}` : null,
    ctx.engineerNotes?.[personTrend.name]
      ? `A known, team-supplied fact about how this person normally works: ${ctx.engineerNotes[personTrend.name]}. Treat it as ground truth that overrides a default assumption, never as something to second-guess.`
      : null,

    "Field meanings:",
    "- points: this person's own load_score/burnout_risk/resolved_count/velocity/cycle_time_hours at each checkpoint, in order.",
    "- deltas: the change between each consecutive pair of points, but ONLY for pairs that are actually comparable (already computed for you — do not recompute, just interpret). A gap in the sequence (a checkpoint with no matching delta to the one before it) means those two weren't comparable — e.g. same date, different sprint from a bulk historical import — never invent your own comparison across that gap.",

    "If a recommendation involves moving work, you may name OTHER people on the team as a redistribution target only if the data given actually supports it (e.g. their own load/weight is visible in this person's points) — never invent a teammate's situation you don't have data for. If nothing in the given data supports naming anyone else, keep the recommendation about this person's own scope/priorities instead.",

    ctx.freeText ? `Team-supplied context, treat as ground truth:\n${ctx.freeText}` : null,

    "concerning_trends must each cite the specific checkpoints/dates that show the pattern, not just assert it. recommendations must be specific and actionable, grounded in the trajectory as a whole (e.g. \"cycle time has increased in each of the last 3 checkpoints — investigate now before it becomes the norm for this role\"), not a generic restatement of the summary.",
    "Write in plain, clear sentences a busy manager could skim in seconds — one idea per sentence, citing the dates/checkpoints that prove the pattern, but not every number available at each of them. State the trend and what it means before the supporting evidence, not the other way around.",

    "Data:",
    JSON.stringify(personTrend, null, 2),
  ];

  return lines.filter((line): line is string => line !== null).join("\n\n");
}

export async function reasonAboutPersonTrend(
  personTrend: EngineerTrend,
  teamName: string,
  provider: ReasoningProvider,
  ctx?: ReasoningContext,
): Promise<CumulativeReportOutput> {
  const result = await provider.chat(buildPersonTrendPrompt(personTrend, teamName, ctx), CUMULATIVE_JSON_SCHEMA);
  return CumulativeReportOutputSchema.parse(result);
}
