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
}
