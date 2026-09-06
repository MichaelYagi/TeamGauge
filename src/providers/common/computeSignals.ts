import type { Signals } from "../../schema/canonical.js";
import type { EngineerSignals } from "../types.js";
import type { IssueAdapter } from "./issueAdapter.js";

// Deterministic, reasoning-free signal computation (per claude.md's
// "reasoning-free ingestion" principle) — pure counting/averaging over
// issues, no LLM involved. These are heuristic definitions and may need
// tuning once run against real data:
//   - cycle_time_hours: mean (resolved - created) over resolved issues
//   - priority_pressure: "high"/"medium"/"low" bucket by share of urgent issues
//   - context_switching_index: distinct project/epic keys touched
//   - unplanned_work_ratio: share of issues flagged unplanned by the adapter
//   - velocity: sum of story points on resolved issues if the adapter knows
//     story points, else a plain resolved-item count (still deterministic —
//     no estimate is invented when the source doesn't track points)

function bucketPriorityPressure(urgentRatio: number): string {
  if (urgentRatio >= 0.5) return "high";
  if (urgentRatio >= 0.2) return "medium";
  return "low";
}

interface IssueSignalStats {
  signals: Signals;
  resolved_count: number;
  velocity: number;
}

export function computeSignalsForIssues<TIssue>(
  issues: TIssue[],
  adapter: IssueAdapter<TIssue>,
): IssueSignalStats {
  const work_items = issues.length;

  const resolvedIssues = issues.filter((issue) => adapter.getResolved(issue) !== null);
  const resolved_count = resolvedIssues.length;

  const resolvedDurationsHours = resolvedIssues
    .map((issue) => {
      const created = adapter.getCreated(issue);
      const resolved = adapter.getResolved(issue);
      if (!created || !resolved) return null;
      const hours = (new Date(resolved).getTime() - new Date(created).getTime()) / 3_600_000;
      return Number.isFinite(hours) && hours >= 0 ? hours : null;
    })
    .filter((hours): hours is number => hours !== null);

  const cycle_time_hours =
    resolvedDurationsHours.length > 0
      ? resolvedDurationsHours.reduce((sum, hours) => sum + hours, 0) / resolvedDurationsHours.length
      : 0;

  const blocked_items = issues.filter((issue) => adapter.isBlocked(issue)).length;

  const urgentCount = issues.filter((issue) => adapter.isUrgentPriority(issue)).length;
  const priority_pressure = bucketPriorityPressure(work_items > 0 ? urgentCount / work_items : 0);

  const context_switching_index = new Set(issues.map((issue) => adapter.getContextKey(issue))).size;

  const unplannedCount = issues.filter((issue) => adapter.isUnplanned(issue)).length;
  const unplanned_work_ratio = work_items > 0 ? unplannedCount / work_items : 0;

  const storyPoints = adapter.getStoryPoints
    ? resolvedIssues.map((issue) => adapter.getStoryPoints!(issue)).filter((points): points is number => points !== null)
    : [];
  const velocity =
    storyPoints.length > 0 ? storyPoints.reduce((sum, points) => sum + points, 0) : resolved_count;

  return {
    signals: {
      work_items,
      cycle_time_hours,
      blocked_items,
      priority_pressure,
      context_switching_index,
      unplanned_work_ratio,
    },
    resolved_count,
    velocity,
  };
}

const UNASSIGNED = "Unassigned";

export function groupIssuesByEngineer<TIssue>(
  issues: TIssue[],
  adapter: IssueAdapter<TIssue>,
): EngineerSignals[] {
  const byAssignee = new Map<string, TIssue[]>();
  for (const issue of issues) {
    const assignee = adapter.getAssignee(issue) ?? UNASSIGNED;
    const group = byAssignee.get(assignee) ?? [];
    group.push(issue);
    byAssignee.set(assignee, group);
  }

  return Array.from(byAssignee.entries()).map(([name, groupIssues]) => {
    const stats = computeSignalsForIssues(groupIssues, adapter);
    return {
      name,
      // "Unassigned" is a backlog bucket, not a teammate — tag its role
      // distinctly so downstream reasoning doesn't mistake it for a person.
      role: name === UNASSIGNED ? UNASSIGNED : adapter.getRole(groupIssues[0]),
      signals: stats.signals,
      resolved_count: stats.resolved_count,
      velocity: stats.velocity,
    };
  });
}
