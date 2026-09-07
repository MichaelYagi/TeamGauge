// Jira sets an issue's "resolutiondate" whenever it's moved to ANY
// resolved-category status — including a cancellation, not just a
// completion. A ticket closed as "Won't Do" (or "Won't Fix"/"Duplicate"/
// "Cannot Reproduce"/etc.) has a resolution date exactly like a ticket
// actually finished, but counting it as completed work inflates
// resolved_count/velocity for whoever it was assigned to with a ticket they
// never actually did — confirmed against a real export where an engineer's
// only "resolved" ticket that sprint was a Won't Do, making them look like
// they'd delivered something when they'd delivered nothing.
// These are Jira Cloud's own default resolution values (not a per-instance
// custom field id — the thing claude.md forbids hardcoding — "Resolution"
// is a standard field present in virtually every Jira instance), matched
// case-insensitively so a workflow's own casing doesn't matter. Not
// exhaustive — a team with unusual custom resolutions can supply their own
// adapter — but this covers Jira's actual shipped defaults.
const NON_COMPLETING_RESOLUTION_KEYWORDS = ["won't", "wont", "duplicate", "cannot reproduce", "can't reproduce", "invalid", "rejected", "declined", "incomplete", "not a bug"];

export function isCompletingResolution(resolution: string | null | undefined): boolean {
  if (!resolution) return true; // no resolution value on record — don't guess it away, treat presence of a resolved date as the signal.
  const normalized = resolution.trim().toLowerCase();
  return !NON_COMPLETING_RESOLUTION_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

// Jira ships two different default priority schemes depending on product/
// version — Highest/High/Medium/Low/Lowest (Jira Software) and Blocker/
// Critical/Major/Minor/Trivial (the older/ITSM-style scheme) — and some
// instances mix both lists together (confirmed against a real export: High,
// Major, Blocker, Critical, and Medium all present on the same 39 issues).
// Both adapters previously only matched Blocker/Critical/High/Highest,
// silently treating every "Major" issue (31% of that real export) as
// non-urgent — a real, meaningful gap since it can flip an individual
// engineer's priority_pressure bucket. Matched case-insensitively; this is
// about Jira's own shipped priority names, not a per-instance custom field.
const URGENT_PRIORITY_NAMES = new Set(["blocker", "critical", "major", "high", "highest"]);

export function isUrgentPriorityName(priority: string | null | undefined): boolean {
  return URGENT_PRIORITY_NAMES.has((priority ?? "").trim().toLowerCase());
}

// Shared adapter contract so every provider's issue-shaped source (Jira
// REST/JSON, a CSV row, ...) can be normalized without hardcoding a specific
// source's field names into the signal-computation logic.
export interface IssueAdapter<TIssue> {
  getAssignee(issue: TIssue): string | null;
  getRole(issue: TIssue): string;
  getCreated(issue: TIssue): string | null;
  getResolved(issue: TIssue): string | null;
  getContextKey(issue: TIssue): string;
  isUnplanned(issue: TIssue): boolean;
  isBlocked(issue: TIssue): boolean;
  isUrgentPriority(issue: TIssue): boolean;
  // Optional: number of story points on this issue, or null if untracked.
  // When absent (or null for every issue), velocity falls back to a plain
  // resolved-item count — never an invented estimate.
  getStoryPoints?(issue: TIssue): number | null;
  // Optional: this issue's project key and *current* sprint (not sprint
  // history — a re-sprinted issue has moved through several). Used only to
  // auto-suggest --team-name/--sprint when every issue in the source agrees
  // on the same value; if the source has multiple project keys or the
  // adapter can't determine sprint, that ambiguity is surfaced, not guessed
  // through — see src/providers/common/detect.ts.
  getProjectKey?(issue: TIssue): string | null;
  getSprintName?(issue: TIssue): string | null;
  // Optional: this issue's stable unique identifier (Jira's "Issue key",
  // e.g. "PDD-2424"). Only used to de-duplicate when merging multiple
  // uploaded files into one analysis (see CSVProvider.ingestFiles) — two
  // overlapping exports of the same board will both contain the same
  // issues, and without dedup those issues would be double-counted in
  // every signal. Absent means "don't know how to dedupe this source,"
  // never a guess at identity.
  getIssueKey?(issue: TIssue): string | null;
}
