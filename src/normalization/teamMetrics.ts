import type { TeamMetrics } from "../schema/canonical.js";
import type { EngineerSignals } from "../providers/types.js";

// Deterministic team-wide rollup — sums and a resolved-count-weighted
// average, nothing invented. Includes every entry in `engineers`, including
// the "Unassigned" bucket, since its item count is real team throughput
// regardless of whose name is on it.
export function computeTeamMetrics(engineers: EngineerSignals[]): TeamMetrics {
  const total_work_items = engineers.reduce((sum, e) => sum + e.signals.work_items, 0);
  const total_resolved = engineers.reduce((sum, e) => sum + e.resolved_count, 0);
  const team_velocity = engineers.reduce((sum, e) => sum + e.velocity, 0);

  const weightedCycleTime = engineers.reduce((sum, e) => sum + e.signals.cycle_time_hours * e.resolved_count, 0);
  const team_avg_cycle_time_hours = total_resolved > 0 ? weightedCycleTime / total_resolved : 0;

  return { total_work_items, total_resolved, team_velocity, team_avg_cycle_time_hours };
}
