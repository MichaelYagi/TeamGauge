import { z } from "zod";

// Free-form role labels on purpose: TeamGauge is team-agnostic (claude.md),
// so a role is whatever a team calls its own levels ("Lead SDET", "PM", "L2
// Support", ...) — never a fixed enum of engineering titles.
//
// An entry is either a plain role string (weight defaults to 1, i.e. no
// adjustment — this is what every existing roster file already looks like),
// or an object when a capacity/tolerance weight and/or a work-pattern note
// is also known. `notes` is free text fed to the reasoning step as ground
// truth (e.g. "tests in the back half of the sprint, not the front") so it
// doesn't misread a role's normal cadence as underperformance.
export const RosterEntrySchema = z.union([
  z.string(),
  z.object({ role: z.string(), weight: z.number().positive().optional(), notes: z.string().optional() }),
]);
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const RosterSchema = z.record(z.string(), RosterEntrySchema);
export type Roster = z.infer<typeof RosterSchema>;
