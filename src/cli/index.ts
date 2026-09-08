#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { JiraProvider } from "../providers/jira/JiraProvider.js";
import { CSVProvider } from "../providers/csv/CSVProvider.js";
import type { ProviderResult } from "../providers/types.js";
import { MultiTeamConfigSchema } from "../schema/config.js";
import { ReportsPayloadSchema, TeamReportSchema, type TeamReport } from "../schema/canonical.js";
import type { Roster } from "../schema/roster.js";
import { buildReportsPayload, buildTeamReport } from "../normalization/aggregate.js";
import { gatherProviderResults } from "../normalization/gatherSources.js";
import { loadRoster, resolveRosterEntry } from "../normalization/roster.js";
import { computeTrend } from "../normalization/trend.js";
import { reasonAboutReport } from "../reasoning/reason.js";
import { reasonAboutTrend, reasonAboutPersonTrend } from "../reasoning/cumulativeReason.js";
import { OllamaReasoningProvider } from "../reasoning/providers/ollama.js";
import { ClaudeReasoningProvider } from "../reasoning/providers/claude.js";
import type { ReasoningContext, ReasoningProvider } from "../reasoning/types.js";
import { listOllamaModels, listClaudeModels } from "../reasoning/listModels.js";
import { runSetup } from "./setup.js";
import { createOrUpdateTeam, getTeam, listTeams, addRosterEntry, getRosterAsOf, getDepartedAsOf, markDeparted, overlayCurrentRosterFacts, overlayCurrentRosterFactsOnReport } from "../db/teamProfile.js";
import {
  saveSnapshot,
  listSnapshots,
  getLatestSnapshot,
  updateSnapshotReport,
  updateSnapshotContext,
  findSnapshotByDate,
  findByteIdenticalSnapshot,
  deleteSnapshot,
  findSimilarSprint,
  findSimilarSprintOnDate,
  renameSprintLabel,
  listKnownEngineers,
  setEngineerSnapshotContext,
  getEngineerSnapshotContext,
} from "../db/snapshots.js";
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
  .option("--sprint-goal <text>", "what this sprint was supposed to deliver — only used with --team; lets `reason` assess actual-vs-committed, not just raw throughput")
  .option("--blocked-by <text>", "cross-team dependency blocking this sprint (e.g. \"Platform team's API migration\") — only used with --team")
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
        const isCsvInput = opts.input.endsWith(".csv");
        const providerResult = isCsvInput
          ? await new CSVProvider().ingest(opts.input)
          : await new JiraProvider().ingest(
              opts.input.startsWith("http") ? { url: opts.input } : { json: opts.input },
            );

        // "issues don't all agree" is only literally true for CSV, where
        // sprint detection is actually attempted (from the Sprint column).
        // For JSON/URL sources it's never attempted at all — Jira's sprint
        // field is a custom field whose ID varies per instance, so guessing
        // it would mean hardcoding a Jira field (see claude.md) — so the
        // failure message below says that instead of implying disagreement
        // that was never checked.
        const sprintRequiredMessage = isCsvInput
          ? "--sprint is required, and it couldn't be auto-detected — this source's issues don't all agree on one sprint (not every team's data is consistent enough to derive it; pass --sprint explicitly)"
          : "--sprint is required — it can't be auto-detected from this source. Jira's sprint field lives in a custom field whose ID varies per Jira instance, so TeamGauge never guesses it for JSON/URL sources (only a CSV export's \"Sprint\" column is stable enough to auto-detect from). Pass --sprint explicitly — this is expected even if your query/export is already scoped to one sprint.";

        const detected = providerResult.detected ?? {};
        if (!opts.team && !opts.teamName && detected.team) {
          process.stderr.write(`teamgauge: detected team "${detected.team}" from the source (every issue agreed) — pass --team-name to override\n`);
        }
        if (!opts.sprint && detected.sprint) {
          process.stderr.write(`teamgauge: detected sprint "${detected.sprint}" from the source (every issue agreed) — pass --sprint to override\n`);
        }

        // A CSV export that genuinely spans several sprints (a backlog/board
        // export, not a "this sprint only" export) is real, useful data —
        // not an error to reject. When no single sprint was explicitly
        // given or unanimously detected, split the file into one group per
        // sprint actually present (see CSVProvider.ingestGroupedBySprint)
        // and produce one report per sprint, instead of forcing the caller
        // to either lose data or mislabel it under one guessed sprint.
        async function resolveSprintGroups(): Promise<Array<{ sprint: string; result: ProviderResult; derivedDate: string | null }>> {
          const sprint = opts.sprint || detected.sprint;
          if (sprint) return [{ sprint, result: providerResult, derivedDate: null }];
          if (!isCsvInput) fail(sprintRequiredMessage);

          const { groups, skippedNoSprint } = await new CSVProvider().ingestGroupedBySprint(opts.input);
          if (groups.length === 0) fail(sprintRequiredMessage);
          if (skippedNoSprint > 0) {
            process.stderr.write(
              `teamgauge: skipped ${skippedNoSprint} issue(s) with no sprint value at all — not attributable to any sprint\n`,
            );
          }
          process.stderr.write(
            `teamgauge: source spans ${groups.length} sprints, not one — splitting into a separate report per sprint: ${groups
              .map((g) => `"${g.sprint}" (${g.issueCount} issue${g.issueCount === 1 ? "" : "s"})`)
              .join(", ")}\n`,
          );
          return groups;
        }

        if (opts.team) {
          if (!getTeam(opts.team, opts.db)) {
            fail(`no team named "${opts.team}" — run \`teamgauge setup\` or \`teamgauge team create --team "${opts.team}"\` first`);
          }
          // Applies every collision/duplicate guard exactly as before for a
          // single sprint. Never calls fail() itself — the single-sprint
          // call site below fails fast on a skip (unchanged, documented
          // "scripted/batch usage should not silently skip an intended
          // save" behavior); the multi-sprint-group call site instead warns
          // and continues, since a bulk historical import capturing 5 of 6
          // sprints is far more useful than aborting the whole run over one
          // collision. Roster resolution moved inside (parameterized by
          // `date`, not a single outer constant) because a multi-sprint
          // group's date is no longer necessarily "today" for every group —
          // see resolveDateForGroup below.
          function attemptSave(sprint: string, result: ProviderResult, date: string): { report: TeamReport; saved: boolean; skipReason?: string } {
            const rosterRows = getRosterAsOf(opts.team, date, opts.db);
            const roster: Roster = Object.fromEntries(
              rosterRows.map((row) => [row.engineer_name, { role: row.role, weight: row.weight ?? undefined, notes: row.notes ?? undefined }]),
            );
            const similarSprint = findSimilarSprint(opts.team, sprint, opts.db);
            if (similarSprint) {
              process.stderr.write(
                `teamgauge: sprint "${sprint}" looks similar to an existing sprint on record for "${opts.team}": "${similarSprint}" — if these are the same sprint, re-run with --sprint "${similarSprint}" instead, or history will fragment across two labels for it.\n`,
              );
            }

            const existing = findSnapshotByDate(opts.team, sprint, date, opts.db);
            if (existing && !opts.force) {
              return {
                report: buildTeamReport({ name: opts.team, sprint }, [result], roster),
                saved: false,
                skipReason: `a snapshot for team "${opts.team}" sprint "${sprint}" on ${date} already exists (id ${existing.id}, saved ${existing.created_at}) — this is almost always an accidental re-import. Pass --force to save another anyway, or use a different --date if this is a deliberate same-day re-check.`,
              };
            }

            // Same date, different-but-similar sprint label — a much
            // stronger "this is the same sprint" signal than
            // label-similarity alone, so it gets the same explicit --force
            // requirement as an exact collision, not just the advisory
            // stderr notice above.
            if (!existing) {
              const sameDateSimilar = findSimilarSprintOnDate(opts.team, date, sprint, opts.db);
              if (sameDateSimilar && !opts.force) {
                return {
                  report: buildTeamReport({ name: opts.team, sprint }, [result], roster),
                  saved: false,
                  skipReason: `"${opts.team}" already has a snapshot on ${date} under a different sprint label: "${sameDateSimilar.sprint}" (id ${sameDateSimilar.id}) — this is very likely the same sprint typed/detected differently. Re-run with --sprint "${sameDateSimilar.sprint}" instead if so, or pass --force only if "${sprint}" is genuinely a different sprint.`,
                };
              }
            }

            const report = buildTeamReport({ name: opts.team, sprint }, [result], roster);

            // --force overrides the "same team+sprint+date" ambiguity check
            // above, but never this one: if the new report is byte-identical
            // to what's already saved, there is zero new information in it,
            // and saving it anyway only pollutes `trend`'s deltas with a
            // meaningless zero-change row. No flag bypasses this — a genuine
            // re-check always produces at least some different signal.
            if (existing && JSON.stringify(report) === existing.report_json) {
              return {
                report,
                saved: false,
                skipReason: `this would be an exact duplicate of snapshot id ${existing.id} (saved ${existing.created_at}) — the data hasn't changed since then, so nothing new was saved.`,
              };
            }

            // Not a same-date collision, but a byte-identical report
            // already on file for this team+sprint from an earlier date is
            // the same "accidental re-import" smell across a day boundary —
            // a normal collision (--force overrides it), not the hard
            // same-date rule above.
            if (!existing) {
              const byteIdentical = findByteIdenticalSnapshot(opts.team, sprint, JSON.stringify(report), opts.db);
              if (byteIdentical && !opts.force) {
                return {
                  report,
                  saved: false,
                  skipReason: `this would be byte-identical to snapshot id ${byteIdentical.id} for "${opts.team}" / "${sprint}" from ${byteIdentical.snapshot_date} (saved ${byteIdentical.created_at}) — nothing has changed since then. Pass --force if you deliberately want "still unchanged" recorded as of today.`,
                };
              }
            }

            saveSnapshot(
              {
                team_name: opts.team,
                sprint,
                snapshot_date: date,
                sprint_start_date: opts.sprintStart,
                sprint_goal: opts.sprintGoal,
                blocked_by: opts.blockedBy,
                report,
              },
              opts.db,
            );
            return { report, saved: true };
          }

          const explicitSprint = opts.sprint || detected.sprint;
          if (explicitSprint) {
            const date = opts.date || todayIso();
            const result = attemptSave(explicitSprint, providerResult, date);
            if (!result.saved) fail(result.skipReason!);
            return printJson(ReportsPayloadSchema.parse(buildReportsPayload([result.report])));
          }

          // --date, when given, still applies uniformly to every group (an
          // explicit choice always wins, unchanged). Left unspecified, each
          // group defaults to ITS OWN latest-activity date instead of
          // "today" for all of them — today is meaningless for several
          // already-closed historical sprints imported in one batch (they'd
          // all collide on one arbitrary date); each sprint's own last
          // Resolved/Created date is real and lets history/trend place them
          // correctly instead of stacking them on the import day.
          const groups = await resolveSprintGroups();
          const reports: TeamReport[] = [];
          for (const group of groups) {
            const date = opts.date || group.derivedDate || todayIso();
            const result = attemptSave(group.sprint, group.result, date);
            reports.push(result.report);
            process.stderr.write(
              result.saved
                ? `teamgauge: saved snapshot for "${opts.team}" / "${group.sprint}" on ${date}\n`
                : `teamgauge: skipped "${group.sprint}" — ${result.skipReason}\n`,
            );
          }
          return printJson(ReportsPayloadSchema.parse(buildReportsPayload(reports)));
        }

        const teamName = opts.teamName || detected.team;
        if (!teamName) {
          fail(
            "--team-name is required, and it couldn't be auto-detected — this source's issues don't all agree on one project (not every team's data is consistent enough to derive it; pass --team-name explicitly)",
          );
        }

        const roster = opts.roster ? await loadRoster(opts.roster) : undefined;
        const groups = await resolveSprintGroups();
        const reports = groups.map((g) => buildTeamReport({ name: teamName, sprint: g.sprint }, [g.result], roster));
        return printJson(ReportsPayloadSchema.parse(buildReportsPayload(reports)));
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

        const snapshot = resolveSnapshotOrFail(opts.team, opts.sprint, opts.snapshotDate, opts.db);

        const report = overlayCurrentRosterFactsOnReport(opts.team, snapshot.snapshot_date, TeamReportSchema.parse(JSON.parse(snapshot.report_json)), opts.db);
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

        const engineerSnapshotContext = getEngineerSnapshotContext(snapshot.id, opts.db);
        const engineerContext = Object.fromEntries(
          Object.entries(engineerSnapshotContext).map(([name, ctx]) => [name, { ptoDays: ctx.pto_days, onCall: ctx.on_call }]),
        );

        const ctx: ReasoningContext = {
          freeText: opts.context,
          charter: profile?.charter ?? undefined,
          sprintLengthDays: profile?.sprint_length_days ?? undefined,
          daysIntoSprint,
          engineerNotes,
          sprintGoal: snapshot.sprint_goal ?? undefined,
          blockedBy: snapshot.blocked_by ?? undefined,
          engineerContext,
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

const snapshotCmd = program.command("snapshot").description("Attach per-sprint facts to an already-saved snapshot");

function resolveSnapshotOrFail(team: string, sprint: string, snapshotDate: string | undefined, dbPath?: string) {
  const snapshot = snapshotDate
    ? listSnapshots(team, sprint, dbPath).find((row) => row.snapshot_date === snapshotDate)
    : getLatestSnapshot(team, sprint, dbPath);
  if (!snapshot) {
    fail(`no snapshot found for team "${team}" sprint "${sprint}"${snapshotDate ? ` on ${snapshotDate}` : ""}`);
  }
  return snapshot;
}

snapshotCmd
  .command("set-context")
  .description("Set this sprint's goal/commitment and/or a cross-team blocker on an existing snapshot — team-level facts, not per-engineer")
  .requiredOption("--team <name>")
  .requiredOption("--sprint <label>")
  .option("--snapshot-date <date>", "which dated snapshot for this sprint (default: the latest one)")
  .option("--sprint-goal <text>", "what this sprint was supposed to deliver")
  .option("--blocked-by <text>", "cross-team dependency blocking this sprint (e.g. \"Platform team's API migration\")")
  .option("--db <path>", "database file path")
  .action((opts) => {
    if (!opts.sprintGoal && !opts.blockedBy) fail("at least one of --sprint-goal or --blocked-by is required");
    const snapshot = resolveSnapshotOrFail(opts.team, opts.sprint, opts.snapshotDate, opts.db);
    updateSnapshotContext(snapshot.id, { sprint_goal: opts.sprintGoal, blocked_by: opts.blockedBy }, opts.db);
    printJson({ ok: true, snapshot_id: snapshot.id, sprint_goal: opts.sprintGoal, blocked_by: opts.blockedBy });
  });

snapshotCmd
  .command("set-engineer-context")
  .description("Set PTO days and/or on-call status for one person on an existing snapshot — true for this sprint only, not a standing roster fact")
  .requiredOption("--team <name>")
  .requiredOption("--sprint <label>")
  .requiredOption("--engineer <name>")
  .option("--snapshot-date <date>", "which dated snapshot for this sprint (default: the latest one)")
  .option("--pto-days <n>", "days out this sprint")
  .option("--on-call", "carrying on-call/support rotation this sprint")
  .option("--db <path>", "database file path")
  .action((opts) => {
    if (opts.ptoDays === undefined && !opts.onCall) fail("at least one of --pto-days or --on-call is required");
    const snapshot = resolveSnapshotOrFail(opts.team, opts.sprint, opts.snapshotDate, opts.db);
    setEngineerSnapshotContext(
      snapshot.id,
      opts.engineer,
      { ptoDays: opts.ptoDays !== undefined ? Number(opts.ptoDays) : undefined, onCall: Boolean(opts.onCall) },
      opts.db,
    );
    printJson({ ok: true, snapshot_id: snapshot.id, engineer: opts.engineer, pto_days: opts.ptoDays, on_call: Boolean(opts.onCall) });
  });

snapshotCmd
  .command("rename-sprint")
  .description("Merge two sprint labels that turned out to be the same real sprint — e.g. a short label typed by hand and the fuller auto-detected name")
  .requiredOption("--team <name>")
  .requiredOption("--from <label>", "the label to rename away from")
  .requiredOption("--to <label>", "the label to rename to — usually the fuller/more-detected-from-source one")
  .option("--db <path>", "database file path")
  .action((opts) => {
    try {
      const changed = renameSprintLabel(opts.team, opts.from, opts.to, opts.db);
      printJson({ ok: true, team: opts.team, from: opts.from, to: opts.to, snapshots_renamed: changed });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

snapshotCmd
  .command("delete")
  .description("Permanently remove a single saved snapshot — the escape hatch for a confirmed accidental duplicate, not a routine correction. No undo.")
  .requiredOption("--team <name>")
  .requiredOption("--sprint <label>")
  .requiredOption("--snapshot-date <date>", "which dated snapshot to delete (required — no \"latest\" default, to avoid deleting the wrong one when more than one exists)")
  .option("--db <path>", "database file path")
  .action((opts) => {
    const snapshot = resolveSnapshotOrFail(opts.team, opts.sprint, opts.snapshotDate, opts.db);
    deleteSnapshot(snapshot.id, opts.db);
    printJson({ ok: true, deleted_snapshot_id: snapshot.id, team: opts.team, sprint: opts.sprint, snapshot_date: opts.snapshotDate });
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
          sprint_goal: row.sprint_goal,
          blocked_by: row.blocked_by,
          engineer_context: getEngineerSnapshotContext(row.id, opts.db),
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
  .option("--engineer <name>", "with --reason, scope the accumulated report to just this person's own trajectory instead of the whole team's")
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
      const trend = overlayCurrentRosterFacts(opts.team, computeTrend(points), opts.db);

      if (!opts.reason) return printJson(trend);

      const provider = resolveReasoningProvider(opts);

      if (opts.engineer) {
        if (opts.engineer === "Unassigned") fail(`"Unassigned" is a shared backlog bucket, not a person — there's no individual trajectory to report on.`);
        const personTrend = trend.engineers.find((e) => e.name === opts.engineer);
        if (!personTrend) fail(`"${opts.engineer}" doesn't appear in any saved snapshot for "${opts.team}"${opts.sprint ? ` sprint "${opts.sprint}"` : ""}`);
        const cumulative = await reasonAboutPersonTrend(personTrend, opts.team, provider, { freeText: opts.context });
        return printJson({ engineer: opts.engineer, trend: personTrend, cumulative });
      }

      const cumulative = await reasonAboutTrend(trend, provider, { freeText: opts.context });
      printJson({ ...trend, cumulative });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

program.parseAsync(process.argv);
