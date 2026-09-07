import { isCompletingResolution, isUrgentPriorityName, type IssueAdapter } from "../common/issueAdapter.js";
import { parseJiraCsvDate } from "./parseJiraDate.js";

// One row from a Jira CSV export, keyed by header name (see CSVProvider for
// how duplicate headers, e.g. repeated "Sprint" columns, are resolved).
export type CsvRow = Record<string, string>;

function field(row: CsvRow, name: string): string {
  return (row[name] ?? "").trim();
}

// Maps Jira's default CSV export headers. If your export renames or omits
// columns (e.g. no "Custom field (Flagged)"), pass a custom adapter to
// CSVProvider instead of hardcoding a fix here.
export const defaultJiraCsvAdapter: IssueAdapter<CsvRow> = {
  getAssignee(row) {
    const value = field(row, "Assignee");
    return value.length > 0 ? value : null;
  },
  getRole() {
    // Unknown until a roster supplies it (see src/normalization/roster.ts) —
    // never invent a title, since TeamGauge is team-agnostic.
    return "";
  },
  getCreated(row) {
    return parseJiraCsvDate(field(row, "Created"));
  },
  getResolved(row) {
    const resolved = field(row, "Resolved");
    if (resolved.length === 0) return null;
    // A resolution date alone doesn't mean the work was actually done —
    // Jira sets it on cancellation too (see isCompletingResolution).
    if (!isCompletingResolution(field(row, "Resolution"))) return null;
    return parseJiraCsvDate(resolved);
  },
  getContextKey(row) {
    const epic = field(row, "Custom field (Epic Link)");
    if (epic.length > 0) return epic;
    return field(row, "Project key") || "unknown";
  },
  isUnplanned(row) {
    const labels = field(row, "Labels").toLowerCase().split(/\s+/).filter(Boolean);
    return labels.includes("unplanned");
  },
  isBlocked(row) {
    const status = field(row, "Status").toLowerCase();
    const flagged = field(row, "Custom field (Flagged)");
    return status.includes("block") || flagged.length > 0;
  },
  isUrgentPriority(row) {
    return isUrgentPriorityName(field(row, "Priority"));
  },
  getStoryPoints(row) {
    const raw = field(row, "Custom field (Story Points)");
    if (raw.length === 0) return null;
    const points = Number(raw);
    return Number.isFinite(points) ? points : null;
  },
  getProjectKey(row) {
    const key = field(row, "Project key");
    return key.length > 0 ? key : null;
  },
  getSprintName(row) {
    // CSVProvider resolves the repeated "Sprint" columns (an issue's full
    // sprint history) down to the last non-empty one — the issue's current
    // sprint — before this adapter ever sees the row.
    const sprint = field(row, "Sprint");
    return sprint.length > 0 ? sprint : null;
  },
  getIssueKey(row) {
    const key = field(row, "Issue key");
    return key.length > 0 ? key : null;
  },
};
