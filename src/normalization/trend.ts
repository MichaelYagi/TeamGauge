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

// Deterministic — every number here is a difference between two already-
// computed snapshots (pure arithmetic). Judging whether a trend is "good"
// stays a reasoning-step job; this only supplies the deltas.
export function computeTrend(snapshotsInDateOrder: SnapshotPoint[]): TeamTrend {
  const teamPoints: TeamMetricPoint[] = snapshotsInDateOrder.map((s) => ({
    snapshot_date: s.snapshot_date,
    sprint: s.sprint,
    ...s.report.team_metrics,
  }));

  const teamDeltas: Delta[] = teamPoints.slice(1).map((point, i) => {
    const prev = teamPoints[i];
    return {
      from_date: prev.snapshot_date,
      to_date: point.snapshot_date,
      velocity_delta: round(point.team_velocity - prev.team_velocity),
      resolved_count_delta: point.total_resolved - prev.total_resolved,
      cycle_time_hours_delta: round(point.team_avg_cycle_time_hours - prev.team_avg_cycle_time_hours),
    };
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

  const engineers: EngineerTrend[] = Array.from(byEngineer.entries()).map(([name, points]) => ({
    name,
    points,
    deltas: points.slice(1).map((point, i) => {
      const prev = points[i];
      return {
        from_date: prev.snapshot_date,
        to_date: point.snapshot_date,
        load_score_delta: round(point.load_score - prev.load_score),
        velocity_delta: round(point.velocity - prev.velocity),
        resolved_count_delta: point.resolved_count - prev.resolved_count,
        cycle_time_hours_delta: round(point.cycle_time_hours - prev.cycle_time_hours),
      };
    }),
  }));

  return {
    team: snapshotsInDateOrder[0]?.report.team.name ?? "",
    points: teamPoints,
    deltas: teamDeltas,
    engineers,
  };
}
