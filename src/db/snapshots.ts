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
  sprint_goal: string | null;
  blocked_by: string | null;
}

export interface SaveSnapshotInput {
  team_name: string;
  sprint: string;
  snapshot_date: string;
  sprint_start_date?: string;
  report: TeamReport;
  sprint_goal?: string;
  blocked_by?: string;
}

// Snapshots are append-only: analyzing the same sprint again — even the same
// day — adds a new row rather than overwriting. That's what lets a manager
// update the same sprint mid-way and lets a later `trend` show genuine
// within-sprint progression, not just sprint-over-sprint.
export function saveSnapshot(input: SaveSnapshotInput, dbPath?: string): number {
  const db = getDb(dbPath);
  const result = db
    .prepare(
      `INSERT INTO snapshots (team_name, sprint, snapshot_date, sprint_start_date, report_json, created_at, sprint_goal, blocked_by)
       VALUES (@team_name, @sprint, @snapshot_date, @sprint_start_date, @report_json, @created_at, @sprint_goal, @blocked_by)`,
    )
    .run({
      team_name: input.team_name,
      sprint: input.sprint,
      snapshot_date: input.snapshot_date,
      sprint_start_date: input.sprint_start_date ?? null,
      report_json: JSON.stringify(input.report),
      created_at: new Date().toISOString(),
      sprint_goal: input.sprint_goal ?? null,
      blocked_by: input.blocked_by ?? null,
    });
  return Number(result.lastInsertRowid);
}

// sprint_goal/blocked_by are commitment/dependency facts about the sprint as
// a whole, distinct from a role/weight change — they're set once an
// analyzed snapshot already exists, often after the fact, so this is an
// UPDATE on the existing row, not a new append-only observation.
export function updateSnapshotContext(
  id: number,
  fields: { sprint_goal?: string; blocked_by?: string },
  dbPath?: string,
): void {
  const db = getDb(dbPath);
  if (fields.sprint_goal !== undefined) {
    db.prepare(`UPDATE snapshots SET sprint_goal = ? WHERE id = ?`).run(fields.sprint_goal, id);
  }
  if (fields.blocked_by !== undefined) {
    db.prepare(`UPDATE snapshots SET blocked_by = ? WHERE id = ?`).run(fields.blocked_by, id);
  }
}

export interface EngineerSnapshotContext {
  pto_days: number | null;
  on_call: boolean;
}

// PTO days and on-call status are true for ONE sprint, not the person in
// general — that's what separates this from roster_entries.notes (a
// standing work-pattern fact). Upsert keyed on (snapshot_id, engineer_name):
// setting it twice for the same snapshot corrects the fact, it doesn't
// create a second one, since there's only ever one "how was this sprint"
// answer per person per snapshot.
export function setEngineerSnapshotContext(
  snapshotId: number,
  engineerName: string,
  fields: { ptoDays?: number; onCall?: boolean },
  dbPath?: string,
): void {
  getDb(dbPath)
    .prepare(
      `INSERT INTO snapshot_engineer_context (snapshot_id, engineer_name, pto_days, on_call)
       VALUES (@snapshot_id, @engineer_name, @pto_days, @on_call)
       ON CONFLICT(snapshot_id, engineer_name) DO UPDATE SET pto_days = @pto_days, on_call = @on_call`,
    )
    .run({
      snapshot_id: snapshotId,
      engineer_name: engineerName,
      pto_days: fields.ptoDays ?? null,
      on_call: fields.onCall ? 1 : 0,
    });
}

export function getEngineerSnapshotContext(
  snapshotId: number,
  dbPath?: string,
): Record<string, EngineerSnapshotContext> {
  const rows = getDb(dbPath)
    .prepare(`SELECT engineer_name, pto_days, on_call FROM snapshot_engineer_context WHERE snapshot_id = ?`)
    .all(snapshotId) as Array<{ engineer_name: string; pto_days: number | null; on_call: number }>;
  return Object.fromEntries(rows.map((row) => [row.engineer_name, { pto_days: row.pto_days, on_call: Boolean(row.on_call) }]));
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

// The one deliberate escape hatch out of "append-only": a snapshot that
// should never have existed at all (a confirmed accidental duplicate, a
// stale-labeled row from before renameSprintLabel fixed up its embedded
// JSON, etc.) needs a way out that isn't "hand-edit the sqlite file" —
// this is that way out, not a routine correction path. There is no
// undelete; the caller is expected to have already confirmed the row is
// genuinely disposable (e.g. via findByteIdenticalSnapshot) before calling
// this.
export function deleteSnapshot(id: number, dbPath?: string): boolean {
  const db = getDb(dbPath);
  db.prepare(`DELETE FROM snapshot_engineer_context WHERE snapshot_id = ?`).run(id);
  const result = db.prepare(`DELETE FROM snapshots WHERE id = ?`).run(id);
  return result.changes > 0;
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

// Every distinct sprint label ever saved for a team — used to catch sprint
// label drift before it happens (see findSimilarSprint below), not just to
// browse. A team's real sprints don't change identity day to day; if a
// freshly resolved label doesn't exactly match one already on file, that's
// worth surfacing before it silently fragments history into two labels for
// what both agree is the same sprint.
export function listKnownSprints(teamName: string, dbPath?: string): string[] {
  const rows = getDb(dbPath)
    .prepare(`SELECT DISTINCT sprint FROM snapshots WHERE team_name = ?`)
    .all(teamName) as Array<{ sprint: string }>;
  return rows.map((row) => row.sprint);
}

// Catches exactly the failure this was built for: one run resolves a sprint
// as "26.18" (typed by hand, or a source that only carries the short form)
// and another resolves the same real sprint as "BDPSA Sprint 26.18" (the
// full name auto-detected from a CSV's Sprint column) — same sprint, two
// labels, silently fragmenting that team's history into two parallel
// threads. A plain substring check catches the common shape of this
// (one label contains the other) without trying to be a general fuzzy
// matcher. Returns the existing label it's suspiciously similar to, or
// undefined if the resolved label is either new or an exact match already.
export function findSimilarSprint(teamName: string, resolvedSprint: string, dbPath?: string): string | undefined {
  const known = listKnownSprints(teamName, dbPath);
  const target = resolvedSprint.toLowerCase();
  return known.find((existing) => {
    if (existing === resolvedSprint) return false;
    const candidate = existing.toLowerCase();
    return candidate.includes(target) || target.includes(candidate);
  });
}

// A stronger signal than label-similarity alone: an existing snapshot for
// this team on the EXACT SAME DATE, under a different-but-similar sprint
// label. Two genuinely different sprints starting/ending on the identical
// calendar date for the same team is rare; "typed/derived the label
// differently on a same-day re-run" is common — this is exactly the
// pattern that produced a real 3-way collision (id 3/4/5 all being the
// same BDPSA sprint on the same date under two labels), and it deserved
// more than the easy-to-miss warning findSimilarSprint alone gives, since
// that one's advisory-only to avoid false-positiving on genuinely
// unrelated sprints that merely share a substring.
export function findSimilarSprintOnDate(
  teamName: string,
  snapshotDate: string,
  resolvedSprint: string,
  dbPath?: string,
): SnapshotRow | undefined {
  const rows = getDb(dbPath)
    .prepare(`SELECT * FROM snapshots WHERE team_name = ? AND snapshot_date = ? AND sprint != ?`)
    .all(teamName, snapshotDate, resolvedSprint) as SnapshotRow[];
  const target = resolvedSprint.toLowerCase();
  return rows.find((row) => {
    const candidate = row.sprint.toLowerCase();
    return candidate.includes(target) || target.includes(candidate);
  });
}

// A byte-identical report for the same team+sprint saved on ANY earlier
// date is a strong duplicate signal even when it isn't a same-date
// collision (findSnapshotByDate) — most likely an accidental re-import of
// unchanged data a day or more apart. Unlike the same-date+byte-identical
// case (refused unconditionally, no override — see the analyze handlers),
// this is treated as a normal collision: blocked by default, but
// overridable via --force/force:true like any other collision, since a
// manager may deliberately want "still unchanged as of today" recorded as
// its own dated data point.
export function findByteIdenticalSnapshot(
  teamName: string,
  sprint: string,
  reportJson: string,
  dbPath?: string,
): SnapshotRow | undefined {
  return getDb(dbPath)
    .prepare(
      `SELECT * FROM snapshots WHERE team_name = ? AND sprint = ? AND report_json = ? ORDER BY snapshot_date DESC, id DESC LIMIT 1`,
    )
    .get(teamName, sprint, reportJson) as SnapshotRow | undefined;
}

// The fix for exactly what findSimilarSprint flags: two labels that turned
// out to be the same real sprint. Renaming merges them into one continuous
// sprint history rather than leaving `history`/`trend` tracking two
// unrelated threads for it. Refuses if the rename would collide with a
// snapshot that already has the target label on the same date — that would
// silently make two distinct dated observations indistinguishable, which is
// exactly the kind of ambiguity the exact-collision guard elsewhere exists
// to prevent, so this doesn't get to bypass it either.
export function renameSprintLabel(teamName: string, fromLabel: string, toLabel: string, dbPath?: string): number {
  const db = getDb(dbPath);
  const fromRows = db
    .prepare(`SELECT id, snapshot_date, report_json FROM snapshots WHERE team_name = ? AND sprint = ?`)
    .all(teamName, fromLabel) as Array<{ id: number; snapshot_date: string; report_json: string }>;
  if (fromRows.length === 0) throw new Error(`no snapshots found for team "${teamName}" with sprint "${fromLabel}"`);

  for (const row of fromRows) {
    const collision = findSnapshotByDate(teamName, toLabel, row.snapshot_date, dbPath);
    if (collision) {
      throw new Error(
        `renaming would collide: team "${teamName}" already has a snapshot for sprint "${toLabel}" on ${row.snapshot_date} (id ${collision.id}) — resolve that conflict manually first`,
      );
    }
  }

  // The embedded report_json.team.sprint has to move with the rename, not
  // just the outer `sprint` column — leaving it stale is exactly what
  // produced a real inconsistent row: renamed on the outside, still
  // reporting the old label internally, which then made a later genuinely
  // re-analyzed snapshot under the (now-shared) label look like a
  // near-duplicate instead of the same continuous sprint it actually was.
  const update = db.prepare(`UPDATE snapshots SET sprint = ?, report_json = ? WHERE id = ?`);
  const applyAll = db.transaction((rows: typeof fromRows) => {
    for (const row of rows) {
      const report = JSON.parse(row.report_json) as TeamReport;
      report.team.sprint = toLabel;
      update.run(toLabel, JSON.stringify(report), row.id);
    }
  });
  applyAll(fromRows);
  return fromRows.length;
}
