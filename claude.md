# TeamGauge — Claude Code Working Specification

## Purpose

TeamGauge is a workload intelligence system that ingests signals from multiple sources (Jira required; optional providers like GitHub, CSV, URLs, JQL, manual input), produces a normalized JSON payload, and then runs a separate reasoning step (local Ollama by default, or Claude) over that payload to generate the actual recommendations. The reasoning step is the point of the tool, not an afterthought — ingestion exists to feed it clean, deterministic signals. Any LLM/agent can still consume the normalized JSON directly if the built-in reasoning step isn't wanted.

Claude Code should use this document as the authoritative guide when generating code, pipelines, adapters, schemas, or CLI/UI components.

---

## Core Principles

- Agent-agnostic: Output JSON must be consumable by Ollama, Copilot, ChatGPT CLI, etc.
- Input-agnostic: Multiple input formats (JSON, URL, CSV, JQL, manual form).
- Team-agnostic: Works for engineering, PMO, product, support, operations.
- Reasoning-free ingestion: Ingestion and normalization produce signals only; no interpretation happens there. Interpretation happens in the separate, explicit reasoning step (see "Reasoning Step" below) — this principle is about keeping ingestion pure, not about excluding reasoning from the product.
- Unified schema: All providers normalize into the same signal structure.
- Reasoning-provider-agnostic: The reasoning step defaults to a local Ollama server (no vendor lock-in, no API key required) and supports Claude as an alternative. Never hardcode a single reasoning provider as the only option.
- Multi-team: A single output payload may contain one or more team reports. A single-team run is just a one-element `reports` array — there is no separate "single team" schema.
- Team profiles persist, roster history is versioned: a saved team's makeup, sprint length, and charter don't need retyping on every run, and a role change is a new dated fact, never an overwrite — a past snapshot must keep showing the role that was true when it was taken, not whatever is current now.
- Snapshots are append-only: analyzing the same sprint again — including a manager updating it mid-sprint — always adds a new dated data point. Nothing about a team's history is ever overwritten except by explicitly enriching a snapshot with reasoning output (recommendations only, never signals).

---

## Output Schema (Canonical)

Claude Code must always produce JSON in this shape. The top level is always a `reports` array — a single-team run produces a one-element array, not a bare object:

```json
{
  "reports": [
    {
      "team": {
        "name": "",
        "sprint": "",
        "members": 0
      },
      "engineers": [
        {
          "name": "",
          "role": "",
          "signals": {
            "work_items": 0,
            "cycle_time_hours": 0,
            "blocked_items": 0,
            "priority_pressure": "",
            "context_switching_index": 0,
            "unplanned_work_ratio": 0
          },
          "derived_metrics": {
            "load_score": 0,
            "burnout_risk": "",
            "resolved_count": 0,
            "velocity": 0,
            "weight": 1
          },
          "recommendations": {
            "redistribute_to": [],
            "reduce_scope": [],
            "notes": ""
          }
        }
      ],
      "team_metrics": {
        "total_work_items": 0,
        "total_resolved": 0,
        "team_velocity": 0,
        "team_avg_cycle_time_hours": 0
      },
      "team_recommendations": {
        "redistribute_work": [],
        "sprint_feasibility": "",
        "notes": ""
      }
    }
  ]
}
```

Claude Code should never alter this structure unless explicitly instructed. `redistribute_to` on an engineer refers to another engineer within the same team report; TeamGauge does not infer cross-team redistribution.

`resolved_count`/`velocity` (per engineer) and `team_metrics` (per report) are deterministic — pure sums/averages over signals, computed at `analyze` time, not by the reasoning step. `velocity` is story points on resolved issues when the adapter can read them (e.g. a Jira CSV export's Story Points column), else the same value as `resolved_count` — never an invented estimate. `team_metrics` includes every entry in `engineers`, including the `"Unassigned"` bucket, since its item count is real team throughput.

---

## Ingestion Providers

Claude Code should implement ingestion as modular providers:

### Required

- `JiraProvider`
  - Accepts: JSON, URL, JQL
  - Outputs normalized signals

### Optional

- `GitHubProvider`
- `CSVProvider`
- `URLProvider`
- `ManualProvider`

Each provider must output:

```json
{
  "signals": {
    "work_items": 0,
    "cycle_time_hours": 0,
    "blocked_items": 0,
    "priority_pressure": "",
    "context_switching_index": 0,
    "unplanned_work_ratio": 0
  }
}
```

---

## CLI Requirements

Claude Code should generate a CLI with commands:

```text
teamgauge ingest --json <file>
teamgauge ingest --csv <file>
teamgauge ingest --url <endpoint>
teamgauge ingest --jql "<query>"
teamgauge analyze --input <file|url> [--roster <file>]
teamgauge analyze --config <file>
```

`--config <file>` accepts a list of team definitions (each with its own name and provider sources) and produces a single `reports` array with one entry per team. The single-source flags (`--json`, `--csv`, `--url`, `--jql`, `--input`) still produce a `reports` array — just with one element.

### Team Name / Sprint: Required, Derived Before Asked

`--team-name` and `--sprint` (on `analyze --input`, ad hoc or `--team` DB mode alike) are always required in the end, but TeamGauge tries to derive them from the source before ever asking the user to type them:

- **Team name** — from every issue's project key, but *only* when every issue in the source unanimously agrees on one. A CSV/JSON export mixing multiple projects means no team name is derived — the user must supply `--team-name`.
- **Sprint** — from a CSV export's `Sprint` column, resolved to each issue's *current* sprint (the last non-empty value among that issue's repeated Sprint columns — Jira's CSV exporter lists an issue's full sprint history across several columns, in chronological order; the first column is that issue's *oldest* sprint, not its current one). Derived only when every issue agrees on the same current sprint. Not attempted at all for the JSON/URL/JQL sources, since Jira's REST API exposes sprint via a custom field whose ID varies per instance — guessing it would mean hardcoding a Jira field, which claude.md forbids.
- **Never a majority guess.** Detection requires unanimous agreement across every issue in the source; a near-consensus is treated the same as no consensus. Not every team's data is consistent enough to derive from — that's expected, not a bug, and the CLI fails with a clear message telling the user to supply the flag explicitly rather than silently defaulting to a placeholder like `"Team"`.
- Whenever a value is used from detection, the CLI prints a notice to stderr saying what it detected and which flag would override it — stdout stays pure JSON regardless.
- Explicit `--team-name`/`--sprint` always wins over detection, unconditionally.

This applies to the UI's Team name/Sprint fields too — leaving them blank attempts detection; the request fails with a clear error only if detection also comes up empty. When only one of the two fails to detect (e.g. team name derives fine but the source spans more than one current sprint), the server still reports whatever it *did* detect alongside the error (`{ error, detected }`), and the UI prefills that field automatically — a partial detection is never discarded just because the other field couldn't be resolved.

### Multi-Team Config Format

`sources` keys map 1:1 to provider names (`jira`, `github`, `csv`, `url`, `manual`), so adding a provider never changes this schema.

```json
{
  "teams": [
    {
      "name": "Platform",
      "sprint": "2026-09-A",
      "sources": {
        "jira": { "jql": "project = PLAT AND sprint in openSprints()" },
        "csv": "./manual/platform-extra.csv"
      },
      "roster": "./rosters/platform.json"
    },
    {
      "name": "Support",
      "sprint": "2026-09-A",
      "sources": {
        "jira": { "url": "https://issues.example.com/api/..." }
      }
    }
  ]
}
```

`roster` is optional. It points to a JSON file mapping engineer name to a free-form role label, or to `{ "role": ..., "weight": ... }` when a capacity/tolerance weight for that person is also known:

```json
{
  "jason.choi": "SDET",
  "karan.gill": { "role": "Lead Engineer", "weight": 0.8 },
  "william.anton": { "role": "Lead SDET", "weight": 0.8 }
}
```

Role labels are never a fixed enum — TeamGauge is team-agnostic, so a support or PMO roster can use its own vocabulary (`"L2 Support"`, `"PM"`, ...). An engineer missing from the roster (or a missing roster entirely) simply keeps `role: ""` — TeamGauge never invents a title.

`weight` defaults to `1` (no adjustment) and multiplies `derived_metrics.load_score`: below `1` means the same raw workload reads as lower load for that person (e.g. a senior handling it comfortably), above `1` means it reads as higher. The user defines the number — TeamGauge never invents a seniority hierarchy.

CLI output must be pure JSON.

---

## Reasoning Step

A separate command fills the `recommendations` / `team_recommendations` fields that `ingest`/`analyze` always leave empty:

```text
teamgauge reason --input <reports-file> [--provider ollama|claude] [--url <ollama-url>] [--model <name>] [--context <text>]
```

- `--provider` defaults to `ollama`. `--url` (default `http://localhost:11434`) points at any local or remote Ollama server. `--model` defaults to `llama3.1` for Ollama, `claude-opus-5` for Claude.
- `--context` is optional free text for team-specific process facts the model can't infer from signals alone (e.g. how a team actually works its backlog). It's included in the prompt as ground truth. Never guessed by TeamGauge — always supplied by the caller.
- The reasoning step never touches `signals`, `derived_metrics`, or `team_metrics` — those are already final, deterministic values from `analyze`. It only ever writes into `recommendations` and `team_recommendations`.
- The prompt is given `team_metrics` and every engineer's full `derived_metrics` (including `resolved_count`/`velocity`) specifically so the model can produce comparative, non-obvious analysis (ratios, outliers, cross-engineer comparisons) instead of restating numbers already visible per-engineer. A one-sentence, non-comparative note is a prompt-quality regression, not an acceptable output.
- **The `"Unassigned"` bucket is never a redistribution target or source.** It's a shared backlog queue, not a person — the prompt explicitly forbids phrasing like "redistribute Unassigned's work to X", and independent of what the model does, TeamGauge deterministically strips `"Unassigned"` from every `redistribute_to`/`redistribute_work` array after the model responds (`src/reasoning/reason.ts`). Prompting alone was observed to be insufficient — smaller local models still emitted it in the structured fields even when told not to in prose, so this is enforced in code, not just in the prompt.
- Output is validated with a strict JSON Schema / Zod schema on the way back from the model — this is not free-text parsing. `redistribute_to` is constrained by prompt instruction to only name engineers within the same team report.
- **Every `object`-type node in `RECOMMENDATIONS_JSON_SCHEMA`/`CUMULATIVE_JSON_SCHEMA` must set `additionalProperties: false` explicitly** — Claude's structured-output validator (`output_config.format`) rejects the whole request with a 400 if even one nested object omits it, while Ollama's structured output doesn't enforce this at all. This is a real, shipped bug caught by an actual "Generate Recommendations" attempt with `--provider claude`: the schemas were built and tested against Ollama first, worked fine there, and only failed once Claude was tried. Since both providers share the same schema objects (`ReasoningProvider.chat(prompt, jsonSchema)`), the fix has to satisfy Claude's stricter requirement everywhere — there's no such thing as an Ollama-only or Claude-only version of these schemas.
- **`ClaudeReasoningProvider.chat()` uses `max_tokens: 8192`, not a smaller default.** The prompt asks for multi-sentence, comparative, per-engineer analysis, and a team with several engineers can genuinely produce more JSON than a small budget allows — a real team of 9 with 4096 was cut off mid-string on a `notes` field, and the caller only saw a cryptic `JSON.parse` failure ("Unterminated string in JSON at position ...") with no indication the real cause was a length limit. Fixed two ways: the higher budget makes truncation rare for realistic team sizes, and `chat()` now checks `response.stop_reason === "max_tokens"` before parsing and throws a clear, actionable error instead of letting a confusing parse exception surface. `OllamaReasoningProvider` has no equivalent hard cap to worry about here — Ollama's `num_predict`/context window behaves differently and wasn't observed to truncate the same way.
- The UI exposes the same step as a "Generate Recommendations" control (provider/URL/model/context fields) that calls `POST /api/reason` with the currently-loaded payload and re-renders the result — this is UI-triggered reasoning, not UI-computed reasoning; the actual model call always happens server-side.

### Listing available models

Don't make the user type a model name from memory — list what's actually available, the same way `ollama list` would:

```text
teamgauge models [--provider ollama|claude] [--url <ollama-url>]
```

- Ollama: hits the server's own `GET /api/tags` (what `ollama list` itself uses) — always reflects what's actually pulled on that server, never a hardcoded list.
- Claude: uses the Anthropic Models API (`client.models.list()`) — requires credentials; fails with a clear error if none are configured, same as the reasoning step itself would.
- The UI's Model field is a `<select>` populated by `GET /api/models?provider=...&url=...` on page load and whenever provider/URL changes (plus a manual refresh button) — never a free-text field the user has to fill in from memory. If listing fails (e.g. Claude with no API key), the dropdown shows a clear "Could not load models" state rather than breaking the page; the reasoning call itself will surface the same underlying error if attempted anyway.

---

## Persistence Layer

TeamGauge is no longer stateless. A local SQLite file (`./teamgauge.db` by default, or `TEAMGAUGE_DB` / `--db <path>`) — a single file, no server process to run — stores:

- **`teams`** — one row per saved team profile: name, `sprint_length_days`, `charter` (what the team is responsible for, in the team's own words). Created/edited via `teamgauge setup` (interactive questionnaire) or `teamgauge team create` (scripted).
- **`roster_entries`** — every role assignment ever recorded, each with an `effective_from` date. Adding a role is always an INSERT, never an UPDATE to an existing row — that's what makes a role change over time possible without corrupting past reports. Resolving "who had what role" for a given date always takes the most recent entry with `effective_from <= that date`. A snapshot dated before a role fact was ever recorded correctly shows that role as unknown at that point in time — this is intentional point-in-time correctness, not a bug, even though it can look surprising the first time you see it (e.g. backfilling a snapshot date earlier than when you actually ran `teamgauge team set-role`).
- **`snapshots`** — one row per `analyze` run against a saved team: `sprint` label, `snapshot_date`, optional `sprint_start_date`, and the full `TeamReport` JSON. **Append-only** — re-analyzing the same sprint, even on the same day, adds a new row; nothing deduplicates an accidental re-import against an identical prior one. This is what lets a manager update the same sprint mid-way and lets `trend` show genuine progression, both within one sprint and across sprints. The one case a snapshot IS updated in place: after `reason` runs against it, the same row's `report_json` is overwritten with recommendations, not versioned — a second `reason` run replaces the first's recommendations rather than keeping both.
- **Foreign keys are enforced** (`PRAGMA foreign_keys = ON`, set explicitly in `src/db/connection.ts` — SQLite ignores `REFERENCES` otherwise). `analyze --team <name>` checks the team profile exists before ingesting anything and fails with a clear message if not — a typo'd or never-set-up `--team` name must never silently create an orphaned snapshot with an empty roster.
- **Exact-collision duplicate guard.** `analyze --team` refuses to save when a snapshot already exists for the exact same team+sprint+date, since that's almost always an accidental re-import rather than a deliberate mid-sprint re-check (those land on a different date) — it fails with the existing snapshot's id and timestamp rather than silently adding a confusing near-duplicate row that would pollute `trend`'s deltas. `--force` saves anyway for the rare case a genuine same-day re-run is wanted.

### Commands

```text
teamgauge setup [--db <path>]
```
Interactive questionnaire: team name, sprint length, charter, then loop to add engineers (name, role, weight, work-pattern notes) until done. Safe to re-run against an existing team name to update its profile or add more roster history.

```text
teamgauge team list [--db <path>]
teamgauge team show --team <name> [--date <date>] [--db <path>]
teamgauge team create --team <name> [--sprint-length-days <n>] [--charter <text>] [--db <path>]
teamgauge team set-role --team <name> --engineer <name> --role <role> [--weight <n>] [--notes <text>] [--effective <date>] [--db <path>]
```
Non-interactive team management. `team show` resolves the roster as of a date (default: today) using the point-in-time rule above.

```text
teamgauge analyze --input <file|url> --team <name> --sprint <label> [--date <date>] [--sprint-start <date>] [--force] [--db <path>]
```
Same `analyze` command as always, but `--team` swaps `--roster`/`--team-name` for the saved profile and additionally **saves the resulting report as a dated snapshot**. Omitting `--team` keeps `analyze` fully stateless and backward-compatible — nothing is written to the database unless a saved team is named.

```text
teamgauge history --team <name> [--sprint <label>] [--db <path>]
teamgauge trend --team <name> [--sprint <label>] [--db <path>] [--reason --provider ollama|claude --url <ollama-url> --model <name> --context <text>]
```
`history` lists saved snapshots with their key numbers. `trend` computes deterministic deltas (load_score, velocity, resolved_count, cycle_time_hours — team-wide and per engineer) between consecutive snapshots in date order — pure arithmetic between two already-computed numbers, no reasoning involved. Passing `--sprint` shows within-sprint updates only; omitting it shows the full cross-sprint history.

### Cumulative (accumulated) reasoning over a trend

`trend --reason` is a **second, distinct reasoning entry point from `reason`** — it exists because "what should we do about the latest sprint" and "what does this team's whole trajectory tell us" are different questions with different answers, and conflating them was an actual mistake caught mid-build: an early version of this feature just concatenated every past snapshot's `recommendations.notes` into a list, which is not accumulation, it's a transcript. The two paths never share output:

- `reason` (`src/reasoning/reason.ts`, `RECOMMENDATIONS_JSON_SCHEMA`) reasons over **one** `TeamReport` and fills that same report's `recommendations`/`team_recommendations` fields.
- `reasonAboutTrend` (`src/reasoning/cumulativeReason.ts`, `CUMULATIVE_JSON_SCHEMA` in `src/reasoning/cumulativeSchema.ts`) reasons over a whole `TeamTrend` (every snapshot's points *and* deltas, from `computeTrend`) and produces a **new, freestanding** `{ summary, recommendations, concerning_trends }` object — never a per-snapshot echo. The prompt (`buildTrendPrompt`) explicitly instructs the model to name patterns only visible by comparing checkpoints (a monotonic climb, a plateau, an inverse correlation between two metrics across sprints) and forbids restating a single sprint's numbers as if they were a finding on their own.
- Both paths share the same underlying provider mechanism: `ReasoningProvider` (`src/reasoning/types.ts`) now exposes a generic `chat(prompt, jsonSchema): Promise<unknown>`, which `reason()` and `reasonAboutTrend()` both call with their own prompt-builder and schema — `OllamaReasoningProvider`/`ClaudeReasoningProvider` implement `chat()` once; `reason()` is just `chat()` plus the Unassigned-stripping and validation already documented above.
- Same `--provider`/`--url`/`--model`/`--context` flags and defaults as `reason` (Ollama default, Claude alternate, free-text context appended as ground truth).

`POST /api/trend-reason` (`{ team, sprint?, provider?, url?, model?, context? }`) is the server-side equivalent, returning `{ trend, cumulative }` — the deterministic deltas and the synthesized report together, so the UI never has to reconcile two separate fetches into one render pass.

`teamgauge reason --team <name> --sprint <label> [--snapshot-date <date>]` reads a saved snapshot instead of `--input`, and automatically enriches the prompt with the team's `charter`, `sprint_length_days`, computed sprint-position (`day X of Y`, from `sprint_start_date` vs `snapshot_date`) if available, and every engineer's roster `notes` (work-pattern facts, e.g. "SDETs on this team typically start testing in the back half of the sprint") — all as ground truth the model must respect, not something to second-guess. This is specifically what makes the reasoning step avoid misreading normal role cadence (e.g. an SDET showing no resolved work early in a sprint) as a problem. The ad hoc `--input` path still supports `--roster`/`--charter`/`--sprint-length-days`/`--days-into-sprint` flags for one-off enrichment without a saved profile.

**Known limitation:** the "Unassigned" framing rule (never a redistribution source/target) is deterministically enforced for the structured `redistribute_to`/`redistribute_work` arrays, but only prompt-enforced for free-text `notes` — a weaker local model has been observed describing "redistributing from Unassigned" in prose even when told not to, despite never doing so in the structured fields. Stronger models (Claude) are more reliable here; this is a real, not fully closed, gap with smaller local models.

**Weight is exposed to the reasoning step.** `derived_metrics.weight` (the roster capacity multiplier actually applied to compute `load_score`) is part of the canonical schema specifically so both a human reading the JSON and the reasoning provider can see *why* two engineers with similar raw signals ended up with different `load_score` — not just the already-weighted result. The prompt instructs the model to prefer naming a lower-weight person (more stated headroom) as a redistribution destination over someone at weight 1. The UI's per-engineer weight input now shows this real applied value instead of always defaulting to `1`.

**Recommendations must name people, not categories.** The reasoning JSON Schema's field descriptions (`src/reasoning/schema.ts`) explicitly instruct: `redistribute_to`/`redistribute_work` are short engineer-name lists only, `reduce_scope` is short phrases only, and all reasoning/explanation belongs in `notes`. This is a genuine improvement over an earlier version with no field descriptions at all (which let a model dump a full sentence into a single array slot), but compliance with the "short phrase, not a sentence" instruction is not fully reliable on smaller local models — `reduce_scope` in particular has been observed getting a full paragraph despite the field description saying otherwise. Same category of limitation as the Unassigned gap above: prompt/schema hints reduce but don't eliminate this on weaker models.

**Being comparative and specific is not the same as being readable.** An earlier version of `buildPrompt`/`buildTrendPrompt` demanded named comparisons and ratios but said nothing about sentence shape, and a real Claude response showed exactly the failure mode that leaves open: "Jason Choi's 1304-hour cycle time (150% team average) paired with 54 load score (62% team average) suggests potential for task simplification" — three statistics stacked into one clause, which reads as a data dump rather than analysis a manager can act on. Both prompts (`src/reasoning/types.ts`, `src/reasoning/cumulativeReason.ts`) now explicitly instruct plain, one-idea-per-sentence writing with at most one supporting number per sentence, and to lead with what a finding means before the arithmetic behind it — verified against a real Claude call reproducing the same scenario, which then led with "the person with the most work is the one converting the least of it" instead of restating the raw figures. This did not weaken the "must be comparative and named" requirement above; both now hold simultaneously.

---

## UI Requirements

Claude Code should generate UI components that:

- Visualize normalized signals
- Visualize derived metrics
- Visualize recommendations
- Provide “Download JSON” button
- Allow multiple input types (upload, URL, JQL, manual), auto-detecting which one from the input itself (file content/extension for JSON vs CSV, `http(s)://` prefix for URL vs JQL) rather than requiring the user to declare it
- Accept an optional roster file (name → free-form role) to enrich engineer entries
- Support one or more team reports per session, with a team selector/switcher when `reports` has more than one entry
- Provide a "Generate Recommendations" control (provider/URL/model) that triggers the server-side reasoning step and displays the result

The UI must not compute reasoning client-side — it triggers the server-side reasoning step (`POST /api/reason`) and displays whatever comes back. The model call itself never happens in the browser.

### Rendering model-generated text as markdown

Every reasoning-provider free-text field (an engineer's `recommendations.notes`, `team_recommendations.notes`, `team_recommendations.sprint_feasibility`, and the cumulative pass's `summary`/`recommendations`/`concerning_trends`) is rendered through `formatMessage` — a markdown-to-HTML converter loaded from `https://michaelyagi.github.io/js/md_to_html.js` (`web/index.html`, loaded before `app.js`) — instead of `escapeHtml`. Models routinely format their prose with markdown (`**bold**`, bullet/numbered lists, headings, inline code), and dumping that through `escapeHtml` into a plain `<p>` showed the raw asterisks/hashes literally instead of rendering them. `formatMessage` does its own HTML-escaping internally before converting markdown syntax, so it's safe to call directly on raw model output — never wrap its result in `escapeHtml` too (that would double-escape and show literal `&lt;strong&gt;` tags).

**Fields that are plain identifiers, not prose, still use `escapeHtml`** — engineer names, roles, dates, sprint labels, and `redistribute_to`/`redistribute_work` array entries (which are supposed to be short name lists, not sentences — see the "Recommendations must name people, not categories" note above). Converting a name through a markdown parser risks accidentally reformatting it if it happens to contain `_` or `*`.

**A `formatMessage` result must never be placed inside a `<p>` element.** Its output can legally contain block-level HTML (`<h1>`-`<h6>`, `<ol>`/`<ul>`, `<div>`-wrapped code blocks) when the model's markdown included a heading or list — and `<p>` cannot contain block children, so the browser silently closes the `<p>` early and reflows the rest of the content outside it, producing broken/reordered DOM. This was caught by an actual Playwright test during this feature's build: a `## Team summary` heading in `team_recommendations.notes` split the paragraph and left a stray empty `<p></p>` behind. Every element that wraps a `formatMessage` call must be a `<div>` (or another element that permits block children), never a `<p>`.

**Real reasoning output must not be styled like an empty-state placeholder.** `.notes-placeholder` (`web/styles.css`) — small, italic, muted color — was originally written for genuine "nothing here yet" hints ("No recommendations yet — click Generate Recommendations below.") and was then reused for the actual rendered analysis once it existed, which made substantive content look like a de-emphasized afterthought and hurt readability on the now-longer text the writing-style fix above produces. The engineer card, `team_recommendations.notes`, and the cumulative summary now switch to a separate `.reasoning-output` class (normal size, normal weight, not italic) once real content exists, and only fall back to `.notes-placeholder` for the genuine empty-state message. Never let a single CSS class serve both "there's nothing here" and "here's the actual answer" — they need opposite visual weight.

### UI Persistence Support

**The engineer card in an analyzed report is the roster's one editing surface — there is no separate manual "add a person" form.** An earlier version of this UI had both an editable engineer card *and* a standalone Add/Update Person form, which was confusing and wrong: the analyzed report is what discovers who's on a team in the first place (from real Jira/CSV data), so it should also be where you state facts about them, not a second disconnected form that required retyping a name from memory. The form was removed entirely.

How it actually works now:

- A **Team Setup** panel manages team-level metadata only: name, sprint length, charter (`GET /api/teams`, `POST /api/teams/profile` → `createOrUpdateTeam`) — no per-person fields here.
- Its roster table is **read-only** — an overview of who's configured, who's been seen in reports but not yet configured, and (behind a "Show past members" toggle) who's departed. The only actions available from this table are **Mark as departed** and **Reactivate…**; there is no add/edit-role control here.
- **Role, weight, and work-pattern notes are set directly on each engineer's card** in the Input panel's analyzed-report view, via an explicit **"Save Role/Weight/Notes to Roster" button per card** — not save-on-blur. Editing a field only updates local display state; nothing reaches the server until that button is clicked, so there's never ambiguity about whether typing into a field did or didn't persist. Clicking it reads all three current values off that card and `POST`s them together to `/api/teams/roster` — together, not one field at a time, because the endpoint upserts the whole roster row for that date; saving only the field that changed would silently blow away the other two. A per-card status line directly under the button reports the outcome ("✓ Saved to the ... roster just now." or a clear failure reason) — this is deliberately per-card, not a single shared status message, so it's obvious which person's edit it refers to.
- **This only persists when the loaded report came from a saved team.** `currentAnalyzedTeam` (set from the Analyze form's "Use saved team" selection at analysis time) gates it — editing a card from an ad hoc (no saved team) analysis stays local-only, exactly as before, and the UI says so explicitly ("Not saved — this analysis wasn't run against a saved team") rather than silently doing nothing.
- The weight input still also triggers the existing live `/api/derive-metrics` recompute for immediate `load_score`/`burnout_risk` feedback, in addition to (not instead of) the roster save.
- **The roster table isn't just `roster_entries` rows.** It's the union of that table with every engineer name ever discovered in the team's saved snapshots (`listKnownEngineers` in `src/db/snapshots.js`, scanning `report_json.engineers[].name` across all history, excluding the `"Unassigned"` sentinel) minus anyone currently departed. Someone seen in a report but never configured shows as "seen in reports — not yet configured" instead of being invisible. The CLI's `team show` exposes the same `knownEngineers` list.
- **Departure is a dated fact, not a deletion — same pattern as a role change.** `roster_entries` has a `departed` flag (`src/db/teamProfile.js`: `markDeparted`, `getDepartedAsOf`); marking someone departed inserts a new dated row rather than removing anything, so every past snapshot that included them stays exactly as accurate as it always was. `getRosterAsOf` excludes anyone whose latest entry as of a date is a departure; `getDepartedAsOf` is the exact inverse. **Reactivating needs no special mechanism** — it's just a normal, non-departed roster entry going forward (the UI's "Reactivate…" button posts an empty-role entry to clear the departure; the person's actual role then gets set on their card next time they appear in an analyzed report, same as anyone else). CLI: `teamgauge team depart --team <name> --engineer <name> [--effective <date>]`.

The **Analyze** form has a "Use saved team" dropdown. Selecting a saved team:

- Hides the roster-file upload and manual team-name field (roster now comes from the profile) and reveals snapshot-date / sprint-start-date fields.
- On submit, `POST /api/analyze` accepts an optional `team` field; when present, it resolves the roster from the database as-of the snapshot date (same point-in-time rule as the CLI), builds the report, and saves it as a new snapshot — mirroring `analyze --team` exactly, including the exact-collision duplicate guard.
- **The collision guard never blocks the view — only the save.** The UI's `POST /api/analyze` builds and returns the up-to-date report (current signals + current roster) regardless of whether a snapshot for that exact team+sprint+date already exists; a collision only means that report *also* comes back with `collision: true` and a `collisionMessage`, and it is not additionally saved as a new history entry. The UI renders the report normally either way and shows a non-blocking notice with a "Save as new snapshot" button (resubmits with `force: true`) for when a new dated entry is actually wanted. Earlier this returned a 409 with no report data at all, which meant re-analyzing on the same day after editing a card's role/weight appeared to silently do nothing — "let me see current numbers" and "record a new history entry" are different intents and were wrongly coupled. The CLI's `analyze --team` keeps the original fail-fast behavior (`--force` required to proceed) since scripted/batch usage should not silently skip an intended save.

Leaving "Use saved team" on its default ("— none —") keeps the Analyze form exactly as it was before this existed: fully ad hoc, zero persistence, roster-file upload available.

**Picking a team in Team Setup pre-fills "Use saved team," but only as a convenience, never a redirect.** The two team selectors (Team Setup's, and the Input panel's "Use saved team") are independent controls — Team Setup's answers "whose profile am I viewing/editing," Input's answers "which team does the file I'm about to analyze belong to," and those are genuinely different moments (you might browse a different team's roster in Team Setup while an Analyze run for another team is still queued up). Coupling them one-way solves the redundant-click case without introducing a surprise: `syncAnalyzeTeamSelection` (`web/app.js`) copies Team Setup's selection into "Use saved team" **only while the latter is still on its default "— none —"**; once you've made an explicit choice there, browsing to a different team in Team Setup never overwrites it.

### History & Trends panel

A **History & Trends** panel (between Team Setup and Input) makes saved history and trend deltas browsable in the UI, not just via the CLI:

- A team selector plus an optional sprint filter drive two parallel fetches, `GET /api/history?team=&sprint=` and `GET /api/trend?team=&sprint=`, rendered together: a **Snapshots** table (date, sprint, velocity, resolved/total, avg cycle time, whether that snapshot has any recommendations saved) and a **Trend** section with team-wide and per-engineer delta tables.
- **Delta coloring reflects sentiment, not arrow direction.** Velocity/resolved-count going up is good (green); load-score/cycle-time going up is bad (red) — the same up-arrow can be red in one column and never confused with green in another, because color is computed from a `higherIsBetter` flag per metric (`deltaClass(value, higherIsBetter)` in `web/app.js`), not from the raw sign of the delta. Getting this backwards (tying color straight to arrow direction) was an actual bug caught via screenshot during this feature's build — velocity dropping showed green, cycle-time rising showed red only sometimes — so the CSS classes are named `.delta-good`/`.delta-bad`/`.delta-flat`, deliberately not `.delta-up`/`.delta-down`, to keep this from regressing.
- An **Accumulated Report** sub-form (provider/URL/model/context, mirroring the per-report Recommendations panel) calls `POST /api/trend-reason` and renders `{ summary, recommendations, concerning_trends }` — this is the cumulative reasoning pass described above, not a list of past per-snapshot recommendations. `concerning_trends` renders in the risk-medium color to visually distinguish it from the plain `recommendations` list.
- Needing at least two snapshots to show any deltas is expected, not an error — a team with one snapshot shows the snapshots table with an explanatory placeholder in the Trend section instead of an empty table.

This closes out what was previously the only CLI-only feature relative to the CLI's capabilities — `history`/`trend` browsing (deterministic) and now `trend --reason` (cumulative reasoning) both have UI equivalents.

### A note on "today" and local vs. UTC dates

Every default-to-"today" computation in this codebase (the Analyze form's snapshot-date auto-fill, `effective_from` on a roster save/departure when not explicitly given, `analyze --team`'s snapshot date, `team show`'s as-of date) must use the **machine's local calendar date**, never `new Date().toISOString().slice(0, 10)` — that string is always the **UTC** date, which is a different calendar day from local "today" for roughly half of every 24-hour cycle depending on timezone (e.g. 9pm Pacific is already tomorrow in UTC). This was a real, shipped bug: roster entries saved via the engineer-card "Save Role/Weight/Notes to Roster" button got `effective_from` stamped one day in the future relative to local today, so a same-day analyze (using the correct local date) excluded them via the point-in-time `effective_from <= asOfDate` rule — roles/weights looked "saved" in the Team Setup table but never showed up on the engineer cards. Fixed with `localToday()` (`src/util/date.ts` for the Node side — server, both CLI files; an equivalent inline helper in `web/app.js` for the browser) using local `getFullYear()`/`getMonth()`/`getDate()` instead of `toISOString()`. Never reintroduce the UTC-slice pattern for any "what day is it" default in this codebase.

---

## What Claude Code Should NOT Do

- Do not embed reasoning in ingestion or normalization — the `reason` step is the only place interpretation happens.
- Do not modify the canonical JSON schema.
- Do not assume GitHub is required.
- Do not hardcode Jira fields; use adapters.
- Do not generate agent-specific formats.
- Do not hardcode a single reasoning provider as the only option — Ollama is the default, not the only choice.
- Do not let the reasoning step touch `signals` or `derived_metrics` — it only ever writes `recommendations` / `team_recommendations`.

---

## What Claude Code Should Prioritize

- Clean modular adapters
- Deterministic normalization
- Reusable CLI commands
- UI components that mirror CLI output
- Expandability for future providers

---

## Next Steps for Claude Code

- Implement JiraProvider
- Implement CSVProvider
- Implement unified normalization layer
- Implement multi-team config parsing and `reports` array aggregation
- Implement CLI scaffolding
- Implement UI scaffolding
- Implement the reasoning step (`teamgauge reason`, `POST /api/reason`) with Ollama as default provider and Claude as an alternate

### Deferred to a future phase (do not build yet, do not drop)

- **PTO/reduced-capacity notes.** A per-engineer, per-snapshot "out N days this sprint" fact (distinct from the standing roster `notes`, which describe a permanent work pattern, not a one-sprint circumstance) — so low output during a specific sprint isn't misread as underperformance when it was actually planned time off.
- **Sprint goal / commitment tracking.** A free-text "what this sprint was supposed to deliver" field per snapshot, so the reasoning step can assess actual-vs-committed, not just raw throughput.
- **On-call/support rotation flag.** Per-engineer, per-snapshot — explains elevated `context_switching_index` or lower throughput that isn't about the sprint's assigned work at all.
- **Cross-team dependency notes.** A way to record "blocked on Team X" at the team level, since TeamGauge only sees one team's data and has no way to know a blocker is external.
