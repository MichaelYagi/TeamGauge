import { getDb } from "./connection.js";
import type { TeamReport } from "../schema/canonical.js";
import type { EngineerMetricPoint, TeamTrend } from "../normalization/trend.js";
import { deriveMetrics } from "../normalization/deriveMetrics.js";

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

// report_json.engineers[].role (and per-point role in a TeamTrend) is frozen
// the moment a snapshot is analyzed. If a roster role is added or corrected
// afterward — including a backdated entry meant to apply retroactively — an
// already-saved snapshot's embedded role stays stale forever unless that
// exact snapshot is re-analyzed. Every read path that shows role for
// display/context (history, trend, and reasoning prompts, in both the
// server and the CLI) shows the current best-known role as of that point's
// own date instead, falling back to the frozen value only when no roster
// entry covers that date at all — so a name never goes from showing
// something to showing nothing.
export function currentRoleAsOf(teamName: string, engineerName: string, asOfDate: string, fallback: string, dbPath?: string): string {
  const row = getRosterAsOf(teamName, asOfDate, dbPath).find((r) => r.engineer_name === engineerName);
  return row?.role || fallback;
}

// Same point-in-time idea as currentRoleAsOf, for weight — but weight can't
// be relabeled in isolation the way role can: load_score is computed as
// rawLoadScore * weight (see deriveMetrics), so overlaying a corrected
// weight number without also recomputing load_score/burnout_risk to match
// would leave a snapshot showing a weight that doesn't agree with the
// load_score sitting right next to it. This was a real, caught gap — a
// first version of the weight fix only relabeled the frozen weight field,
// which a live check against a real team immediately proved didn't work
// (the roster showed corrected weights of 3-4, but every saved snapshot's
// weight still read 1, because relabeling never touched the underlying
// snapshot's derived_metrics at all). null return means "no roster entry
// covers this date" — the caller keeps the frozen weight/load_score as-is.
function currentWeightAsOf(teamName: string, engineerName: string, asOfDate: string, dbPath?: string): number | null {
  const row = getRosterAsOf(teamName, asOfDate, dbPath).find((r) => r.engineer_name === engineerName);
  return row?.weight ?? null;
}

// Recomputes weight/load_score/burnout_risk together from a point's own
// immutable signals (see EngineerMetricPoint.signals) using the CURRENT
// roster weight as of that point's date, via the same deriveMetrics used at
// analyze time — never just relabeling weight, which would desync it from
// load_score. Falls back to the frozen values whenever no roster entry
// covers this date, so a correction is additive (can only replace 1/1 with
// a real number), never destructive.
function recomputeWeightedMetrics(
  teamName: string,
  engineerName: string,
  asOfDate: string,
  point: Pick<EngineerMetricPoint, "signals" | "weight" | "load_score" | "burnout_risk" | "resolved_count" | "velocity">,
  dbPath?: string,
): Pick<EngineerMetricPoint, "weight" | "load_score" | "burnout_risk"> {
  const currentWeight = currentWeightAsOf(teamName, engineerName, asOfDate, dbPath);
  if (currentWeight === null) return { weight: point.weight, load_score: point.load_score, burnout_risk: point.burnout_risk };
  const recomputed = deriveMetrics(point.signals, currentWeight, point.resolved_count, point.velocity);
  return { weight: recomputed.weight, load_score: recomputed.load_score, burnout_risk: recomputed.burnout_risk };
}

// Overlays BOTH role and weight-dependent metrics (load_score/burnout_risk
// recomputed to stay consistent with the corrected weight) onto a computed
// TeamTrend — see currentRoleAsOf/recomputeWeightedMetrics above for why
// each needs different treatment. Used by every read path that shows a
// saved team's trend for display or reasoning (history, trend, and
// cumulative/person reasoning prompts, in both the server and the CLI) so
// a roster correction applies retroactively the way the UI's own "applies
// to every sprint for this team, past and future" message promises,
// without ever re-analyzing or rewriting the underlying saved snapshot.
export function overlayCurrentRosterFacts(teamName: string, trend: TeamTrend, dbPath?: string): TeamTrend {
  return {
    ...trend,
    engineers: trend.engineers.map((e) => ({
      ...e,
      points: e.points.map((p) => ({
        ...p,
        role: currentRoleAsOf(teamName, e.name, p.snapshot_date, p.role, dbPath),
        ...recomputeWeightedMetrics(teamName, e.name, p.snapshot_date, p, dbPath),
      })),
    })),
  };
}

// Same overlay, but for a single full TeamReport rather than a trend — used
// right before handing a saved snapshot's report to reasonAboutReport, so
// the model sees each person's actual discipline (e.g. QA vs. software
// engineer) and a load_score consistent with their corrected weight,
// instead of stale values frozen in from before the roster was filled out.
export function overlayCurrentRosterFactsOnReport(teamName: string, asOfDate: string, report: TeamReport, dbPath?: string): TeamReport {
  return {
    ...report,
    engineers: report.engineers.map((e) => {
      const currentWeight = currentWeightAsOf(teamName, e.name, asOfDate, dbPath);
      const derived =
        currentWeight === null
          ? e.derived_metrics
          : deriveMetrics(e.signals, currentWeight, e.derived_metrics.resolved_count, e.derived_metrics.velocity);
      return {
        ...e,
        role: currentRoleAsOf(teamName, e.name, asOfDate, e.role, dbPath),
        derived_metrics: derived,
      };
    }),
  };
}
