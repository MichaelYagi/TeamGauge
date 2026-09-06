import { getDb } from "./connection.js";
import type { TeamReport } from "../schema/canonical.js";

export interface SnapshotRow {
  id: number;
  team_name: string;
  sprint: string;
  snapshot_date: string;
  sprint_start_date: string | null;
  report_json: string;
  created_at: string;
}

export interface SaveSnapshotInput {
  team_name: string;
  sprint: string;
  snapshot_date: string;
  sprint_start_date?: string;
  report: TeamReport;
}

// Snapshots are append-only: analyzing the same sprint again — even the same
// day — adds a new row rather than overwriting. That's what lets a manager
// update the same sprint mid-way and lets a later `trend` show genuine
// within-sprint progression, not just sprint-over-sprint.
export function saveSnapshot(input: SaveSnapshotInput, dbPath?: string): number {
  const db = getDb(dbPath);
  const result = db
    .prepare(
      `INSERT INTO snapshots (team_name, sprint, snapshot_date, sprint_start_date, report_json, created_at)
       VALUES (@team_name, @sprint, @snapshot_date, @sprint_start_date, @report_json, @created_at)`,
    )
    .run({
      team_name: input.team_name,
      sprint: input.sprint,
      snapshot_date: input.snapshot_date,
      sprint_start_date: input.sprint_start_date ?? null,
      report_json: JSON.stringify(input.report),
      created_at: new Date().toISOString(),
    });
  return Number(result.lastInsertRowid);
}

// Used after the reasoning step to bake recommendations into the historical
// record — same data point (same row), enriched, not a new one.
export function updateSnapshotReport(id: number, report: TeamReport, dbPath?: string): void {
  getDb(dbPath).prepare(`UPDATE snapshots SET report_json = ? WHERE id = ?`).run(JSON.stringify(report), id);
}

export function listSnapshots(teamName: string, sprint?: string, dbPath?: string): SnapshotRow[] {
  const db = getDb(dbPath);
  return sprint
    ? (db
        .prepare(`SELECT * FROM snapshots WHERE team_name = ? AND sprint = ? ORDER BY snapshot_date, id`)
        .all(teamName, sprint) as SnapshotRow[])
    : (db.prepare(`SELECT * FROM snapshots WHERE team_name = ? ORDER BY snapshot_date, id`).all(teamName) as SnapshotRow[]);
}

export function getLatestSnapshot(teamName: string, sprint?: string, dbPath?: string): SnapshotRow | undefined {
  const rows = listSnapshots(teamName, sprint, dbPath);
  return rows.at(-1);
}

export function getSnapshotById(id: number, dbPath?: string): SnapshotRow | undefined {
  return getDb(dbPath).prepare(`SELECT * FROM snapshots WHERE id = ?`).get(id) as SnapshotRow | undefined;
}

// Every engineer name ever seen in one of this team's saved reports —
// discovered from the data, not the roster. Used to populate the roster
// view/name-suggestions with real people instead of requiring the user to
// retype a Jira handle from memory (and risk a silent typo-mismatch).
// "Unassigned" is a backlog bucket, not a person — excluded.
const UNASSIGNED = "Unassigned";

export function listKnownEngineers(teamName: string, dbPath?: string): string[] {
  const rows = listSnapshots(teamName, undefined, dbPath);
  const names = new Set<string>();
  for (const row of rows) {
    const report = JSON.parse(row.report_json) as TeamReport;
    for (const engineer of report.engineers) {
      if (engineer.name !== UNASSIGNED) names.add(engineer.name);
    }
  }
  return Array.from(names).sort();
}

// An exact team+sprint+date collision is almost always an accidental
// re-import, not a legitimate mid-sprint check-in (those land on a
// different date) — used to warn/block before adding a duplicate-looking
// row, without stopping a deliberate same-day re-run via --force.
export function findSnapshotByDate(
  teamName: string,
  sprint: string,
  snapshotDate: string,
  dbPath?: string,
): SnapshotRow | undefined {
  return getDb(dbPath)
    .prepare(`SELECT * FROM snapshots WHERE team_name = ? AND sprint = ? AND snapshot_date = ?`)
    .get(teamName, sprint, snapshotDate) as SnapshotRow | undefined;
}
