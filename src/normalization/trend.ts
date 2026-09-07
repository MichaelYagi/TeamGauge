import type { TeamReport } from "../schema/canonical.js";

export interface SnapshotPoint {
  snapshot_date: string;
  sprint: string;
  report: TeamReport;
}

export interface TeamMetricPoint {
  snapshot_date: string;
  sprint: string;
  total_work_items: number;
  total_resolved: number;
  team_velocity: number;
  team_avg_cycle_time_hours: number;
}

export interface EngineerMetricPoint {
  snapshot_date: string;
  sprint: string;
  role: string;
  load_score: number;
  burnout_risk: string;
  resolved_count: number;
  velocity: number;
  cycle_time_hours: number;
}

export interface Delta {
  from_date: string;
  to_date: string;
  // Which sprint each side belongs to — NOT necessarily the same sprint.
  // Cross-sprint history (no --sprint filter) deliberately compares
  // different sprints when they're genuinely sequential in time; without
  // showing the labels, a reader has no way to tell that apart from a
  // meaningless jump (e.g. skipping straight from sprint 15 to sprint 18
  // because a bulk historical import gave sprint 16/17 dates that don't
  // sort between them) — a real, observed case where every row's dates
  // looked plausible but several were comparing unrelated sprints, reading
  // as "duplicate" noise rather than the actual cause.
  from_sprint: string;
  to_sprint: string;
  load_score_delta?: number;
  velocity_delta: number;
  resolved_count_delta?: number;
  cycle_time_hours_delta: number;
}

export interface EngineerTrend {
  name: string;
  points: EngineerMetricPoint[];
  deltas: Delta[];
}

export interface TeamTrend {
  team: string;
  points: TeamMetricPoint[];
  deltas: Delta[];
  engineers: EngineerTrend[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// A delta is only meaningful between two points that are actually ordered
// in time relative to each other. That holds whenever the dates differ
// (real time elapsed, whichever sprints are involved), and it holds for two
// same-date points IF they're the same sprint (a legitimate same-day
// re-check mid-sprint, which claude.md explicitly wants trend to show). It
// does NOT hold for two same-date points from DIFFERENT sprints: a CSV
// export spanning several sprints (see CSVProvider.ingestGroupedBySprint)
// saves one snapshot per sprint under one shared import date, and their
// relative order in the resulting array is just insertion order from that
// split — not chronological sprint order. Computing "sprint A → sprint B"
// across that pair reads as a real before/after comparison but is actually
// arbitrary (a real, observed case: two unrelated sprints from one bulk
// import looked like a same-day velocity/cycle-time collapse). Cross-sprint
// trend (no --sprint filter) still compares different sprints against each
// other — that's the whole point — just never two that share an import date.
function isMeaningfulPair(prev: { snapshot_date: string; sprint: string }, point: { snapshot_date: string; sprint: string }): boolean {
  return prev.snapshot_date !== point.snapshot_date || prev.sprint === point.sprint;
}

const UNASSIGNED = "Unassigned";

// Same reasoning as aggregate.ts's sortUnassignedLast: a backlog bucket
// reading as just another name in whatever order a Map happened to
// encounter it (here: whichever snapshot first mentioned it) is confusing
// mixed in among real engineers — always last, stable otherwise.
function sortUnassignedLast<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => Number(a.name === UNASSIGNED) - Number(b.name === UNASSIGNED));
}

// Deterministic — every number here is a difference between two already-
// computed snapshots (pure arithmetic). Judging whether a trend is "good"
// stays a reasoning-step job; this only supplies the deltas.
export function computeTrend(snapshotsInDateOrder: SnapshotPoint[]): TeamTrend {
  const teamPoints: TeamMetricPoint[] = snapshotsInDateOrder.map((s) => ({
    snapshot_date: s.snapshot_date,
    sprint: s.sprint,
    ...s.report.team_metrics,
  }));

  const teamDeltas: Delta[] = teamPoints.slice(1).flatMap((point, i) => {
    const prev = teamPoints[i];
    if (!isMeaningfulPair(prev, point)) return [];
    return [
      {
        from_date: prev.snapshot_date,
        to_date: point.snapshot_date,
        from_sprint: prev.sprint,
        to_sprint: point.sprint,
        velocity_delta: round(point.team_velocity - prev.team_velocity),
        resolved_count_delta: point.total_resolved - prev.total_resolved,
        cycle_time_hours_delta: round(point.team_avg_cycle_time_hours - prev.team_avg_cycle_time_hours),
      },
    ];
  });

  const byEngineer = new Map<string, EngineerMetricPoint[]>();
  for (const s of snapshotsInDateOrder) {
    for (const engineer of s.report.engineers) {
      const points = byEngineer.get(engineer.name) ?? [];
      points.push({
        snapshot_date: s.snapshot_date,
        sprint: s.sprint,
        role: engineer.role,
        load_score: engineer.derived_metrics.load_score,
        burnout_risk: engineer.derived_metrics.burnout_risk,
        resolved_count: engineer.derived_metrics.resolved_count,
        velocity: engineer.derived_metrics.velocity,
        cycle_time_hours: engineer.signals.cycle_time_hours,
      });
      byEngineer.set(engineer.name, points);
    }
  }

  const engineerNames = sortUnassignedLast(Array.from(byEngineer.keys()).map((name) => ({ name }))).map((e) => e.name);
  const engineers: EngineerTrend[] = engineerNames.map((name) => {
    const points = byEngineer.get(name)!;
    return {
      name,
      points,
      deltas: points.slice(1).flatMap((point, i) => {
        const prev = points[i];
        if (!isMeaningfulPair(prev, point)) return [];
        return [
          {
            from_date: prev.snapshot_date,
            to_date: point.snapshot_date,
            from_sprint: prev.sprint,
            to_sprint: point.sprint,
            load_score_delta: round(point.load_score - prev.load_score),
            velocity_delta: round(point.velocity - prev.velocity),
            resolved_count_delta: point.resolved_count - prev.resolved_count,
            cycle_time_hours_delta: round(point.cycle_time_hours - prev.cycle_time_hours),
          },
        ];
      }),
    };
  });

  return {
    team: snapshotsInDateOrder[0]?.report.team.name ?? "",
    points: teamPoints,
    deltas: teamDeltas,
    engineers,
  };
}
