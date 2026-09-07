import type { Engineer, ReportsPayload, TeamReport } from "../schema/canonical.js";
import { emptyRecommendations, emptyTeamRecommendations } from "../schema/canonical.js";
import type { EngineerSignals, ProviderResult } from "../providers/types.js";
import type { Roster } from "../schema/roster.js";
import { deriveMetrics } from "./deriveMetrics.js";
import { mergeSignals } from "./mergeSignals.js";
import { resolveRosterEntry } from "./roster.js";
import { computeTeamMetrics } from "./teamMetrics.js";

export interface TeamMeta {
  name: string;
  sprint: string;
}

const UNASSIGNED = "Unassigned";

// "Unassigned" is a backlog bucket, not a teammate — it reads oddly mixed
// in among real people in whatever order a Map happened to encounter names
// (arbitrary — the first issue in the source that has no assignee decides
// where it lands). Always last, stable otherwise so real engineers keep
// whatever order they were already in.
function sortUnassignedLast<T extends { name: string }>(engineers: T[]): T[] {
  return [...engineers].sort((a, b) => Number(a.name === UNASSIGNED) - Number(b.name === UNASSIGNED));
}

// Merges results from one or more providers into a single set of
// per-engineer signals, keyed by engineer name.
function mergeProviderResults(results: ProviderResult[]): EngineerSignals[] {
  const byName = new Map<string, EngineerSignals>();
  for (const result of results) {
    for (const engineer of result.engineers) {
      const existing = byName.get(engineer.name);
      byName.set(
        engineer.name,
        existing
          ? {
              ...existing,
              signals: mergeSignals(existing.signals, engineer.signals),
              resolved_count: existing.resolved_count + engineer.resolved_count,
              velocity: existing.velocity + engineer.velocity,
            }
          : engineer,
      );
    }
  }
  return Array.from(byName.values());
}

export function buildTeamReport(
  team: TeamMeta,
  providerResults: ProviderResult[],
  roster?: Roster,
): TeamReport {
  const mergedEngineers = sortUnassignedLast(mergeProviderResults(providerResults));

  const engineers: Engineer[] = mergedEngineers.map((engineer) => {
    const { role, weight } = resolveRosterEntry(engineer.name, engineer.role, roster);
    return {
      name: engineer.name,
      role,
      signals: engineer.signals,
      derived_metrics: deriveMetrics(engineer.signals, weight, engineer.resolved_count, engineer.velocity),
      recommendations: emptyRecommendations(),
    };
  });

  return {
    team: { name: team.name, sprint: team.sprint, members: engineers.length },
    engineers,
    team_metrics: computeTeamMetrics(mergedEngineers),
    team_recommendations: emptyTeamRecommendations(),
  };
}

export function buildReportsPayload(reports: TeamReport[]): ReportsPayload {
  return { reports };
}
