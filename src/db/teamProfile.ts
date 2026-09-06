import { getDb } from "./connection.js";

export interface TeamProfile {
  name: string;
  sprint_length_days: number | null;
  charter: string | null;
}

export interface RosterEntryRow {
  engineer_name: string;
  role: string;
  weight: number | null;
  notes: string | null;
  effective_from: string;
  departed?: number;
}

export function createOrUpdateTeam(profile: TeamProfile, dbPath?: string): void {
  const db = getDb(dbPath);
  db.prepare(
    `INSERT INTO teams (name, sprint_length_days, charter, created_at)
     VALUES (@name, @sprint_length_days, @charter, @created_at)
     ON CONFLICT(name) DO UPDATE SET sprint_length_days = @sprint_length_days, charter = @charter`,
  ).run({ ...profile, created_at: new Date().toISOString() });
}

export function getTeam(name: string, dbPath?: string): TeamProfile | undefined {
  return getDb(dbPath).prepare(`SELECT name, sprint_length_days, charter FROM teams WHERE name = ?`).get(name) as
    | TeamProfile
    | undefined;
}

export function listTeams(dbPath?: string): TeamProfile[] {
  return getDb(dbPath).prepare(`SELECT name, sprint_length_days, charter FROM teams ORDER BY name`).all() as TeamProfile[];
}

// Adding a role is never an overwrite — it's a new dated row, so past
// snapshots stay historically accurate even after someone's role changes.
// A departure is the same mechanism: a dated row with departed=true, not a
// deletion — see markDeparted below.
export function addRosterEntry(
  teamName: string,
  entry: { engineer_name: string; role: string; weight?: number; notes?: string; effective_from: string; departed?: boolean },
  dbPath?: string,
): void {
  getDb(dbPath)
    .prepare(
      `INSERT INTO roster_entries (team_name, engineer_name, role, weight, notes, effective_from, departed)
       VALUES (@team_name, @engineer_name, @role, @weight, @notes, @effective_from, @departed)
       ON CONFLICT(team_name, engineer_name, effective_from) DO UPDATE SET role = @role, weight = @weight, notes = @notes, departed = @departed`,
    )
    .run({
      team_name: teamName,
      engineer_name: entry.engineer_name,
      role: entry.role,
      weight: entry.weight ?? null,
      notes: entry.notes ?? null,
      effective_from: entry.effective_from,
      departed: entry.departed ? 1 : 0,
    });
}

// A departure is just a dated roster fact, like a role change — this is a
// thin, clearly-named wrapper over addRosterEntry for that specific case.
// Reactivating someone needs no special function: a later addRosterEntry
// call (a normal role update) already supersedes an earlier departure row,
// since getRosterAsOf always takes the latest entry as of a given date.
export function markDeparted(teamName: string, engineerName: string, effectiveFrom: string, dbPath?: string): void {
  addRosterEntry(teamName, { engineer_name: engineerName, role: "", effective_from: effectiveFrom, departed: true }, dbPath);
}

function latestEntriesAsOf(teamName: string, asOfDate: string, dbPath?: string): RosterEntryRow[] {
  const rows = getDb(dbPath)
    .prepare(
      `SELECT engineer_name, role, weight, notes, effective_from, departed
       FROM roster_entries
       WHERE team_name = ? AND effective_from <= ?
       ORDER BY engineer_name, effective_from DESC`,
    )
    .all(teamName, asOfDate) as RosterEntryRow[];

  const latestByEngineer = new Map<string, RosterEntryRow>();
  for (const row of rows) {
    if (!latestByEngineer.has(row.engineer_name)) latestByEngineer.set(row.engineer_name, row);
  }
  return Array.from(latestByEngineer.values());
}

// Point-in-time lookup: the most recent entry for this person that was
// already in effect on `asOfDate` — this is what makes historical reports
// stay correct even after a role change. Excludes anyone whose latest entry
// as of that date is a departure — see getDepartedAsOf for those.
export function getRosterAsOf(teamName: string, asOfDate: string, dbPath?: string): RosterEntryRow[] {
  return latestEntriesAsOf(teamName, asOfDate, dbPath).filter((row) => !row.departed);
}

// The inverse of getRosterAsOf: everyone whose latest entry as of this date
// marks them departed. Used to keep departed people out of the default
// roster view / name-autocomplete while still letting them be found and
// reactivated deliberately.
export function getDepartedAsOf(teamName: string, asOfDate: string, dbPath?: string): RosterEntryRow[] {
  return latestEntriesAsOf(teamName, asOfDate, dbPath).filter((row) => Boolean(row.departed));
}
