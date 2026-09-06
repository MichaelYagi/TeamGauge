import type { IssueAdapter } from "./issueAdapter.js";

// Unanimous only — never a majority/mode guess. A CSV export commonly mixes
// an issue's entire sprint *history* into several raw "Sprint" columns; the
// adapter's getSprintName is expected to already resolve that down to each
// issue's current sprint (see the CSV adapter), so if every issue still
// doesn't agree here, the data is genuinely ambiguous and TeamGauge says so
// rather than picking one.
function unanimousValue<TIssue>(issues: TIssue[], getter?: (issue: TIssue) => string | null): string | undefined {
  if (!getter || issues.length === 0) return undefined;
  const values = new Set(issues.map((issue) => getter(issue)).filter((value): value is string => Boolean(value)));
  return values.size === 1 ? values.values().next().value : undefined;
}

export interface DetectedContext {
  team?: string;
  sprint?: string;
}

export function detectTeamAndSprint<TIssue>(issues: TIssue[], adapter: IssueAdapter<TIssue>): DetectedContext {
  return {
    team: unanimousValue(issues, adapter.getProjectKey?.bind(adapter)),
    sprint: unanimousValue(issues, adapter.getSprintName?.bind(adapter)),
  };
}
