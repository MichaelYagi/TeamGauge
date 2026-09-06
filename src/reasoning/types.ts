import type { TeamReport } from "../schema/canonical.js";
import type { TeamRecommendationsOutput } from "./schema.js";

// Everything here is ground truth the caller supplies — TeamGauge never
// invents a charter, a sprint length, or a work-pattern note. `freeText` is
// the ad-hoc --context flag; the rest come from a saved team profile when
// one is used (see src/db/teamProfile.ts).
export interface ReasoningContext {
  freeText?: string;
  charter?: string;
  sprintLengthDays?: number;
  daysIntoSprint?: number;
  engineerNotes?: Record<string, string>;
}

export interface ReasoningProvider {
  reason(report: TeamReport, ctx?: ReasoningContext): Promise<TeamRecommendationsOutput>;
  // Generic structured-output call, for reasoning tasks other than a single
  // snapshot's recommendations (e.g. a cumulative report over a team's
  // whole history — see cumulativeReason.ts). Returns raw parsed JSON; the
  // caller validates it against whatever schema fits that task.
  chat(prompt: string, jsonSchema: Record<string, unknown>): Promise<unknown>;
}

const UNASSIGNED = "Unassigned";

export function buildPrompt(report: TeamReport, ctx: ReasoningContext = {}): string {
  const dataForModel = {
    team: report.team,
    team_metrics: report.team_metrics,
    engineers: report.engineers.map(({ name, role, signals, derived_metrics }) => ({
      name,
      role,
      signals,
      derived_metrics,
      work_pattern_note: ctx.engineerNotes?.[name] || undefined,
    })),
  };

  const hasUnassigned = report.engineers.some((e) => e.name === UNASSIGNED);

  const sprintTiming =
    ctx.sprintLengthDays && ctx.daysIntoSprint !== undefined
      ? `This snapshot is from day ${ctx.daysIntoSprint} of a ${ctx.sprintLengthDays}-day sprint (${Math.round((ctx.daysIntoSprint / ctx.sprintLengthDays) * 100)}% through). Weigh "no resolved work yet" very differently early in a sprint than late in one — a role or person whose work_pattern_note says they typically work in the back half of the sprint should not be flagged for having little to show this early.`
      : ctx.sprintLengthDays
        ? `This team's sprints are ${ctx.sprintLengthDays} days long. Sprint-position (day X of Y) for this specific snapshot is not known — don't assume it's early or late.`
        : null;

  const lines = [
    "You are writing a sprint workload report for a team lead, using normalized Jira signals below.",
    "Base every claim strictly on the data given — never invent a fact, a name, or a number not derivable from it.",

    ctx.charter ? `This team's charter / area of responsibility: ${ctx.charter}` : null,
    sprintTiming,

    "Field meanings you must use precisely:",
    "- signals.work_items: all items assigned this sprint (open + resolved).",
    "- derived_metrics.resolved_count: items actually closed out this sprint.",
    "- derived_metrics.velocity: story points closed if the source tracks them, else same as resolved_count.",
    "- signals.cycle_time_hours: mean time from created to resolved, resolved items only (0 if none resolved yet — not necessarily fast).",
    "- derived_metrics.weight: the capacity/tolerance multiplier already applied to compute load_score (1 = no adjustment; the team lead sets this — e.g. a senior role given <1 because they're expected to absorb the same raw workload more comfortably, or >1 if less so). load_score already has this baked in — do not re-apply it — but weight tells you *why* two engineers with similar raw signals can have different load_score, and it changes what a fair redistribution target looks like: someone at weight <1 is the team's own stated view of who has more headroom, so prefer naming them as a destination over someone at weight 1 who is already at unadjusted capacity.",
    "- team_metrics: team-wide totals/averages across every entry, including \"Unassigned\" — use it as the baseline you compare individuals against.",
    "- work_pattern_note (per engineer, when present): a known, team-supplied fact about how that person/role normally works — treat it as ground truth that overrides a default assumption, never as something to second-guess.",

    hasUnassigned
      ? [
          `"${UNASSIGNED}" is a shared backlog bucket of unclaimed tickets, not a team member.`,
          "This rule applies to every field you write, including free-text notes — not only redistribute_to/redistribute_work.",
          "Never write a sentence like \"redistribute work from Unassigned to X\" or \"assign some of Unassigned's items to X\" anywhere, in any field — that framing treats a queue like a person and is wrong regardless of which field it appears in.",
          `Instead, when ${UNASSIGNED} is worth mentioning, comment on backlog health: is its item count large or small relative to team_metrics.team_velocity (i.e. will the team clear it this sprint at the current pace)? Is it growing or a normal buffer? That's a real signal — treat it as one, not as "someone's overload" to be handed off.`,
        ].join(" ")
      : null,

    ctx.freeText
      ? `Additional team-supplied context you must treat as ground truth and follow exactly, overriding any default assumption above where it applies:\n${ctx.freeText}`
      : null,

    "Write a substantive report, not a restatement of numbers already visible on a dashboard. Every note must add something a reader could not get by glancing at the raw figures: a specific comparison (e.g. \"X's cycle time is Nx the team average of Y hours despite equal work_items\"), a ratio the reader would have to compute themselves (backlog size vs. velocity, resolved vs. assigned), an outlier call-out, or a risk implied by combining two signals (e.g. high priority_pressure plus high cycle_time_hours). A note that only says someone \"has a high load_score\" without explaining why relative to the team, or what to actually do about it, is not acceptable.",
    "But being specific does not mean cramming in every available statistic. Write in plain, clear sentences a busy manager could skim in seconds — one idea per sentence, and at most one supporting number per sentence. \"Jason's cycle time is far above the team average, which points to a blocked or oversized ticket rather than reduced effort\" is the right shape. \"Jason Choi's 1304-hour cycle time (150% team average) paired with 54 load score (62% team average) suggests potential for task simplification\" is NOT — that's several statistics stacked into one clause, which reads as a data dump, not analysis a person can act on. Pick the ONE comparison that best supports your point and lead with what it means, not the arithmetic behind it.",
    'Never suggest redistribution in the abstract. "Redistribute high-priority tasks to engineers with lower cycle times" is not acceptable — it makes the reader do the lookup you already have the data to do. Name exactly who: "redistribute some of X\'s load to Y (Y is at weight 0.8 with load_score Z, below the team average)." Every redistribution claim in any field, including free-text notes, must resolve to specific named people, not a category description.',
    '"redistribute_to" must only name other engineers listed in this same team\'s data — never invent a name, never reference another team, and never name "Unassigned" as a source or target per the rule above.',
    'An empty role ("") means the role is unknown; do not guess a title.',
    "team_recommendations.notes must be several sentences of genuine analysis grounded in team_metrics and cross-engineer comparison — not a single generic sentence.",

    "Data:",
    JSON.stringify(dataForModel, null, 2),
  ];

  return lines.filter((line): line is string => line !== null).join("\n\n");
}
