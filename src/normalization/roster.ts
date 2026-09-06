import { readFile } from "node:fs/promises";
import { RosterSchema, type Roster } from "../schema/roster.js";

export async function loadRoster(filePath: string): Promise<Roster> {
  const raw = JSON.parse(await readFile(filePath, "utf-8"));
  return RosterSchema.parse(raw);
}

export interface ResolvedRoster {
  role: string;
  weight: number;
  notes: string;
}

// Role is only ever a known fact, never invented: a name missing from the
// roster (role info "might not always be available", per design intent)
// keeps whatever the provider reported — "" for a real person with no known
// role, or the "Unassigned" sentinel for the backlog bucket — and weight
// defaults to 1 (no adjustment to load_score). `notes` defaults to "" and is
// never invented either — it's reasoning-step context, not a signal.
export function resolveRosterEntry(name: string, providerRole: string, roster?: Roster): ResolvedRoster {
  const entry = roster?.[name];
  if (entry === undefined) return { role: providerRole, weight: 1, notes: "" };
  if (typeof entry === "string") return { role: entry, weight: 1, notes: "" };
  return { role: entry.role, weight: entry.weight ?? 1, notes: entry.notes ?? "" };
}
