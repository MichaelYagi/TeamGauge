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

export class CSVProvider implements Provider<string> {
  readonly name = "csv";

  constructor(private readonly adapter: IssueAdapter<CsvRow> = defaultJiraCsvAdapter) {}

  async ingest(filePath: string): Promise<ProviderResult> {
    const rows = await this.loadRows(filePath);
    const detected: DetectedContext = detectTeamAndSprint(rows, this.adapter);
    return { engineers: groupIssuesByEngineer(rows, this.adapter), detected };
  }

  // Flat aggregate matching claude.md's documented provider output shape
  // (`{ signals }`), used by `teamgauge ingest --csv` for raw inspection.
  async ingestFlat(filePath: string): Promise<ProviderOutput> {
    const rows = await this.loadRows(filePath);
    return { signals: computeSignalsForIssues(rows, this.adapter).signals };
  }

  private async loadRows(filePath: string): Promise<CsvRow[]> {
    const content = await readFile(filePath, "utf-8");
    return rowsFromCsv(content);
  }
}
