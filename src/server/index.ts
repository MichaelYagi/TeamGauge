import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { JiraProvider } from "../providers/jira/JiraProvider.js";
import { CSVProvider } from "../providers/csv/CSVProvider.js";
import type { ProviderResult } from "../providers/types.js";
import { buildReportsPayload, buildTeamReport } from "../normalization/aggregate.js";
import { gatherProviderResults } from "../normalization/gatherSources.js";
import { loadRoster } from "../normalization/roster.js";
import { deriveMetrics } from "../normalization/deriveMetrics.js";
import { reasonAboutReport } from "../reasoning/reason.js";
import { reasonAboutTrend } from "../reasoning/cumulativeReason.js";
import { OllamaReasoningProvider } from "../reasoning/providers/ollama.js";
import { ClaudeReasoningProvider } from "../reasoning/providers/claude.js";
import type { ReasoningProvider } from "../reasoning/types.js";
import { listOllamaModels, listClaudeModels } from "../reasoning/listModels.js";
import { ReportsPayloadSchema, SignalsSchema, TeamReportSchema, type TeamReport } from "../schema/canonical.js";
import { localToday } from "../util/date.js";
import { MultiTeamConfigSchema } from "../schema/config.js";
import { RosterSchema, type Roster } from "../schema/roster.js";
import { withTempFile } from "./tempFile.js";
import { createOrUpdateTeam, getTeam, listTeams, addRosterEntry, getRosterAsOf, getDepartedAsOf, markDeparted } from "../db/teamProfile.js";
import { saveSnapshot, findSnapshotByDate, listKnownEngineers, listSnapshots } from "../db/snapshots.js";
import { computeTrend } from "../normalization/trend.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// A file's own extension/content tells us JSON vs CSV; a URL vs a JQL query
// is distinguished by whether the text looks like a URL. No need to make
// the user declare either — see claude.md's "agent/input-agnostic" intent.
function detectFileKind(file: Express.Multer.File): "json" | "csv" {
  const name = file.originalname.toLowerCase();
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".json")) return "json";
  const text = file.buffer.toString("utf-8").trimStart();
  return text.startsWith("{") || text.startsWith("[") ? "json" : "csv";
}

function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../../web")));

app.post(
  "/api/analyze",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "roster", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { teamName, sprint, text, team, date, sprintStart, force } = req.body as Record<string, string>;
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const sourceFile = files?.file?.[0];
      const rosterFile = files?.roster?.[0];

      if (team && rosterFile) {
        throw new Error("a roster file is ignored when a saved team is selected; roster comes from the team profile");
      }
      if (team && !getTeam(team)) {
        throw new Error(`no team named "${team}" — create it in Team Setup first`);
      }

      const jira = new JiraProvider();
      let providerResult: ProviderResult;

      if (sourceFile) {
        const kind = detectFileKind(sourceFile);
        providerResult =
          kind === "csv"
            ? await withTempFile(sourceFile.buffer, ".csv", (p) => new CSVProvider().ingest(p))
            : await withTempFile(sourceFile.buffer, ".json", (p) => jira.ingest({ json: p }));
      } else if (text && text.trim()) {
        providerResult = isUrl(text) ? await jira.ingest({ url: text.trim() }) : await jira.ingest({ jql: text.trim() });
      } else {
        throw new Error("provide a file upload or a URL/JQL value");
      }

      const detected = providerResult.detected ?? {};
      const resolvedTeamName = team || teamName || detected.team;
      const resolvedSprint = sprint || detected.sprint;

      // Include whatever WAS detected even on failure, so the UI can
      // prefill it instead of discarding a successful partial detection
      // just because the other field couldn't be derived.
      if (!resolvedTeamName) {
        return res.status(400).json({
          error: "Team name is required, and it couldn't be auto-detected — this source's issues don't all agree on one project. Enter it manually.",
          detected,
        });
      }
      if (!resolvedSprint) {
        return res.status(400).json({
          error: "Sprint is required, and it couldn't be auto-detected — this source's issues don't all agree on one sprint. Enter it manually.",
          detected,
        });
      }

      if (team) {
        const snapshotDate = date || localToday();
        const rosterRows = getRosterAsOf(team, snapshotDate);
        const roster: Roster = Object.fromEntries(
          rosterRows.map((row) => [row.engineer_name, { role: row.role, weight: row.weight ?? undefined, notes: row.notes ?? undefined }]),
        );
        const report = buildTeamReport({ name: team, sprint: resolvedSprint }, [providerResult], roster);
        const payload = ReportsPayloadSchema.parse(buildReportsPayload([report]));

        const existing = findSnapshotByDate(team, resolvedSprint, snapshotDate);
        if (existing && force !== "true") {
          // Still return the up-to-date report (current roster/signals) so
          // the UI can show it — "let me see current numbers" shouldn't be
          // blocked by "don't save a duplicate snapshot". Only the save is
          // withheld until the user explicitly asks for one via --force.
          return res.status(200).json({
            ...payload,
            collision: true,
            collisionMessage: `Not saved as a new snapshot — one for "${team}" / "${resolvedSprint}" on ${snapshotDate} already exists (saved ${existing.created_at}). The report below reflects your current roster; click "Save as new snapshot" if you also want this recorded as a new history entry.`,
          });
        }

        saveSnapshot({ team_name: team, sprint: resolvedSprint, snapshot_date: snapshotDate, sprint_start_date: sprintStart, report });
        return res.json(payload);
      }

      const roster = rosterFile ? RosterSchema.parse(JSON.parse(rosterFile.buffer.toString("utf-8"))) : undefined;
      const report = buildTeamReport({ name: resolvedTeamName, sprint: resolvedSprint }, [providerResult], roster);
      res.json(ReportsPayloadSchema.parse(buildReportsPayload([report])));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  },
);

app.get("/api/teams", (_req, res) => {
  res.json({ teams: listTeams() });
});

app.get("/api/teams/profile", (req, res) => {
  const team = String(req.query.team ?? "");
  const profile = getTeam(team);
  if (!profile) return res.status(404).json({ error: `no team named "${team}"` });
  const asOf = typeof req.query.date === "string" && req.query.date ? req.query.date : localToday();
  res.json({
    profile,
    roster: getRosterAsOf(team, asOf),
    departed: getDepartedAsOf(team, asOf),
    knownEngineers: listKnownEngineers(team),
  });
});

const TeamProfileRequestSchema = z.object({
  name: z.string().min(1),
  sprintLengthDays: z.number().nullable().optional(),
  charter: z.string().nullable().optional(),
});

app.post("/api/teams/profile", (req, res) => {
  try {
    const parsed = TeamProfileRequestSchema.parse(req.body);
    createOrUpdateTeam({
      name: parsed.name,
      sprint_length_days: parsed.sprintLengthDays ?? null,
      charter: parsed.charter ?? null,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const RosterEntryRequestSchema = z.object({
  team: z.string().min(1),
  engineerName: z.string().min(1),
  role: z.string(),
  weight: z.number().positive().optional(),
  notes: z.string().optional(),
  effectiveFrom: z.string().optional(),
});

app.post("/api/teams/roster", (req, res) => {
  try {
    const parsed = RosterEntryRequestSchema.parse(req.body);
    if (!getTeam(parsed.team)) throw new Error(`no team named "${parsed.team}" — create the profile first`);
    addRosterEntry(parsed.team, {
      engineer_name: parsed.engineerName,
      role: parsed.role,
      weight: parsed.weight,
      notes: parsed.notes,
      effective_from: parsed.effectiveFrom || localToday(),
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const DepartRequestSchema = z.object({
  team: z.string().min(1),
  engineerName: z.string().min(1),
  effectiveFrom: z.string().optional(),
});

// A departure is a dated fact, not a deletion — see markDeparted. Someone is
// "reactivated" by simply posting a new /api/teams/roster entry for them
// (a normal role update), which naturally supersedes an earlier departure.
app.post("/api/teams/roster/depart", (req, res) => {
  try {
    const parsed = DepartRequestSchema.parse(req.body);
    if (!getTeam(parsed.team)) throw new Error(`no team named "${parsed.team}" — create the profile first`);
    markDeparted(parsed.team, parsed.engineerName, parsed.effectiveFrom || localToday());
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const DeriveMetricsRequestSchema = z.object({
  signals: SignalsSchema,
  weight: z.number().positive().optional(),
  resolved_count: z.number().optional(),
  velocity: z.number().optional(),
});

// Lets the UI recompute load_score/burnout_risk live when a viewer edits an
// engineer's weight, without duplicating the scoring formula in JS.
// resolved_count/velocity are passed through unchanged (weight only affects
// load_score) so a weight edit doesn't wipe those out.
app.post("/api/derive-metrics", (req, res) => {
  try {
    const { signals, weight, resolved_count, velocity } = DeriveMetricsRequestSchema.parse(req.body);
    res.json(deriveMetrics(signals, weight ?? 1, resolved_count ?? 0, velocity ?? 0));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/analyze-config", async (req, res) => {
  try {
    const { configPath } = req.body as { configPath?: string };
    if (!configPath) throw new Error("configPath is required");

    const raw = JSON.parse(await readFile(configPath, "utf-8"));
    const config = MultiTeamConfigSchema.parse(raw);

    const reports = await Promise.all(
      config.teams.map(async (team) => {
        const providerResults = await gatherProviderResults(team.sources);
        const roster = team.roster ? await loadRoster(team.roster) : undefined;
        return buildTeamReport({ name: team.name, sprint: team.sprint }, providerResults, roster);
      }),
    );

    res.json(ReportsPayloadSchema.parse(buildReportsPayload(reports)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const ReasonRequestSchema = z.object({
  payload: ReportsPayloadSchema,
  provider: z.enum(["ollama", "claude"]).default("ollama"),
  url: z.string().default("http://localhost:11434"),
  model: z.string().optional(),
  context: z.string().optional(),
});

function resolveReasoningProvider(opts: { provider: "ollama" | "claude"; url: string; model?: string }): ReasoningProvider {
  return opts.provider === "claude"
    ? new ClaudeReasoningProvider(opts.model || "claude-opus-5")
    : new OllamaReasoningProvider(opts.url, opts.model || "llama3.1");
}

app.post("/api/reason", async (req, res) => {
  try {
    const parsed = ReasonRequestSchema.parse(req.body);
    const provider = resolveReasoningProvider(parsed);
    const reports = await Promise.all(
      parsed.payload.reports.map((report) => reasonAboutReport(report, provider, { freeText: parsed.context })),
    );
    res.json(ReportsPayloadSchema.parse(buildReportsPayload(reports)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/models", async (req, res) => {
  try {
    const provider = req.query.provider === "claude" ? "claude" : "ollama";
    const url = typeof req.query.url === "string" ? req.query.url : "http://localhost:11434";
    const models = provider === "claude" ? await listClaudeModels() : await listOllamaModels(url);
    res.json({ models });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// One fetch gives the UI everything it needs to render snapshots AND every
// recommendation ever generated, without an N+1 fetch per snapshot.
app.get("/api/history", (req, res) => {
  const team = String(req.query.team ?? "");
  if (!team) return res.status(400).json({ error: "team is required" });
  const sprint = typeof req.query.sprint === "string" && req.query.sprint ? req.query.sprint : undefined;
  if (!getTeam(team)) return res.status(404).json({ error: `no team named "${team}"` });

  const rows = listSnapshots(team, sprint);
  const history = rows.map((row) => {
    const report = JSON.parse(row.report_json) as TeamReport;
    return {
      id: row.id,
      sprint: row.sprint,
      snapshot_date: row.snapshot_date,
      sprint_start_date: row.sprint_start_date,
      created_at: row.created_at,
      team_velocity: report.team_metrics.team_velocity,
      total_resolved: report.team_metrics.total_resolved,
      total_work_items: report.team_metrics.total_work_items,
      team_avg_cycle_time_hours: report.team_metrics.team_avg_cycle_time_hours,
      team_recommendations_notes: report.team_recommendations.notes,
      engineer_recommendations: report.engineers
        .filter((e) => e.recommendations.notes)
        .map((e) => ({ name: e.name, notes: e.recommendations.notes, redistribute_to: e.recommendations.redistribute_to })),
    };
  });
  res.json({ history });
});

app.get("/api/trend", (req, res) => {
  const team = String(req.query.team ?? "");
  if (!team) return res.status(400).json({ error: "team is required" });
  const sprint = typeof req.query.sprint === "string" && req.query.sprint ? req.query.sprint : undefined;
  if (!getTeam(team)) return res.status(404).json({ error: `no team named "${team}"` });

  const rows = listSnapshots(team, sprint);
  if (rows.length === 0) return res.json({ team: "", points: [], deltas: [], engineers: [] });

  const points = rows.map((row) => ({
    snapshot_date: row.snapshot_date,
    sprint: row.sprint,
    report: TeamReportSchema.parse(JSON.parse(row.report_json)),
  }));
  res.json(computeTrend(points));
});

const TrendReasonRequestSchema = z.object({
  team: z.string().min(1),
  sprint: z.string().optional(),
  provider: z.enum(["ollama", "claude"]).default("ollama"),
  url: z.string().default("http://localhost:11434"),
  model: z.string().optional(),
  context: z.string().optional(),
});

// A synthesized, accumulated report over a team's WHOLE history — distinct
// from /api/reason, which only ever looks at one snapshot. Computed fresh
// each call (cheap — it's just re-running deterministic math over already-
// saved snapshots) rather than stored, since it's a derived view, not a new
// observation.
app.post("/api/trend-reason", async (req, res) => {
  try {
    const parsed = TrendReasonRequestSchema.parse(req.body);
    if (!getTeam(parsed.team)) throw new Error(`no team named "${parsed.team}"`);

    const rows = listSnapshots(parsed.team, parsed.sprint);
    if (rows.length === 0) throw new Error(`no saved snapshots for "${parsed.team}"${parsed.sprint ? ` sprint "${parsed.sprint}"` : ""} yet`);

    const points = rows.map((row) => ({
      snapshot_date: row.snapshot_date,
      sprint: row.sprint,
      report: TeamReportSchema.parse(JSON.parse(row.report_json)),
    }));
    const trend = computeTrend(points);

    const provider = resolveReasoningProvider(parsed);

    const cumulative = await reasonAboutTrend(trend, provider, { freeText: parsed.context });
    res.json({ trend, cumulative });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`TeamGauge UI running at http://localhost:${port}`);
});
