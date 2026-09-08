import { z } from "zod";

// A named engineer plus the one-sentence reason they landed in a given
// pattern bucket (engineer_patterns below) — kept as {name, reason} rather
// than a plain string so the UI can render a consistent name+reason list
// without parsing prose, and so "name" can be cross-checked/escaped
// separately from free-text reasoning.
export const EngineerPatternEntrySchema = z.object({
  name: z.string(),
  reason: z.string(),
});
export type EngineerPatternEntry = z.infer<typeof EngineerPatternEntrySchema>;

const engineerPatternEntryJsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Must exactly match an engineer name from the input data — never \"Unassigned\" (see the Unassigned rule)." },
    reason: { type: "string", description: "One or two sentences, grounded in this person's own points/deltas, explaining why they land in this bucket." },
  },
  required: ["name", "reason"],
  additionalProperties: false,
} as const;

// Output of reasoning over a team's WHOLE history (multiple snapshots), not
// one point in time — a synthesized, categorized view of the trajectory,
// not a per-snapshot recap. See cumulativeReason.ts / buildTrendPrompt.
// Structured (rather than one long narrative field) so the UI can render
// consistent sectioned cards every time, and so "who's overloaded" is a
// real, reusable list rather than something buried in prose.
export const CumulativeReportOutputSchema = z.object({
  summary: z.string(),
  team_overview: z.object({
    throughput: z.string(),
    cycle_time: z.string(),
    stability: z.string(),
  }),
  engineer_patterns: z.object({
    overloaded: z.array(EngineerPatternEntrySchema),
    underutilized: z.array(EngineerPatternEntrySchema),
    stable_anchors: z.array(EngineerPatternEntrySchema),
  }),
  // "" (never null) when there's no Unassigned bucket in the data, or its
  // trend isn't notable — see the note on cumulativeSchema.ts's earlier
  // nullable-field avoidance: an empty-string sentinel is used everywhere
  // else in this app for "not applicable" (e.g. engineer.role) instead of
  // null, so every provider's structured-output validator (which don't all
  // treat JSON Schema's `type: [x, "null"]` the same way) sees one
  // consistent, always-string shape.
  unassigned_risk: z.string(),
  // The connecting synthesis — team_overview/engineer_patterns/
  // unassigned_risk each report ONE finding at a time; this is the longer
  // narrative that ties them together into "what this means for the team
  // as a whole," the way a manager reading the whole report end to end
  // would conclude it, before leadership_takeaways turns that into actions.
  overall_assessment: z.string(),
  leadership_takeaways: z.object({
    root_causes: z.array(z.string()),
    opportunities: z.array(z.string()),
  }),
  concerning_trends: z.array(z.string()),
});
export type CumulativeReportOutput = z.infer<typeof CumulativeReportOutputSchema>;

// additionalProperties: false is required on every object node — see the
// same note in schema.ts. Every nested object here (team_overview,
// engineer_patterns, each pattern-entry item, leadership_takeaways) needs
// its own, not just the top level, or a Claude call 400s.
export const CUMULATIVE_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two or three sentences giving a busy manager the headline: is this team's delivery stable or volatile, and what's the one thing to act on. Not a restatement of the sections below — the thing they'd read if they only had ten seconds.",
    },
    team_overview: {
      type: "object",
      properties: {
        throughput: {
          type: "string",
          description: "Velocity and resolved-item volatility across the WHOLE sequence — cite the actual range (e.g. \"velocity ranged from 0 to 32\") and name specific strong vs. weak sprints by their sprint label. Then, on its own line starting with \"This usually means:\", give a markdown list — each item on its own line starting with a literal hyphen and space (\"- \"), never a \"•\" character or a comma-separated run-on — of 3-5 concrete, plausible causes this pattern typically indicates (e.g. inconsistent work intake, unstable prioritization, engineers frequently blocked, inconsistent sizing, the team reacting instead of executing to a plan) — only the ones actually plausible given this data, not a generic checklist. Only describe a pattern actually visible in points/deltas.",
        },
        cycle_time: {
          type: "string",
          description: "Cycle-time health across the whole sequence — cite the actual range and call out whether it's consistently high, improving, or worsening. This is the strongest team-health signal available; say so if it's bad even while throughput looks fine (shipping inefficiently is still a real finding). Then, on its own line starting with \"This usually means:\", give a markdown list — each item on its own line starting with a literal hyphen and space (\"- \"), never a \"•\" character or a comma-separated run-on — of 3-5 concrete causes cycle time in this range typically indicates (e.g. work stuck/blocked, items too large, work bouncing between people, waiting on a dependency, poorly scoped or assigned work) — only the ones this data actually supports.",
        },
        stability: {
          type: "string",
          description: "The sprint-to-sprint PATTERN from deltas. Quote at least 2-3 SPECIFIC consecutive transitions verbatim as evidence, each labeled with what it means (e.g. \"Sprint 26.7 -> 26.8: velocity +24, resolved +19, cycle time -1569.7h — a strong sprint\" immediately followed by \"26.8 -> 26.9: velocity -12.5, resolved -11, cycle time +256.2h — a regression\"), then name the repeating cycle those transitions are part of (e.g. \"the team improves for one sprint, then collapses the next, then recovers, then collapses again\") if the data across the whole sequence actually shows a repeating cycle rather than a one-off swing. Never invent a transition not present in deltas.",
        },
      },
      required: ["throughput", "cycle_time", "stability"],
      additionalProperties: false,
    },
    engineer_patterns: {
      type: "object",
      properties: {
        overloaded: {
          type: "array",
          items: engineerPatternEntryJsonSchema,
          description: "Named engineers who EITHER show sustained high cycle time/load_score across several checkpoints, OR had at least one single-transition delta that is a dramatic outlier versus their own other deltas (e.g. a cycle-time jump of several thousand hours in one step) — include the outlier case even if it reverted the very next checkpoint. A one-time spike that big is itself a real, reportable event, not noise to wait out for a sustained trend.",
        },
        underutilized: {
          type: "array",
          items: engineerPatternEntryJsonSchema,
          description: "Named engineers whose points/deltas show sustained LOW cycle time AND low velocity/load_score across checkpoints — a signal of unused capacity or misassigned work, not a compliment. Someone who ALSO has one huge cycle-time spike elsewhere in their history belongs in overloaded (or both, if both are real) — don't classify them as only underutilized based on their other, calmer checkpoints.",
        },
        stable_anchors: {
          type: "array",
          items: engineerPatternEntryJsonSchema,
          description: "Named engineers with small, steady deltas across every one of their checkpoints — neither overloaded nor underutilized, not a source of the team's volatility. These are reliable contributors worth naming as such.",
        },
      },
      required: ["overloaded", "underutilized", "stable_anchors"],
      additionalProperties: false,
      description: "Categorize named engineers only where the data actually supports it — an engineer with nothing notable can be omitted from every bucket rather than forced into one. The SAME engineer can appear in more than one bucket if their own history genuinely shows both patterns (e.g. mostly stable with one dramatic spike). Before finalizing this object, scan every engineer's deltas for the single largest cycle-time or load-score jump in the whole dataset — if it belongs to someone not yet named anywhere in this object, that is a gap, not a deliberate omission. Never include \"Unassigned\" here.",
    },
    unassigned_risk: {
      type: "string",
      description: "If an \"Unassigned\" bucket appears in the data: is its load_score/item count fluctuating or growing relative to team velocity — a sign work enters sprints without an owner, floats, or gets planned late? Frame this as a process signal, never as a person's workload, and never suggest redistributing 'from' or 'to' it. Return an empty string \"\" if there's no Unassigned bucket in the data, or its trend isn't notable.",
    },
    overall_assessment: {
      type: "string",
      description: "A longer synthesis connecting throughput, cycle_time, stability, engineer_patterns, and unassigned_risk above into what they mean for the team AS A WHOLE — not a repeat of any single finding already stated, but the conclusion a manager would draw from reading all of them together. Use markdown headings (\"## \"/\"**\") and lists freely; every list item must be its own line starting with a literal hyphen and space (\"- \"), never a \"•\" character. This field is explicitly meant to be longer and more structured than the others. Cover, at minimum, using this data: (1) what the throughput pattern (stable vs. volatile) implies about how work is planned and sized, (2) what the cycle-time pattern implies about whether the team is executing efficiently, (3) how load is actually distributed across the team (concentrated on a few people vs. spread out) and what that implies, (4) whether the sprint-to-sprint pattern looks like a team executing a plan or reacting sprint to sprint. Every point must cite something already established above (a number, a name, a transition) — this is connective analysis, not a new pass over raw data.",
    },
    leadership_takeaways: {
      type: "object",
      properties: {
        root_causes: {
          type: "array",
          items: { type: "string" },
          description: "2-5 short root-cause phrases (not full paragraphs) that the patterns above point to systemically — e.g. \"work isn't being sized or decomposed before sprint start\". Grounded in what's actually visible in the data, not generic team advice.",
        },
        opportunities: {
          type: "array",
          items: { type: "string" },
          description: "REQUIRED: at least 2, up to 5, short, concrete, actionable next steps a lead could actually take — name specific people where the data supports it (e.g. \"redistribute some of X's load to Y, who has headroom\"), not vague categories. Never return an empty array — team_overview and engineer_patterns above always contain enough material to name at least two concrete actions.",
        },
      },
      required: ["root_causes", "opportunities"],
      additionalProperties: false,
    },
    concerning_trends: {
      type: "array",
      items: { type: "string" },
      description: "Specific call-outs of things getting worse — EITHER across consecutive checkpoints (e.g. \"X's load_score has increased in every one of the last 3 snapshots\") OR a single-transition anomaly so large it's notable on its own (e.g. a cycle-time jump of several thousand hours in one step), even if it reverted the following checkpoint. Ground every entry in an actual delta present in the data, never an invented one.",
    },
  },
  required: ["summary", "team_overview", "engineer_patterns", "unassigned_risk", "overall_assessment", "leadership_takeaways", "concerning_trends"],
  additionalProperties: false,
} as const;

// Same idea as the team-wide schema above, scoped to one person's own
// trajectory — a genuinely different (smaller) shape rather than the team
// schema reused, since "engineer_patterns" (categorizing OTHER people) and
// "unassigned_risk"/"leadership_takeaways" (team-level backlog/process
// concepts) don't apply to an individual's own history. See
// buildPersonTrendPrompt.
export const PersonCumulativeReportOutputSchema = z.object({
  summary: z.string(),
  trajectory_overview: z.object({
    workload: z.string(),
    cycle_time: z.string(),
    stability: z.string(),
  }),
  pattern: z.object({
    classification: z.enum(["overloaded", "underutilized", "stable", "improving", "declining", "volatile"]),
    reason: z.string(),
  }),
  recommendations: z.array(z.string()),
  concerning_trends: z.array(z.string()),
});
export type PersonCumulativeReportOutput = z.infer<typeof PersonCumulativeReportOutputSchema>;

export const PERSON_CUMULATIVE_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two or three sentences giving the headline read on this person's trajectory — the thing a manager would want to know first.",
    },
    trajectory_overview: {
      type: "object",
      properties: {
        workload: {
          type: "string",
          description: "This person's own load_score/velocity/resolved_count pattern across their checkpoints — cite the actual range and specific checkpoints, not just the latest one.",
        },
        cycle_time: {
          type: "string",
          description: "This person's own cycle_time_hours pattern across checkpoints — is it consistently high, improving, worsening, or fine.",
        },
        stability: {
          type: "string",
          description: "Whether this person's own deltas show a steady pattern or volatility (big swings up and down) across checkpoints — cite specific transitions from deltas.",
        },
      },
      required: ["workload", "cycle_time", "stability"],
      additionalProperties: false,
    },
    pattern: {
      type: "object",
      properties: {
        classification: {
          type: "string",
          enum: ["overloaded", "underutilized", "stable", "improving", "declining", "volatile"],
          description: "The single best-fitting label for this person's trajectory as a whole, based only on the pattern actually visible across their points/deltas.",
        },
        reason: {
          type: "string",
          description: "One or two sentences grounding the classification in this person's specific points/deltas — cite checkpoints, not just the label.",
        },
      },
      required: ["classification", "reason"],
      additionalProperties: false,
    },
    recommendations: {
      type: "array",
      items: { type: "string" },
      description: "Specific, actionable recommendations grounded in the trajectory as a whole. You may name OTHER people as a redistribution target only if the data given actually supports it (their own load/weight is visible in this person's points) — never invent a teammate's situation you don't have data for.",
    },
    concerning_trends: {
      type: "array",
      items: { type: "string" },
      description: "Specific call-outs of things getting worse across consecutive checkpoints for this person, citing the checkpoints — only include a trend actually visible across multiple points, never a single-point observation.",
    },
  },
  required: ["summary", "trajectory_overview", "pattern", "recommendations", "concerning_trends"],
  additionalProperties: false,
} as const;
