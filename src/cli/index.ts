#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { JiraProvider } from "../providers/jira/JiraProvider.js";
import { CSVProvider } from "../providers/csv/CSVProvider.js";
import { MultiTeamConfigSchema } from "../schema/config.js";
import { ReportsPayloadSchema, TeamReportSchema, type TeamReport } from "../schema/canonical.js";
import type { Roster } from "../schema/roster.js";
import { buildReportsPayload, buildTeamReport } from "../normalization/aggregate.js";
import { gatherProviderResults } from "../normalization/gatherSources.js";
import { loadRoster, resolveRosterEntry } from "../normalization/roster.js";
import { computeTrend } from "../normalization/trend.js";
import { reasonAboutReport } from "../reasoning/reason.js";
import { reasonAboutTrend } from "../reasoning/cumulativeReason.js";
import { OllamaReasoningProvider } from "../reasoning/providers/ollama.js";
import { ClaudeReasoningProvider } from "../reasoning/providers/claude.js";
import type { ReasoningContext, ReasoningProvider } from "../reasoning/types.js";
import { listOllamaModels, listClaudeModels } from "../reasoning/listModels.js";
import { runSetup } from "./setup.js";
import { createOrUpdateTeam, getTeam, listTeams, addRosterEntry, getRosterAsOf, getDepartedAsOf, markDeparted } from "../db/teamProfile.js";
import { saveSnapshot, listSnapshots, getLatestSnapshot, updateSnapshotReport, findSnapshotByDate, listKnownEngineers } from "../db/snapshots.js";
import { localToday } from "../util/date.js";

const program = new Command();
program.name("teamgauge").description("Workload intelligence signal ingestion and analysis");

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fail(message: string): never {
  process.stderr.write(`teamgauge: ${message}\n`);
  process.exit(1);
}

const todayIso = localToday;

program
  .command("ingest")
  .description("Run a single provider and print its raw normalized signals")
  .option("--json <file>", "path to a Jira-shaped JSON export")
  .option("--csv <file>", "path to a CSV export")
  .option("--url <endpoint>", "URL returning Jira-shaped JSON")
  .option("--jql <query>", "Jira JQL query (requires JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN)")
  .action(async (opts) => {
    try {
      if (opts.csv) return printJson(await new CSVProvider().ingestFlat(opts.csv));

      const provider = new JiraProvider();
      if (opts.json) return printJson(await provider.ingestFlat({ json: opts.json }));
      if (opts.url) return printJson(await provider.ingestFlat({ url: opts.url }));
      if (opts.jql) return printJson(await provider.ingestFlat({ jql: opts.jql }));

      fail("one of --json, --csv, --url, --jql is required");
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

program
  .command("analyze")
  .description("Produce the canonical reports payload for one or more teams")
  .option("--input <file|url>", "single Jira-shaped source (JSON file path or URL)")
  .option("--config <file>", "multi-team config file (see claude.md)")
  .option("--team-name <name>", "team name when using --input without --team (auto-detected from the source when every issue agrees on one project; only needed if it doesn't, or to override)")
  .option("--sprint <sprint>", "sprint label (auto-detected from a CSV source's Sprint column when every issue agrees on one; only needed if it doesn't, or to override)")
  .option("--roster <file>", "roster file (name -> role) when using --input without --team")
  .option("--team <name>", "use a saved team profile (roster + sprint length) instead of --roster, and save this run as a dated snapshot")
  .option("--date <date>", "snapshot date (YYYY-MM-DD, default: today) — only used with --team")
  .option("--sprint-start <date>", "sprint start date (YYYY-MM-DD) — only used with --team; enables sprint-position awareness in `reason`")
  .option("--force", "save anyway when a snapshot already exists for this exact team+sprint+date (default: refuse, since that's almost always an accidental re-import)")
  .option("--db <path>", "database file path (default: ./teamgauge.db or TEAMGAUGE_DB)")
  .action(async (opts) => {
    try {
      if (opts.config && opts.input) fail("--input and --config are mutually exclusive");
      if (opts.team && opts.roster) fail("--roster is ignored when --team is set; roster comes from the saved team profile (see `teamgauge setup` / `teamgauge team set-role`)");

      if (opts.config) {
        const raw = JSON.parse(await readFile(opts.config, "utf-8"));
        const config = MultiTeamConfigSchema.parse(raw);

        const reports = await Promise.all(
          config.teams.map(async (team) => {
            const providerResults = await gatherProviderResults(team.sources);
            const roster = team.roster ? await loadRoster(team.roster) : undefined;
            return buildTeamReport({ name: team.name, sprint: team.sprint }, providerResults, roster);
          }),
        );

        return printJson(ReportsPayloadSchema.parse(buildReportsPayload(reports)));
      }

      if (opts.input) {
        const providerResult = opts.input.endsWith(".csv")
          ? await new CSVProvider().ingest(opts.input)
          : await new JiraProvider().ingest(
              opts.input.startsWith("http") ? { url: opts.input } : { json: opts.input },
            );

        const detected = providerResult.detected ?? {};
        if (!opts.team && !opts.teamName && detected.team) {
          process.stderr.write(`teamgauge: detected team "${detected.team}" from the source (every issue agreed) — pass --team-name to override\n`);
        }
        if (!opts.sprint && detected.sprint) {
          process.stderr.write(`teamgauge: detected sprint "${detected.sprint}" from the source (every issue agreed) — pass --sprint to override\n`);
        }

        if (opts.team) {
          if (!getTeam(opts.team, opts.db)) {
            fail(`no team named "${opts.team}" — run \`teamgauge setup\` or \`teamgauge team create --team "${opts.team}"\` first`);
          }
          const sprint = opts.sprint || detected.sprint;
          if (!sprint) {
            fail(
              "--sprint is required when using --team, and it couldn't be auto-detected — this source's issues don't all agree on one sprint (not every team's data is consistent enough to derive it; pass --sprint explicitly)",
            );
          }
          const date = opts.date || todayIso();

          const existing = findSnapshotByDate(opts.team, sprint, date, opts.db);
          if (existing && !opts.force) {
            fail(
              `a snapshot for team "${opts.team}" sprint "${sprint}" on ${date} already exists (id ${existing.id}, saved ${existing.created_at}) — this is almost always an accidental re-import. Pass --force to save another anyway, or use a different --date if this is a deliberate same-day re-check.`,
            );
          }

          const rosterRows = getRosterAsOf(opts.team, date, opts.db);
          const roster: Roster = Object.fromEntries(
            rosterRows.map((row) => [row.engineer_name, { role: row.role, weight: row.weight ?? undefined, notes: row.notes ?? undefined }]),
          );
          const report = buildTeamReport({ name: opts.team, sprint }, [providerResult], roster);
          saveSnapshot(
            { team_name: opts.team, sprint, snapshot_date: date, sprint_start_date: opts.sprintStart, report },
            opts.db,
          );
          return printJson(ReportsPayloadSchema.parse(buildReportsPayload([report])));
        }

        const teamName = opts.teamName || detected.team;
        if (!teamName) {
          fail(
            "--team-name is required, and it couldn't be auto-detected — this source's issues don't all agree on one project (not every team's data is consistent enough to derive it; pass --team-name explicitly)",
          );
        }
        const sprint = opts.sprint || detected.sprint;
        if (!sprint) {
          fail(
            "--sprint is required, and it couldn't be auto-detected — this source's issues don't all agree on one sprint (not every team's data is consistent enough to derive it; pass --sprint explicitly)",
          );
        }

        const roster = opts.roster ? await loadRoster(opts.roster) : undefined;
        const report = buildTeamReport({ name: teamName, sprint }, [providerResult], roster);
        return printJson(ReportsPayloadSchema.parse(buildReportsPayload([report])));
      }

      fail("one of --input or --config is required");
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

function resolveReasoningProvider(opts: { provider: string; url: string; model?: string }): ReasoningProvider {
  if (opts.provider === "claude") return new ClaudeReasoningProvider(opts.model || "claude-opus-5");
  if (opts.provider === "ollama") return new OllamaReasoningProvider(opts.url, opts.model || "llama3.1");
  fail(`unknown --provider "${opts.provider}"; expected "ollama" or "claude"`);
}

program
  .command("reason")
  .description("Fill recommendation fields by sending signals to an LLM (local Ollama by default)")
  .option("--input <file>", "a reports payload produced by `analyze` (ad hoc; no persistence)")
  .option("--roster <file>", "roster file to source work-pattern notes from, when using --input")
  .option("--charter <text>", "team charter/responsibilities, when using --input")
  .option("--sprint-length-days <n>", "sprint length in days, when using --input")
  .option("--days-into-sprint <n>", "how far into the sprint this snapshot is, when using --input")
  .option("--team <name>", "use a saved team's snapshot instead of --input; enriches the prompt with the team's charter/sprint length/roster notes automatically")
  .option("--sprint <label>", "sprint label — required with --team")
  .option("--snapshot-date <date>", "pick a specific dated snapshot for --sprint (default: the latest one)")
  .option("--provider <name>", "ollama (default) or claude", "ollama")
  .option("--url <url>", "Ollama server URL", "http://localhost:11434")
  .option("--model <name>", "model name for the chosen provider (default: llama3.1 for ollama, claude-opus-5 for claude)")
  .option("--context <text>", "additional team-specific facts the model can't infer from signals alone")
  .option("--db <path>", "database file path (default: ./teamgauge.db or TEAMGAUGE_DB)")
  .action(async (opts) => {
    try {
      const provider = resolveReasoningProvider(opts);

      if (opts.team) {
        if (!opts.sprint) fail("--sprint is required when using --team");

        const snapshot = opts.snapshotDate
          ? listSnapshots(opts.team, opts.sprint, opts.db).find((row) => row.snapshot_date === opts.snapshotDate)
          : getLatestSnapshot(opts.team, opts.sprint, opts.db);
        if (!snapshot) {
          fail(`no snapshot found for team "${opts.team}" sprint "${opts.sprint}"${opts.snapshotDate ? ` on ${opts.snapshotDate}` : ""}`);
        }

        const report = TeamReportSchema.parse(JSON.parse(snapshot.report_json));
        const profile = getTeam(opts.team, opts.db);
        const rosterRows = getRosterAsOf(opts.team, snapshot.snapshot_date, opts.db);
        const engineerNotes = Object.fromEntries(
          rosterRows.filter((row) => row.notes).map((row) => [row.engineer_name, row.notes as string]),
        );
        const daysIntoSprint = snapshot.sprint_start_date
          ? Math.max(
              0,
              Math.round(
                (new Date(snapshot.snapshot_date).getTime() - new Date(snapshot.sprint_start_date).getTime()) / 86_400_000,
              ),
            )
          : undefined;

        const ctx: ReasoningContext = {
          freeText: opts.context,
          charter: profile?.charter ?? undefined,
          sprintLengthDays: profile?.sprint_length_days ?? undefined,
          daysIntoSprint,
          engineerNotes,
        };

        const updatedReport = await reasonAboutReport(report, provider, ctx);
        updateSnapshotReport(snapshot.id, updatedReport, opts.db);
        return printJson(ReportsPayloadSchema.parse(buildReportsPayload([updatedReport])));
      }

      if (opts.input) {
        const raw = JSON.parse(await readFile(opts.input, "utf-8"));
        const payload = ReportsPayloadSchema.parse(raw);

        let engineerNotes: Record<string, string> | undefined;
        if (opts.roster) {
          const roster = await loadRoster(opts.roster);
          engineerNotes = {};
          for (const name of Object.keys(roster)) {
            const resolved = resolveRosterEntry(name, "", roster);
            if (resolved.notes) engineerNotes[name] = resolved.notes;
          }
        }

        const ctx: ReasoningContext = {
          freeText: opts.context,
          charter: opts.charter,
          sprintLengthDays: opts.sprintLengthDays ? Number(opts.sprintLengthDays) : undefined,
          daysIntoSprint: opts.daysIntoSprint ? Number(opts.daysIntoSprint) : undefined,
          engineerNotes,
        };

        const reports = await Promise.all(payload.reports.map((report) => reasonAboutReport(report, provider, ctx)));
        return printJson(ReportsPayloadSchema.parse(buildReportsPayload(reports)));
      }

      fail("one of --input or --team is required");
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

program
  .command("models")
  .description("List models available from a reasoning provider (e.g. `ollama list`, or the Claude Models API)")
  .option("--provider <name>", "ollama (default) or claude", "ollama")
  .option("--url <url>", "Ollama server URL", "http://localhost:11434")
  .action(async (opts) => {
    try {
      if (opts.provider === "claude") return printJson(await listClaudeModels());
      if (opts.provider === "ollama") return printJson(await listOllamaModels(opts.url));
      fail(`unknown --provider "${opts.provider}"; expected "ollama" or "claude"`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

program
  .command("setup")
  .description("Interactive questionnaire to create/update a saved team profile (makeup, sprint length, responsibilities)")
  .option("--db <path>", "database file path (default: ./teamgauge.db or TEAMGAUGE_DB)")
  .action(async (opts) => {
    await runSetup(opts.db);
  });

const teamCmd = program.command("team").description("Manage saved team profiles");

teamCmd
  .command("list")
  .description("List saved team profiles")
  .option("--db <path>", "database file path")
  .action((opts) => {
    printJson(listTeams(opts.db));
  });

teamCmd
  .command("show")
  .description("Show a team's profile and current roster")
  .requiredOption("--team <name>")
  .option("--date <date>", "as-of date for the roster (default: today)")
  .option("--db <path>", "database file path")
  .action((opts) => {
    const profile = getTeam(opts.team, opts.db);
    if (!profile) fail(`no team named "${opts.team}" — run \`teamgauge setup\` first`);
    const asOf = opts.date || todayIso();
    printJson({
      profile,
      roster: getRosterAsOf(opts.team, asOf, opts.db),
      departed: getDepartedAsOf(opts.team, asOf, opts.db),
      knownEngineers: listKnownEngineers(opts.team, opts.db),
    });
  });

teamCmd
  .command("set-role")
  .description("Record a role (or role change) for someone on a saved team — adds a dated entry, never overwrites history")
  .requiredOption("--team <name>")
  .requiredOption("--engineer <name>")
  .requiredOption("--role <role>")
  .option("--weight <n>", "load weight (default: 1)")
  .option("--notes <text>", "work-pattern fact for the reasoning step")
  .option("--effective <date>", "when this takes effect (default: today)")
  .option("--db <path>", "database file path")
  .action((opts) => {
    if (!getTeam(opts.team, opts.db)) fail(`no team named "${opts.team}" — run \`teamgauge setup\` first`);
    addRosterEntry(
      opts.team,
      {
        engineer_name: opts.engineer,
        role: opts.role,
        weight: opts.weight ? Number(opts.weight) : undefined,
        notes: opts.notes,
        effective_from: opts.effective || todayIso(),
      },
      opts.db,
    );
    printJson({ ok: true, team: opts.team, engineer: opts.engineer, role: opts.role, effective_from: opts.effective || todayIso() });
  });

teamCmd
  .command("depart")
  .description("Mark someone as departed as of a date — a dated fact, not a deletion; excludes them from the default roster/autocomplete going forward without touching history. Reactivate with `set-role`.")
  .requiredOption("--team <name>")
  .requiredOption("--engineer <name>")
  .option("--effective <date>", "when they left (default: today)")
  .option("--db <path>", "database file path")
  .action((opts) => {
    if (!getTeam(opts.team, opts.db)) fail(`no team named "${opts.team}" — run \`teamgauge setup\` first`);
    const effective = opts.effective || todayIso();
    markDeparted(opts.team, opts.engineer, effective, opts.db);
    printJson({ ok: true, team: opts.team, engineer: opts.engineer, departed_effective: effective });
  });

teamCmd
  .command("create")
  .description("Create/update a team profile non-interactively (see `teamgauge setup` for the guided version)")
  .requiredOption("--team <name>")
  .option("--sprint-length-days <n>")
  .option("--charter <text>")
  .option("--db <path>", "database file path")
  .action((opts) => {
    createOrUpdateTeam(
      { name: opts.team, sprint_length_days: opts.sprintLengthDays ? Number(opts.sprintLengthDays) : null, charter: opts.charter ?? null },
      opts.db,
    );
    printJson({ ok: true, team: opts.team });
  });

program
  .command("history")
  .description("List saved snapshots for a team")
  .requiredOption("--team <name>")
  .option("--sprint <label>", "restrict to one sprint")
  .option("--db <path>", "database file path")
  .action((opts) => {
    const rows = listSnapshots(opts.team, opts.sprint, opts.db);
    printJson(
      rows.map((row) => {
        const report: TeamReport = JSON.parse(row.report_json);
        return {
          id: row.id,
          sprint: row.sprint,
          snapshot_date: row.snapshot_date,
          sprint_start_date: row.sprint_start_date,
          team_velocity: report.team_metrics.team_velocity,
          total_resolved: report.team_metrics.total_resolved,
          team_avg_cycle_time_hours: report.team_metrics.team_avg_cycle_time_hours,
        };
      }),
    );
  });

program
  .command("trend")
  .description("Compute deterministic deltas across a team's saved snapshots (sprint-over-sprint and within-sprint updates)")
  .requiredOption("--team <name>")
  .option("--sprint <label>", "restrict to one sprint's updates; omit for full cross-sprint history")
  .option("--reason", "also generate a synthesized, accumulated report over the whole trend (patterns across checkpoints, not per-snapshot)")
  .option("--provider <name>", "ollama (default) or claude — only used with --reason", "ollama")
  .option("--url <url>", "Ollama server URL — only used with --reason", "http://localhost:11434")
  .option("--model <name>", "model name — only used with --reason")
  .option("--context <text>", "team-specific facts for the reasoning step — only used with --reason")
  .option("--db <path>", "database file path")
  .action(async (opts) => {
    try {
      const rows = listSnapshots(opts.team, opts.sprint, opts.db);
      if (rows.length === 0) fail(`no snapshots found for team "${opts.team}"${opts.sprint ? ` sprint "${opts.sprint}"` : ""}`);
      const points = rows.map((row) => ({
        snapshot_date: row.snapshot_date,
        sprint: row.sprint,
        report: TeamReportSchema.parse(JSON.parse(row.report_json)),
      }));
      const trend = computeTrend(points);

      if (!opts.reason) return printJson(trend);

      const provider = resolveReasoningProvider(opts);
      const cumulative = await reasonAboutTrend(trend, provider, { freeText: opts.context });
      printJson({ ...trend, cumulative });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

program.parseAsync(process.argv);
