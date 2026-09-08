import type { EngineerTrend, TeamTrend } from "../normalization/trend.js";
import {
  CUMULATIVE_JSON_SCHEMA,
  CumulativeReportOutputSchema,
  type CumulativeReportOutput,
  PERSON_CUMULATIVE_JSON_SCHEMA,
  PersonCumulativeReportOutputSchema,
  type PersonCumulativeReportOutput,
} from "./cumulativeSchema.js";
import type { ReasoningContext, ReasoningProvider } from "./types.js";

const UNASSIGNED = "Unassigned";

// engineer_patterns entries are only trustworthy if they name someone who
// actually appears in the trend data — confirmed as a real, observed
// failure mode (not hypothetical) with a smaller local model: it named
// "You01" (not a real engineer in the data at all) and "Kenneth.vanderlinde"
// (wrong casing of the real "kenneth.vanderlinde") in the very first live
// verification of this schema. Same category of gap as withoutUnassigned in
// reason.ts — prompting alone ("name must exactly match") isn't reliable
// enough on its own, so real names are enforced deterministically here too.
function keepOnlyRealEngineers<T extends { name: string }>(entries: T[], knownNames: Set<string>): T[] {
  return entries.filter((entry) => knownNames.has(entry.name) && entry.name !== UNASSIGNED);
}

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
    "- engineers[].points[].weight: the capacity/tolerance multiplier already baked into that checkpoint's load_score (1 = no adjustment; the team lead sets this, e.g. a senior role given <1 because they're expected to absorb the same raw workload more comfortably). load_score already has this applied — don't re-apply it — but weight tells you WHY two people with similar raw numbers can carry different load_score, and it changes who a fair redistribution destination is: when naming someone in leadership_takeaways.opportunities or engineer_patterns as a place to move work TO, prefer someone whose weight is below 1 (the team's own stated view of who has headroom) over someone at weight 1 who is already at unadjusted capacity, when the data supports it.",
    "IMPORTANT: some adjacent entries in `points` share the exact same date but are DIFFERENT sprints — this happens when several sprints are imported from one bulk export (e.g. a backlog spanning many past sprints) and saved together. Two checkpoints on the same date are NOT a real before/after: no time actually passed between them, so any apparent rise or fall is meaningless, not a trend. This is exactly why `deltas` skips that pair — if two consecutive `points` entries don't have a matching entry in `deltas`, that gap is intentional. Never compute or describe your own comparison between two same-date points; only ever interpret the pairs that already appear in `deltas`.",

    hasUnassigned
      ? `"${UNASSIGNED}" in the engineers list is a shared backlog bucket, not a person — never recommend redistributing "from" or "to" it. If its trend is worth mentioning, frame it as backlog health (growing/shrinking relative to team velocity over time), never as a person's workload.`
      : null,

    ctx.freeText ? `Team-supplied context, treat as ground truth:\n${ctx.freeText}` : null,

    "You are producing a structured report with several distinct sections — team_overview (throughput/cycle_time/stability), engineer_patterns (who's overloaded/underutilized/a stable anchor, and why), unassigned_risk, overall_assessment, leadership_takeaways (root_causes/opportunities), and concerning_trends. Each section has its own job — don't repeat the same observation across multiple sections just to fill them in.",
    "team_overview.throughput and team_overview.cycle_time each need a diagnostic layer, not just a description: after citing the evidence (the range, the specific strong/weak sprints), add a line starting exactly with \"This usually means:\" followed by a markdown list — each item on its own line starting with a literal hyphen and space (\"- \"), never a \"•\" character or a comma-separated run-on — of 3-5 concrete, plausible causes — for throughput volatility, draw from things like inconsistent work intake, unstable prioritization, engineers frequently blocked, inconsistent sizing, or the team reacting instead of executing to a plan; for cycle time, draw from things like work sitting stuck, items too large, work bouncing between people, waiting on a dependency, or poorly scoped/assigned work. Only include causes this specific data actually supports — this is not a checklist to paste in unchanged.",
    "team_overview.stability must quote at least 2-3 SPECIFIC consecutive transitions verbatim from deltas, each labeled with what it means, in this style: \"Sprint 26.7 -> 26.8: velocity +24, resolved +19, cycle time -1569.7h — a strong sprint\" immediately followed by a contrasting one like \"26.8 -> 26.9: velocity -12.5, resolved -11, cycle time +256.2h — a regression.\" Then name the repeating cycle those transitions are part of (e.g. \"the team improves for one sprint, then collapses the next, then recovers, then collapses again\") if the whole sequence actually shows a repeating cycle, not just a one-off swing.",
    "engineer_patterns: place a named engineer in overloaded/underutilized/stable_anchors when EITHER a sustained multi-checkpoint pattern supports it, OR they have a single-transition delta that's a dramatic outlier even against their own other checkpoints (e.g. one cycle-time jump of several thousand hours) — a one-time spike that large is real and reportable even if it reverted the next checkpoint. Before finalizing this section, scan every engineer's deltas for the single largest cycle-time and load-score jumps in the whole dataset and confirm whoever they belong to is named somewhere in engineer_patterns or concerning_trends — omitting the team's biggest outlier because their OTHER checkpoints look calm is a gap, not a valid judgment call. The same person can appear in more than one bucket if their history genuinely shows more than one pattern. It's fine for someone with nothing notable anywhere in their data to appear in none of the three buckets. Never place \"Unassigned\" in any of these buckets.",
    "overall_assessment is the connecting synthesis, not a restatement of team_overview — write it as the conclusion a manager reading everything above start to finish would draw. Use markdown headings (\"## \"/\"**\") freely; every list item must be its own line starting with a literal hyphen and space (\"- \"), never a \"•\" character. This field is explicitly meant to be longer and more structured than the rest. It must cite something already established elsewhere in your own output (a number, a name, a transition) for each point it makes, and must cover: what the throughput pattern implies about planning/sizing discipline, what the cycle-time pattern implies about execution efficiency, how load is actually distributed across the team (concentrated on a few vs. spread out) and what that implies, and whether the sprint-to-sprint pattern reads as a team executing a plan or reacting sprint to sprint.",
    "leadership_takeaways.root_causes must be short SYSTEMIC phrases the patterns above point to (e.g. work sizing, assignment discipline, dependency management) — not a restatement of one person's numbers. leadership_takeaways.opportunities is REQUIRED to contain at least 2 short, concrete, actionable steps, naming specific people where the data supports it — never leave it empty.",
    "concerning_trends must each cite the specific checkpoints/dates that show the pattern, not just assert it.",
    "Outside of team_overview and overall_assessment (which explicitly use headings/bullets as instructed above), write in plain, clear sentences a busy manager could skim in seconds — one idea per sentence, citing the dates/checkpoints/sprint labels that prove the pattern, but not every number available at each of them. State the trend and what it means before the supporting evidence, not the other way around.",

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
  const parsed = CumulativeReportOutputSchema.parse(result);
  const knownNames = new Set(trend.engineers.map((e) => e.name));
  return {
    ...parsed,
    engineer_patterns: {
      overloaded: keepOnlyRealEngineers(parsed.engineer_patterns.overloaded, knownNames),
      underutilized: keepOnlyRealEngineers(parsed.engineer_patterns.underutilized, knownNames),
      stable_anchors: keepOnlyRealEngineers(parsed.engineer_patterns.stable_anchors, knownNames),
    },
  };
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
    "- points[].weight: the capacity/tolerance multiplier already baked into THIS person's load_score at each checkpoint (1 = no adjustment; the team lead sets this, e.g. a senior role given <1 because they're expected to absorb the same raw workload more comfortably). load_score already has this applied — don't re-apply it — but weight tells you whether a given load_score reflects genuinely heavy raw work or a lower stated tolerance: the same load_score at weight 0.8 (someone the team already expects to handle more) is a different situation than at weight 1.2 (someone the team already expects to need more room), even though the number looks identical.",
    "- deltas: the change between each consecutive pair of points, but ONLY for pairs that are actually comparable (already computed for you — do not recompute, just interpret). A gap in the sequence (a checkpoint with no matching delta to the one before it) means those two weren't comparable — e.g. same date, different sprint from a bulk historical import — never invent your own comparison across that gap.",

    "This person's OWN points never contain another engineer's data. If a recommendation involves moving work away from them, you may name another teammate as where it should go only if team-supplied context or a work-pattern note actually names someone with stated headroom — never invent another person's load or weight to manufacture a destination. If nothing given supports naming anyone else, keep the recommendation about this person's own scope/priorities instead.",

    ctx.freeText ? `Team-supplied context, treat as ground truth:\n${ctx.freeText}` : null,

    "You are producing a structured report: trajectory_overview (workload/cycle_time/stability, each its own angle — don't repeat the same observation across all three), pattern (the single classification that best fits their trajectory, with a grounded reason), recommendations, and concerning_trends.",
    "pattern.classification must be the ONE best-fitting label for the trajectory as a whole, not a snapshot of the latest checkpoint — base it on what's sustained across multiple points.",
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
): Promise<PersonCumulativeReportOutput> {
  const result = await provider.chat(buildPersonTrendPrompt(personTrend, teamName, ctx), PERSON_CUMULATIVE_JSON_SCHEMA);
  return PersonCumulativeReportOutputSchema.parse(result);
}
