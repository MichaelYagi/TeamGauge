import type { Signals } from "../schema/canonical.js";
import type { Engineer } from "../schema/canonical.js";

// Deterministic derivation, not reasoning: a fixed formula over signals, no
// LLM involved. This is a first-pass heuristic and a reasonable candidate to
// tune once run against real team data.
const PRESSURE_WEIGHT: Record<string, number> = { low: 0, medium: 15, high: 30 };

// `weight` is a per-role capacity/tolerance multiplier from the roster
// (defaults to 1 = no adjustment). Below 1 means the same raw workload reads
// as lower load for that role (e.g. a senior handling it comfortably);
// above 1 means it reads as higher. The user defines the number — TeamGauge
// never invents a seniority hierarchy on its own.
export function deriveMetrics(
  signals: Signals,
  weight = 1,
  resolved_count = 0,
  velocity = 0,
): Engineer["derived_metrics"] {
  const rawLoadScore =
    signals.work_items * 2 +
    signals.blocked_items * 5 +
    signals.context_switching_index * 3 +
    signals.unplanned_work_ratio * 20 +
    (PRESSURE_WEIGHT[signals.priority_pressure] ?? 0);

  const load_score = rawLoadScore * weight;
  const burnout_risk = load_score >= 80 ? "high" : load_score >= 40 ? "medium" : "low";

  return { load_score, burnout_risk, resolved_count, velocity, weight };
}
