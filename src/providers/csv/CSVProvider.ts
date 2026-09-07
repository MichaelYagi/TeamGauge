import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import type { ProviderOutput } from "../../schema/canonical.js";
import type { Provider, ProviderResult } from "../types.js";
import type { IssueAdapter } from "../common/issueAdapter.js";
import { computeSignalsForIssues, groupIssuesByEngineer } from "../common/computeSignals.js";
import { detectTeamAndSprint, type DetectedContext } from "../common/detect.js";
import { defaultJiraCsvAdapter, type CsvRow } from "./adapter.js";

// Jira's export repeats some headers. Most (Comment, Watchers, ...) we keep
// the first occurrence of and drop the rest — harmless, since this adapter
// never reads them. "Sprint" is different: its repeated columns are one
// issue's full sprint *history*, in chronological order, so the first value
// is that issue's oldest sprint — we want the last non-empty one instead,
// its current sprint (verified against a real multi-sprint export: 8 Sprint
// columns per row, values only agree across issues when read this way).
const PREFER_LAST_HEADERS = new Set(["Sprint"]);

function rowsFromCsv(content: string): CsvRow[] {
  const table: string[][] = parse(content, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
  const [headers, ...dataRows] = table;
  if (!headers) return [];

  return dataRows.map((values) => {
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      const value = values[index] ?? "";
      if (PREFER_LAST_HEADERS.has(header)) {
        if (value.trim().length > 0) row[header] = value;
      } else if (!(header in row)) {
        row[header] = value;
      }
    });
    return row;
  });
}

export interface SprintGroup {
  sprint: string;
  result: ProviderResult;
  issueCount: number;
  // The sprint's own latest-known activity date (its most recent Resolved
  // date, or most recent Created date if nothing's resolved yet), as
  // YYYY-MM-DD — not derived from Signals, just a plain max() over the
  // group's own rows. Meant as a sensible DEFAULT snapshot_date for a bulk
  // multi-sprint import specifically: today's date is meaningless for
  // several already-closed historical sprints imported in one batch (they'd
  // all collide on one arbitrary import day), but each sprint's own latest
  // activity date is real, distinct, and orderable. Callers can still pass
  // an explicit --date to override this per the normal "explicit always
  // wins" rule — this is only the fallback when none is given.
  derivedDate: string | null;
}

export interface GroupedBySprintResult {
  groups: SprintGroup[];
  // Issues with no resolvable current sprint at all (every Sprint column
  // empty) — not attributable to any of the groups above, so counted
  // separately rather than silently dropped without a trace.
  skippedNoSprint: number;
}

export class CSVProvider implements Provider<string> {
  readonly name = "csv";

  constructor(private readonly adapter: IssueAdapter<CsvRow> = defaultJiraCsvAdapter) {}

  async ingest(filePath: string): Promise<ProviderResult> {
    return this.ingestRows(await this.loadRows(filePath));
  }

  // Several separate uploads treated as one analysis — e.g. a handful of
  // CSV exports pulled at different times, or covering different projects/
  // boards, that the caller wants analyzed together in one shot rather than
  // one at a time. Rows are merged and de-duplicated by Issue key first
  // (see mergeAndDedupeRows) so an issue present in more than one file
  // — the common case, since overlapping exports of the same board share
  // most of their issues — is counted once, using its most-recently-seen
  // version, not once per file it happens to appear in.
  async ingestFiles(filePaths: string[]): Promise<ProviderResult> {
    return this.ingestRows(await this.loadRowsFromFiles(filePaths));
  }

  private ingestRows(rows: CsvRow[]): ProviderResult {
    const detected: DetectedContext = detectTeamAndSprint(rows, this.adapter);
    return { engineers: groupIssuesByEngineer(rows, this.adapter), detected };
  }

  // The fallback for a source whose issues genuinely don't agree on one
  // current sprint (a backlog/board export spanning many closed sprints,
  // not a "this sprint only" export) — rather than erroring out and forcing
  // the caller to pick one label and misattribute everyone else's issues,
  // this splits the file into one genuinely-unanimous group per sprint
  // actually present. Each group's `result` only ever contains issues that
  // really belong to that sprint — no guessing, just partitioning what's
  // already there (still "reasoning-free ingestion": pure grouping, no
  // interpretation).
  async ingestGroupedBySprint(filePath: string): Promise<GroupedBySprintResult> {
    return this.groupRowsBySprint(await this.loadRows(filePath));
  }

  // Same multi-file merge as ingestFiles, then split by sprint — the
  // combination that matters most in practice: several historical exports,
  // each possibly spanning several sprints, analyzed together in one call.
  async ingestFilesGroupedBySprint(filePaths: string[]): Promise<GroupedBySprintResult> {
    return this.groupRowsBySprint(await this.loadRowsFromFiles(filePaths));
  }

  private groupRowsBySprint(rows: CsvRow[]): GroupedBySprintResult {
    const bySprint = new Map<string, CsvRow[]>();
    let skippedNoSprint = 0;
    for (const row of rows) {
      const sprint = this.adapter.getSprintName?.(row) ?? null;
      if (!sprint) {
        skippedNoSprint++;
        continue;
      }
      const group = bySprint.get(sprint) ?? [];
      group.push(row);
      bySprint.set(sprint, group);
    }

    const groups: SprintGroup[] = Array.from(bySprint.entries()).map(([sprint, groupRows]) => ({
      sprint,
      result: { engineers: groupIssuesByEngineer(groupRows, this.adapter) },
      issueCount: groupRows.length,
      derivedDate: this.deriveGroupDate(groupRows),
    }));

    return { groups, skippedNoSprint };
  }

  // Flat aggregate matching claude.md's documented provider output shape
  // (`{ signals }`), used by `teamgauge ingest --csv` for raw inspection.
  async ingestFlat(filePath: string): Promise<ProviderOutput> {
    const rows = await this.loadRows(filePath);
    return { signals: computeSignalsForIssues(rows, this.adapter).signals };
  }

  // Latest Resolved date among the group's rows, else latest Created date,
  // else null (an empty/dateless group, which shouldn't happen in practice
  // but isn't guessed around). getCreated/getResolved already return ISO
  // 8601 strings (see parseJiraCsvDate) — this just takes the date portion
  // of the max one, since a snapshot_date is a calendar day, not a instant.
  private deriveGroupDate(rows: CsvRow[]): string | null {
    const resolvedDates = rows.map((row) => this.adapter.getResolved(row)).filter((d): d is string => d !== null);
    if (resolvedDates.length > 0) return resolvedDates.sort().at(-1)!.slice(0, 10);

    const createdDates = rows.map((row) => this.adapter.getCreated(row)).filter((d): d is string => d !== null);
    if (createdDates.length > 0) return createdDates.sort().at(-1)!.slice(0, 10);

    return null;
  }

  private async loadRows(filePath: string): Promise<CsvRow[]> {
    const content = await readFile(filePath, "utf-8");
    return rowsFromCsv(content);
  }

  // Loads every file and merges them into one row set, de-duplicated by
  // Issue key — overlapping exports of the same board WILL share issues,
  // and counting one twice would double its work_items/resolved_count/
  // velocity contribution, silently inflating every signal derived from it.
  // Last file wins on a collision (files are processed in the order given,
  // so a later upload's version of an issue overrides an earlier one's —
  // the natural read of "these are progressively more current/complete").
  // A row whose adapter can't produce an Issue key (getIssueKey unset, or
  // this specific row lacks one) is never deduped away — kept as-is, since
  // there's no identity to compare it against, only to guess one.
  private async loadRowsFromFiles(filePaths: string[]): Promise<CsvRow[]> {
    if (filePaths.length === 0) return [];
    const rowsPerFile = await Promise.all(filePaths.map((path) => this.loadRows(path)));

    const byKey = new Map<string, CsvRow>();
    const noKey: CsvRow[] = [];
    for (const rows of rowsPerFile) {
      for (const row of rows) {
        const key = this.adapter.getIssueKey?.(row) ?? null;
        if (key) {
          byKey.set(key, row); // later file's version overwrites an earlier one's
        } else {
          noKey.push(row);
        }
      }
    }
    return [...byKey.values(), ...noKey];
  }
}
