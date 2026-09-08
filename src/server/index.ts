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
import { reasonAboutTrend, reasonAboutPersonTrend } from "../reasoning/cumulativeReason.js";
import { OllamaReasoningProvider } from "../reasoning/providers/ollama.js";
import { ClaudeReasoningProvider } from "../reasoning/providers/claude.js";
import type { ReasoningContext, ReasoningProvider } from "../reasoning/types.js";
import { listOllamaModels, listClaudeModels } from "../reasoning/listModels.js";
import { ReportsPayloadSchema, SignalsSchema, TeamReportSchema, type TeamReport } from "../schema/canonical.js";
import { localToday } from "../util/date.js";
import { MultiTeamConfigSchema } from "../schema/config.js";
import { RosterSchema, type Roster } from "../schema/roster.js";
import { withTempFile, createTempFile } from "./tempFile.js";
import { createOrUpdateTeam, getTeam, listTeams, addRosterEntry, getRosterAsOf, getDepartedAsOf, markDeparted, currentRoleAsOf, overlayCurrentRosterFacts, overlayCurrentRosterFactsOnReport } from "../db/teamProfile.js";
import {
  saveSnapshot,
  findSnapshotByDate,
  findByteIdenticalSnapshot,
  deleteSnapshot,
  findSimilarSprint,
  findSimilarSprintOnDate,
  listKnownEngineers,
  listKnownSprints,
  renameSprintLabel,
  listSnapshots,
  getLatestSnapshot,
  updateSnapshotContext,
  setEngineerSnapshotContext,
  getEngineerSnapshotContext,
  updateSnapshotReport,
  type SnapshotRow,
} from "../db/snapshots.js";
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
    { name: "file", maxCount: 20 },
    { name: "roster", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { teamName, sprint, text, team, date, sprintStart, sprintGoal, blockedBy, force } = req.body as Record<string, string>;
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const sourceFiles = files?.file ?? [];
      const rosterFile = files?.roster?.[0];

      if (team && rosterFile) {
        throw new Error("a roster file is ignored when a saved team is selected; roster comes from the team profile");
      }
      if (team && !getTeam(team)) {
        throw new Error(`no team named "${team}" — create it in Team Setup first`);
      }

      const jira = new JiraProvider();
      let providerResult: ProviderResult;
      let sprintDetectionSupported = false;
      let csvFilePaths: string[] | undefined;
      let cleanupCsvFiles: (() => Promise<void>) | undefined;

      if (sourceFiles.length > 0) {
        // Multiple uploads treated as one analysis — several CSV exports
        // pulled at different times/covering different boards, analyzed
        // together in one shot instead of one file at a time. All files
        // must be the same kind: merging a CSV export with a JSON export
        // would mean two completely different row shapes, and JiraProvider
        // has no multi-file merge (only CSVProvider does — see
        // CSVProvider.ingestFiles's Issue-key dedup).
        const kinds = sourceFiles.map(detectFileKind);
        const uniqueKinds = new Set(kinds);
        if (uniqueKinds.size > 1) {
          throw new Error(`uploaded files must all be the same kind — got a mix of ${Array.from(uniqueKinds).join(" and ")}. Upload CSVs together, or a single JSON file, not both.`);
        }
        const kind = kinds[0];
        sprintDetectionSupported = kind === "csv";

        if (kind === "csv") {
          // Kept alive past this block (not auto-cleaned by withTempFile)
          // since the multi-sprint fallback below may need to re-read the
          // same files via ingestFilesGroupedBySprint once we know one
          // sprint didn't unanimously win.
          const written = await Promise.all(sourceFiles.map((f) => createTempFile(f.buffer, ".csv")));
          csvFilePaths = written.map((w) => w.path);
          cleanupCsvFiles = async () => {
            await Promise.all(written.map((w) => w.cleanup()));
          };
          providerResult = await new CSVProvider().ingestFiles(csvFilePaths);
        } else {
          if (sourceFiles.length > 1) {
            throw new Error("multiple JSON files aren't supported yet — combine them into one export first, or upload CSVs instead (which do support multiple files).");
          }
          providerResult = await withTempFile(sourceFiles[0].buffer, ".json", (p) => jira.ingest({ json: p }));
        }
      } else if (text && text.trim()) {
        providerResult = isUrl(text) ? await jira.ingest({ url: text.trim() }) : await jira.ingest({ jql: text.trim() });
      } else {
        throw new Error("provide a file upload or a URL/JQL value");
      }

      try {
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

        // A CSV export that genuinely spans several sprints (a backlog/board
        // export, not a "this sprint only" export) is real, useful data —
        // not an error. When no single sprint was explicitly given or
        // unanimously detected, split into one group per sprint actually
        // present (see CSVProvider.ingestGroupedBySprint) and produce one
        // report per sprint instead of forcing a guess or losing data.
        let sprintGroups: Array<{ sprint: string; result: ProviderResult; derivedDate: string | null }> | undefined;
        if (!resolvedSprint) {
          if (sprintDetectionSupported && csvFilePaths) {
            const { groups } = await new CSVProvider().ingestFilesGroupedBySprint(csvFilePaths);
            if (groups.length > 0) sprintGroups = groups;
          }
          if (!sprintGroups) {
            // "issues don't all agree" is only true for CSV, where detection
            // is actually attempted (from the Sprint column). For
            // JSON/URL/JQL, detection is never attempted at all — Jira's
            // sprint field is a custom field whose ID varies per instance,
            // so guessing it would mean hardcoding a Jira field (see
            // claude.md). Claiming "disagreement" there is simply false,
            // including for a JQL query already scoped to one sprint.
            const error = sprintDetectionSupported
              ? "Sprint is required, and it couldn't be auto-detected — this source's issues don't all agree on one sprint. Enter it manually."
              : "Sprint is required — it can't be auto-detected from this source. Jira's sprint field lives in a custom field whose ID varies per Jira instance, so TeamGauge never guesses it for JSON/URL/JQL sources (only a CSV export's \"Sprint\" column is stable enough to auto-detect from). Enter it manually — this is expected even if your query/export is already scoped to one sprint.";
            return res.status(400).json({ error, detected });
          }
        } else {
          sprintGroups = [{ sprint: resolvedSprint, result: providerResult, derivedDate: null }];
        }

        if (team) {
          // Applies every collision/duplicate guard exactly as before for a
          // single sprint. When there are multiple sprint groups (the
          // multi-sprint split above), a collision in one sprint never
          // blocks the others — capturing 5 of 6 sprints from a bulk import
          // is far more useful than refusing all 6 over one pre-existing
          // snapshot, and `force` (from "Save as new snapshot") retries
          // every group, not just the one that collided. Roster resolution
          // moved inside (parameterized by `snapshotDate`, not one outer
          // constant) because a multi-sprint group's date is no longer
          // necessarily "today" for every group — see the loop below.
          function attemptSave(sprintLabel: string, result: ProviderResult, snapshotDate: string): { report: TeamReport; saved: boolean; skipReason?: string } {
            const rosterRows = getRosterAsOf(team, snapshotDate);
            const roster: Roster = Object.fromEntries(
              rosterRows.map((row) => [row.engineer_name, { role: row.role, weight: row.weight ?? undefined, notes: row.notes ?? undefined }]),
            );
            const similarSprint = findSimilarSprint(team, sprintLabel);
            const similarSprintNote = similarSprint
              ? ` (also: "${sprintLabel}" looks similar to existing sprint "${similarSprint}" — if these are the same sprint, re-analyze with sprint "${similarSprint}" instead)`
              : "";

            const existing = findSnapshotByDate(team, sprintLabel, snapshotDate);
            if (existing && force !== "true") {
              return {
                report: buildTeamReport({ name: team, sprint: sprintLabel }, [result], roster),
                saved: false,
                skipReason: `one for "${team}" / "${sprintLabel}" on ${snapshotDate} already exists (saved ${existing.created_at})${similarSprintNote}`,
              };
            }

            if (!existing) {
              const sameDateSimilar = findSimilarSprintOnDate(team, snapshotDate, sprintLabel);
              if (sameDateSimilar && force !== "true") {
                return {
                  report: buildTeamReport({ name: team, sprint: sprintLabel }, [result], roster),
                  saved: false,
                  skipReason: `"${team}" already has a snapshot on ${snapshotDate} under a different sprint label: "${sameDateSimilar.sprint}" (id ${sameDateSimilar.id}) — very likely the same sprint typed/detected differently`,
                };
              }
            }

            const report = buildTeamReport({ name: team, sprint: sprintLabel }, [result], roster);

            if (existing && JSON.stringify(report) === existing.report_json) {
              return {
                report,
                saved: false,
                skipReason: `this is an exact duplicate of snapshot id ${existing.id} (saved ${existing.created_at}) — nothing has changed since then`,
              };
            }

            if (!existing) {
              const byteIdentical = findByteIdenticalSnapshot(team, sprintLabel, JSON.stringify(report));
              if (byteIdentical && force !== "true") {
                return {
                  report,
                  saved: false,
                  skipReason: `this is byte-identical to the snapshot from ${byteIdentical.snapshot_date} (id ${byteIdentical.id}) — nothing has changed since then`,
                };
              }
            }

            saveSnapshot({
              team_name: team,
              sprint: sprintLabel,
              snapshot_date: snapshotDate,
              sprint_start_date: sprintStart,
              sprint_goal: sprintGoal || undefined,
              blocked_by: blockedBy || undefined,
              report,
            });
            return { report, saved: true };
          }

          // `date`, when given, still applies uniformly to every group (an
          // explicit choice always wins, unchanged). Left unspecified, each
          // group defaults to ITS OWN latest-activity date instead of
          // "today" for all of them — see CSVProvider.deriveGroupDate.
          const reports: TeamReport[] = [];
          const snapshotDates: string[] = [];
          const skipped: string[] = [];
          for (const group of sprintGroups) {
            const snapshotDate = date || group.derivedDate || localToday();
            const result = attemptSave(group.sprint, group.result, snapshotDate);
            reports.push(result.report);
            // Recorded even for a skipped/collided group — a card edit on
            // that report should still target the date it WOULD save under
            // if "Save as new snapshot" is clicked, not be left undated.
            snapshotDates.push(snapshotDate);
            if (!result.saved) skipped.push(`"${group.sprint}" — ${result.skipReason}`);
          }

          const payload = { ...ReportsPayloadSchema.parse(buildReportsPayload(reports)), snapshotDates };
          if (skipped.length > 0) {
            const plural = sprintGroups.length > 1;
            return res.status(200).json({
              ...payload,
              collision: true,
              collisionMessage: plural
                ? `${skipped.length} of ${sprintGroups.length} sprint(s) not saved as new snapshots: ${skipped.join("; ")}. The report(s) below reflect current data; click "Save as new snapshot" to save the skipped one(s) anyway.`
                : `Not saved as a new snapshot — ${skipped[0]}. The report below reflects your current roster; click "Save as new snapshot" if you also want this recorded as a new history entry.`,
            });
          }
          return res.json(payload);
        }

        const roster = rosterFile ? RosterSchema.parse(JSON.parse(rosterFile.buffer.toString("utf-8"))) : undefined;
        const reports = sprintGroups.map((g) => buildTeamReport({ name: resolvedTeamName, sprint: g.sprint }, [g.result], roster));
        res.json(ReportsPayloadSchema.parse(buildReportsPayload(reports)));
      } finally {
        if (cleanupCsvFiles) await cleanupCsvFiles();
      }
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
    knownSprints: listKnownSprints(team),
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

function resolveSnapshotOrThrow(team: string, sprint: string, snapshotDate?: string) {
  const rows = listSnapshots(team, sprint);
  const snapshot = snapshotDate ? rows.find((row) => row.snapshot_date === snapshotDate) : rows.at(-1);
  if (!snapshot) throw new Error(`no snapshot found for team "${team}" sprint "${sprint}"${snapshotDate ? ` on ${snapshotDate}` : ""}`);
  return snapshot;
}

const SnapshotContextRequestSchema = z.object({
  team: z.string().min(1),
  sprint: z.string().min(1),
  snapshotDate: z.string().optional(),
  sprintGoal: z.string().optional(),
  blockedBy: z.string().optional(),
});

// Team-level, per-snapshot facts — what this sprint was supposed to deliver,
// and any cross-team dependency blocking it. Distinct from the team profile
// (charter, sprint length): those are standing facts, these are true for
// one sprint only, so they attach to the snapshot row, not `teams`.
app.post("/api/snapshots/context", (req, res) => {
  try {
    const parsed = SnapshotContextRequestSchema.parse(req.body);
    if (!parsed.sprintGoal && !parsed.blockedBy) throw new Error("at least one of sprintGoal or blockedBy is required");
    const snapshot = resolveSnapshotOrThrow(parsed.team, parsed.sprint, parsed.snapshotDate);
    updateSnapshotContext(snapshot.id, { sprint_goal: parsed.sprintGoal, blocked_by: parsed.blockedBy });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const EngineerSnapshotContextRequestSchema = z.object({
  team: z.string().min(1),
  sprint: z.string().min(1),
  snapshotDate: z.string().optional(),
  engineerName: z.string().min(1),
  ptoDays: z.number().optional(),
  onCall: z.boolean().optional(),
});

// Per-engineer, per-snapshot facts (PTO days taken, on-call this sprint) —
// true for one sprint only, unlike roster_entries.notes (a standing
// work-pattern fact), which is why this is a separate table/endpoint rather
// than folded into /api/teams/roster.
app.post("/api/snapshots/engineer-context", (req, res) => {
  try {
    const parsed = EngineerSnapshotContextRequestSchema.parse(req.body);
    if (parsed.ptoDays === undefined && parsed.onCall === undefined) {
      throw new Error("at least one of ptoDays or onCall is required");
    }
    const snapshot = resolveSnapshotOrThrow(parsed.team, parsed.sprint, parsed.snapshotDate);
    setEngineerSnapshotContext(snapshot.id, parsed.engineerName, { ptoDays: parsed.ptoDays, onCall: parsed.onCall });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const RenameSprintRequestSchema = z.object({
  team: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

// Merges two sprint labels that turned out to be the same real sprint (see
// findSimilarSprint's warning, which is preventive — this is the fix for
// drift that already happened before the warning existed). Rare, deliberate
// administrative action — no confirmation step here beyond the UI's own,
// since the DB layer already refuses on a resulting collision.
app.post("/api/snapshots/rename-sprint", (req, res) => {
  try {
    const parsed = RenameSprintRequestSchema.parse(req.body);
    const changed = renameSprintLabel(parsed.team, parsed.from, parsed.to);
    res.json({ ok: true, snapshots_renamed: changed });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const DeleteSnapshotRequestSchema = z.object({
  team: z.string().min(1),
  sprint: z.string().min(1),
  snapshotDate: z.string().min(1),
});

// The one deliberate escape hatch out of "append-only" — for a confirmed
// accidental duplicate/stale row, not a routine correction. Requires an
// explicit snapshotDate (no "latest" default) so a click can't remove the
// wrong one of several same-sprint snapshots. No undo.
app.post("/api/snapshots/delete", (req, res) => {
  try {
    const parsed = DeleteSnapshotRequestSchema.parse(req.body);
    const snapshot = resolveSnapshotOrThrow(parsed.team, parsed.sprint, parsed.snapshotDate);
    deleteSnapshot(snapshot.id);
    res.json({ ok: true, deletedSnapshotId: snapshot.id });
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
  // When a saved team + sprint is named, the request is enriched from the
  // DB the same way the CLI's `reason --team` already does (charter,
  // sprint-position, roster notes, sprint goal, cross-team blocker,
  // per-engineer PTO/on-call) — this was previously CLI-only, which meant
  // the UI's "Generate Recommendations" never got any of it even for a
  // saved-team analysis.
  team: z.string().optional(),
  sprint: z.string().optional(),
  snapshotDate: z.string().optional(),
});

function resolveReasoningProvider(opts: { provider: "ollama" | "claude"; url: string; model?: string }): ReasoningProvider {
  return opts.provider === "claude"
    ? new ClaudeReasoningProvider(opts.model || "claude-opus-5")
    : new OllamaReasoningProvider(opts.url, opts.model || "llama3.1");
}

// Charter, sprint-position, roster notes, sprint goal, cross-team blocker,
// per-engineer PTO/on-call — everything `teamgauge reason --team` already
// enriches from the DB, factored out so every UI reasoning entry point that
// works from a saved snapshot (the ad hoc /api/reason team-scoped path, and
// /api/snapshot-reason below) gets the same enrichment instead of each
// re-implementing it slightly differently.
function buildDbContextForSnapshot(team: string, snapshot: SnapshotRow): Partial<ReasoningContext> {
  const profile = getTeam(team);
  const rosterRows = getRosterAsOf(team, snapshot.snapshot_date);
  const engineerNotes = Object.fromEntries(
    rosterRows.filter((row) => row.notes).map((row) => [row.engineer_name, row.notes as string]),
  );
  const daysIntoSprint = snapshot.sprint_start_date
    ? Math.max(0, Math.round((new Date(snapshot.snapshot_date).getTime() - new Date(snapshot.sprint_start_date).getTime()) / 86_400_000))
    : undefined;
  const engineerSnapshotContext = getEngineerSnapshotContext(snapshot.id);
  const engineerContext = Object.fromEntries(
    Object.entries(engineerSnapshotContext).map(([name, ctx]) => [name, { ptoDays: ctx.pto_days, onCall: ctx.on_call }]),
  );

  return {
    charter: profile?.charter ?? undefined,
    sprintLengthDays: profile?.sprint_length_days ?? undefined,
    daysIntoSprint,
    engineerNotes,
    sprintGoal: snapshot.sprint_goal ?? undefined,
    blockedBy: snapshot.blocked_by ?? undefined,
    engineerContext,
  };
}

app.post("/api/reason", async (req, res) => {
  try {
    const parsed = ReasonRequestSchema.parse(req.body);
    const provider = resolveReasoningProvider(parsed);

    let dbCtx: Partial<ReasoningContext> = {};
    let reportsToReason = parsed.payload.reports;
    if (parsed.team && parsed.sprint) {
      const rows = listSnapshots(parsed.team, parsed.sprint);
      const snapshot = parsed.snapshotDate ? rows.find((row) => row.snapshot_date === parsed.snapshotDate) : rows.at(-1);
      if (snapshot) {
        dbCtx = buildDbContextForSnapshot(parsed.team, snapshot);
        reportsToReason = reportsToReason.map((report) => overlayCurrentRosterFactsOnReport(parsed.team!, snapshot.snapshot_date, report));
      }
    }

    const reports = await Promise.all(
      reportsToReason.map((report) => reasonAboutReport(report, provider, { ...dbCtx, freeText: parsed.context })),
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
      sprint_goal: row.sprint_goal,
      blocked_by: row.blocked_by,
      engineer_context: getEngineerSnapshotContext(row.id),
      created_at: row.created_at,
      team_velocity: report.team_metrics.team_velocity,
      total_resolved: report.team_metrics.total_resolved,
      total_work_items: report.team_metrics.total_work_items,
      team_avg_cycle_time_hours: report.team_metrics.team_avg_cycle_time_hours,
      team_recommendations_notes: report.team_recommendations.notes,
      // Lightweight (name + role only, not the full signals/metrics) — just
      // enough for History & Trends' per-row "who worked this sprint" list
      // without a second fetch; the full report is only ever needed once
      // "Generate Sprint Report" is actually clicked (/api/snapshot-reason
      // returns it in full then).
      engineers: report.engineers.map((e) => ({ name: e.name, role: currentRoleAsOf(team, e.name, row.snapshot_date, e.role) })),
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
  res.json(overlayCurrentRosterFacts(team, computeTrend(points)));
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
    const trend = overlayCurrentRosterFacts(parsed.team, computeTrend(points));

    const provider = resolveReasoningProvider(parsed);

    const cumulative = await reasonAboutTrend(trend, provider, { freeText: parsed.context });
    res.json({ trend, cumulative });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const PersonTrendReasonRequestSchema = z.object({
  team: z.string().min(1),
  sprint: z.string().optional(),
  engineerName: z.string().min(1),
  provider: z.enum(["ollama", "claude"]).default("ollama"),
  url: z.string().default("http://localhost:11434"),
  model: z.string().optional(),
  context: z.string().optional(),
});

// One person's own accumulated trajectory, not the whole team's — a
// separate, on-demand trigger per engineer (see History & Trends' Per
// Engineer table) rather than folded into /api/trend-reason, since a team
// of a dozen people would otherwise mean a dozen extra reasoning calls
// every time anyone opens the team-wide accumulated report. computeTrend
// already produces every person's points/deltas as a side effect of the
// team-wide computation — this just re-runs that same cheap, deterministic
// step and picks out the one engineer asked for.
app.post("/api/trend-reason-person", async (req, res) => {
  try {
    const parsed = PersonTrendReasonRequestSchema.parse(req.body);
    if (!getTeam(parsed.team)) throw new Error(`no team named "${parsed.team}"`);
    if (parsed.engineerName === "Unassigned") throw new Error(`"Unassigned" is a shared backlog bucket, not a person — there's no individual trajectory to report on.`);

    const rows = listSnapshots(parsed.team, parsed.sprint);
    if (rows.length === 0) throw new Error(`no saved snapshots for "${parsed.team}"${parsed.sprint ? ` sprint "${parsed.sprint}"` : ""} yet`);

    const points = rows.map((row) => ({
      snapshot_date: row.snapshot_date,
      sprint: row.sprint,
      report: TeamReportSchema.parse(JSON.parse(row.report_json)),
    }));
    const trend = overlayCurrentRosterFacts(parsed.team, computeTrend(points));
    const personTrend = trend.engineers.find((e) => e.name === parsed.engineerName);
    if (!personTrend) throw new Error(`"${parsed.engineerName}" doesn't appear in any saved snapshot for "${parsed.team}"${parsed.sprint ? ` sprint "${parsed.sprint}"` : ""}`);

    const provider = resolveReasoningProvider(parsed);
    const cumulative = await reasonAboutPersonTrend(personTrend, parsed.team, provider, { freeText: parsed.context });
    res.json({ engineer: parsed.engineerName, trend: personTrend, cumulative });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const SnapshotReasonRequestSchema = z.object({
  team: z.string().min(1),
  sprint: z.string().min(1),
  snapshotDate: z.string().optional(),
  provider: z.enum(["ollama", "claude"]).default("ollama"),
  url: z.string().default("http://localhost:11434"),
  model: z.string().optional(),
  context: z.string().optional(),
});

// The UI equivalent of `teamgauge reason --team --sprint`, which previously
// had no UI path at all — the only way to reason about a sprint was right
// after a fresh Analyze run. This reads an ALREADY-SAVED snapshot straight
// from history (default: its latest snapshot_date), reasons over it with
// full DB enrichment, and — matching the CLI's documented behavior — saves
// the result back into that same row (a second run replaces the first's
// recommendations, not versioned). Lets History & Trends' Snapshots table
// offer "Generate Sprint Report" on any saved row without re-uploading the
// original source file.
app.post("/api/snapshot-reason", async (req, res) => {
  try {
    const parsed = SnapshotReasonRequestSchema.parse(req.body);
    const snapshot = resolveSnapshotOrThrow(parsed.team, parsed.sprint, parsed.snapshotDate);
    const report = overlayCurrentRosterFactsOnReport(parsed.team, snapshot.snapshot_date, TeamReportSchema.parse(JSON.parse(snapshot.report_json)));

    const provider = resolveReasoningProvider(parsed);
    const dbCtx = buildDbContextForSnapshot(parsed.team, snapshot);
    const updatedReport = await reasonAboutReport(report, provider, { ...dbCtx, freeText: parsed.context });

    updateSnapshotReport(snapshot.id, updatedReport);
    res.json(ReportsPayloadSchema.parse(buildReportsPayload([updatedReport])));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`TeamGauge UI running at http://localhost:${port}`);
});
