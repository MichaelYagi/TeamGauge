import type { Signals } from "../schema/canonical.js";

// Combines the same engineer's signals from multiple providers (e.g. Jira +
// CSV) into one set. Counts sum; rates are recomputed as weighted averages
// using work_items as the weight so a provider with more items counts more.
export function mergeSignals(a: Signals, b: Signals): Signals {
  const work_items = a.work_items + b.work_items;
  const weighted = (x: number, y: number) =>
    work_items === 0 ? 0 : (x * a.work_items + y * b.work_items) / work_items;

  return {
    work_items,
    cycle_time_hours: weighted(a.cycle_time_hours, b.cycle_time_hours),
    blocked_items: a.blocked_items + b.blocked_items,
    priority_pressure: a.work_items >= b.work_items ? a.priority_pressure : b.priority_pressure,
    context_switching_index: a.context_switching_index + b.context_switching_index,
    unplanned_work_ratio: weighted(a.unplanned_work_ratio, b.unplanned_work_ratio),
  };
}
