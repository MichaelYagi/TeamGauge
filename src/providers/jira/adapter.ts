import { isCompletingResolution, isUrgentPriorityName, type IssueAdapter } from "../common/issueAdapter.js";

// Adapter boundary so JiraProvider never hardcodes Jira field paths (per
// claude.md: "Do not hardcode Jira fields; use adapters"). Swap
// `defaultJiraAdapter` for a custom one if a Jira instance uses non-standard
// fields (e.g. a custom "Blocked" flag field instead of a status name).

export interface RawJiraIssue {
  [key: string]: unknown;
}

export interface JiraIssueAdapter extends IssueAdapter<RawJiraIssue> {
  getStatus(issue: RawJiraIssue): string;
  getPriority(issue: RawJiraIssue): string;
}

function fields(issue: RawJiraIssue): Record<string, unknown> {
  return (issue.fields as Record<string, unknown>) ?? {};
}

// Matches the shape returned by Jira's REST API (v2/v3) `search` endpoint.
export const defaultJiraAdapter: JiraIssueAdapter = {
  getAssignee(issue) {
    const assignee = fields(issue).assignee as { displayName?: string } | null;
    return assignee?.displayName ?? null;
  },
  getRole() {
    // Unknown until a roster supplies it (see src/normalization/roster.ts) —
    // never invent a title, since TeamGauge is team-agnostic.
    return "";
  },
  getStatus(issue) {
    const status = fields(issue).status as { name?: string } | undefined;
    return status?.name ?? "";
  },
  getPriority(issue) {
    const priority = fields(issue).priority as { name?: string } | undefined;
    return priority?.name ?? "";
  },
  getCreated(issue) {
    return (fields(issue).created as string | undefined) ?? null;
  },
  getResolved(issue) {
    const resolutiondate = (fields(issue).resolutiondate as string | undefined) ?? null;
    if (!resolutiondate) return null;
    // A resolution date alone doesn't mean the work was actually done —
    // Jira sets it on cancellation too (see isCompletingResolution).
    const resolution = fields(issue).resolution as { name?: string } | undefined;
    if (!isCompletingResolution(resolution?.name)) return null;
    return resolutiondate;
  },
  getContextKey(issue) {
    const project = fields(issue).project as { key?: string } | undefined;
    return project?.key ?? "unknown";
  },
  isUnplanned(issue) {
    const labels = (fields(issue).labels as string[] | undefined) ?? [];
    return labels.includes("unplanned");
  },
  isBlocked(issue) {
    const status = this.getStatus(issue).toLowerCase();
    return status.includes("block");
  },
  isUrgentPriority(issue) {
    return isUrgentPriorityName(this.getPriority(issue));
  },
  getProjectKey(issue) {
    const project = fields(issue).project as { key?: string } | undefined;
    return project?.key ?? null;
  },
  getIssueKey(issue) {
    // Jira REST issues carry "key" (e.g. "PDD-2424") at the top level, not
    // under fields — a stable identifier, unlike sprint's custom field.
    return (issue.key as string | undefined) ?? null;
  },
  // Not implemented: Jira's REST API exposes sprint via a custom field whose
  // ID varies per instance (commonly but not reliably customfield_10016) —
  // guessing it would violate "don't hardcode Jira fields." Sprint
  // auto-detection is only available via the CSV provider, where the
  // exported "Sprint" column name is stable. --sprint stays a required
  // manual input for JSON/URL/JQL sources.
};
