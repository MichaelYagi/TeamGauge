import Database from "better-sqlite3";

// A single local file — no server, no external service. Path is
// configurable (TEAMGAUGE_DB env var, or --db on commands that take it) so a
// script can point at a specific file instead of the default in-repo one.
const DEFAULT_DB_PATH = "./teamgauge.db";

let cached: Database.Database | null = null;
let cachedPath: string | null = null;

export function getDb(dbPath: string = process.env.TEAMGAUGE_DB || DEFAULT_DB_PATH): Database.Database {
  if (cached && cachedPath === dbPath) return cached;

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // SQLite ignores REFERENCES constraints unless this is explicitly turned
  // on — without it, `team_name TEXT ... REFERENCES teams(name)` below is
  // purely documentation, and a typo'd --team name would silently create an
  // orphaned snapshot/roster row with no matching team instead of failing.
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      name TEXT PRIMARY KEY,
      sprint_length_days INTEGER,
      charter TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roster_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_name TEXT NOT NULL REFERENCES teams(name),
      engineer_name TEXT NOT NULL,
      role TEXT NOT NULL,
      weight REAL,
      notes TEXT,
      effective_from TEXT NOT NULL,
      departed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(team_name, engineer_name, effective_from)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_name TEXT NOT NULL REFERENCES teams(name),
      sprint TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      sprint_start_date TEXT,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Per-snapshot, per-engineer facts that explain reduced throughput or
    -- elevated context-switching WITHOUT being a standing roster fact — PTO
    -- and on-call rotation are true for one sprint, not the person in
    -- general, which is exactly what separates this from roster_entries.notes.
    CREATE TABLE IF NOT EXISTS snapshot_engineer_context (
      snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
      engineer_name TEXT NOT NULL,
      pto_days REAL,
      on_call INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (snapshot_id, engineer_name)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_team ON snapshots(team_name, snapshot_date);
    CREATE INDEX IF NOT EXISTS idx_roster_lookup ON roster_entries(team_name, engineer_name, effective_from);
  `);

  // CREATE TABLE IF NOT EXISTS doesn't add columns to a table that already
  // exists from before this column was introduced — guard it explicitly.
  const rosterColumns = db.prepare(`PRAGMA table_info(roster_entries)`).all() as Array<{ name: string }>;
  if (!rosterColumns.some((col) => col.name === "departed")) {
    db.exec(`ALTER TABLE roster_entries ADD COLUMN departed INTEGER NOT NULL DEFAULT 0`);
  }

  const snapshotColumns = db.prepare(`PRAGMA table_info(snapshots)`).all() as Array<{ name: string }>;
  if (!snapshotColumns.some((col) => col.name === "sprint_goal")) {
    db.exec(`ALTER TABLE snapshots ADD COLUMN sprint_goal TEXT`);
  }
  if (!snapshotColumns.some((col) => col.name === "blocked_by")) {
    db.exec(`ALTER TABLE snapshots ADD COLUMN blocked_by TEXT`);
  }

  cached = db;
  cachedPath = dbPath;
  return db;
}
