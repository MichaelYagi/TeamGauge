# TeamGauge — System Design Document

## Overview

TeamGauge is a workload intelligence system that ingests signals from multiple sources, normalizes them into a unified schema, and then runs a reasoning step over that schema to produce recommendations. The reasoning step is the point of the system — everything upstream of it (providers, normalization, aggregation) exists to hand it clean, deterministic signals. It is a CLI tool, a UI tool (visualization + JSON export), and a reasoning step (local Ollama by default, or Claude), with the normalized JSON still consumable directly by any external LLM/agent that doesn't want to use the built-in step.

---

## Goals

- Provide a universal workload signal layer for any team type.
- Support multiple input formats (JSON, URL, CSV, JQL, manual).
- Produce consistent JSON output for any reasoning engine, including the built-in one.
- Support one or more team reports in a single output payload.
- Support both CLI and UI interfaces.
- Be easily extendable with new providers.
- Ship a working reasoning step by default (local Ollama), with Claude as an alternate provider — never locked to one vendor.

---

## Architecture

### 1. Input Layer

Supports:

- JSON upload
- CSV upload
- URL endpoint
- Jira JQL
- Manual form input

### 2. Provider Layer

Each provider converts raw data → normalized signals.

Providers:

- `JiraProvider` (required)
- `GitHubProvider` (optional)
- `CSVProvider`
- `URLProvider`
- `ManualProvider`

### 3. Normalization Layer

All providers output the same structure:

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

Normalization also computes `resolved_count` and `velocity` per engineer here — deterministic counts/sums over the same issues, not new interpretation. `velocity` is story points on resolved issues when the source tracks them (an adapter's optional `getStoryPoints`), else the same value as `resolved_count`.

This layer also attempts to derive the team name (project key) and current sprint (CSV `Sprint` column, resolved to each issue's *last* value — its current sprint, not its full sprint history) — but only when every issue in the source unanimously agrees; a source mixing projects or sprints yields no detected value at all, never a majority guess. `--team-name`/`--sprint` are still required in the end; detection just means the user often doesn't have to type them. See claude.md's "Team Name / Sprint: Required, Derived Before Asked" for the full contract.

Normalization ensures TeamGauge is team-agnostic.

### 4. Aggregation Layer

Combines signals from multiple providers into a unified team/engineer model. When multiple teams are requested (via `--config`), this layer runs once per team and collects the results into the `reports` array — teams are aggregated independently; signals and recommendations never cross team boundaries. This layer also computes `team_metrics` — team-wide totals/weighted averages over every engineer entry (including `"Unassigned"`, since its item count is real throughput) — so the report has real comparative numbers before the reasoning step ever runs.

### 5. Output Layer

Produces the canonical JSON schema — a `reports` array, one entry per team, each containing:

- team metadata
- engineer signals + derived metrics (including `resolved_count`/`velocity`)
- team metrics (velocity, closeout counts, average cycle time — deterministic, always populated by `analyze`, not the reasoning step)
- recommendations (empty until the reasoning step fills them)
- team recommendations (empty until the reasoning step fills them)

A single-team run produces a one-element `reports` array; there is no separate single-team shape.

### 6. Reasoning Layer

A dedicated, explicit step — `teamgauge reason` / `POST /api/reason` — sends the (recommendation-free) output of the Output Layer to a reasoning provider and merges the result back into `recommendations` / `team_recommendations`:

- engineer notes
- team notes
- redistribution suggestions
- feasibility assessments

**Default provider: a local Ollama server** (no vendor lock-in, no API key required). **Alternate provider: Claude**, for when a local model isn't available or capable enough. The interface (`ReasoningProvider`) is pluggable — adding another provider (e.g. a different hosted LLM) never changes the reasoning step's calling code, only adds an implementation.

The prompt is given `team_metrics` and each engineer's full `derived_metrics` (not just `signals`) specifically so recommendations can be comparative and grounded (ratios, outliers, backlog-vs-velocity math) instead of restating numbers already visible per-engineer — a single generic sentence per report is a prompt defect, not an acceptable output. `"Unassigned"` is explicitly described in the prompt as a shared backlog bucket, never a person, and is deterministically stripped from every `redistribute_to`/`redistribute_work` array in code after the model responds (`src/reasoning/reason.ts`) — prompting alone was insufficient in practice. The strip checks for the word anywhere in an entry, not just an exact match: a real example showed a model that also violated the separate "names only, no prose" rule by writing a full sentence ("assigning Unassigned's items to engineers with high load scores") — an exact-string check would have missed that entirely, since "Unassigned" was buried in prose rather than standing alone. An optional `context` string (CLI `--context`, UI context field) carries team-specific process facts the model has no way to infer (e.g. how a team actually works its backlog) and is treated as ground truth in the prompt.

This layer is architecturally separate from ingestion/normalization/aggregation (layers 1-5), which stay deterministic and reasoning-free — that separation is what "TeamGauge does not perform reasoning in ingestion" means. It does not mean TeamGauge has no reasoning step; the reasoning step is layer 6, and it's the reason the first five layers exist. The normalized JSON remains fully usable by any external LLM/agent that skips this layer entirely (Copilot, ChatGPT CLI, a different Ollama setup, etc.) — the built-in step is a convenience, not a requirement.

**Two reasoning entry points share this layer, not one.** `reason` (above) answers "what should we do about this one report." A second entry point, `reasonAboutTrend` (`src/reasoning/cumulativeReason.ts`), answers a different question — "what does this team's whole history tell us" — over a `TeamTrend` (every saved snapshot's points *and* deltas) rather than a single `TeamReport`, producing its own `{ summary, recommendations, concerning_trends }` shape rather than filling a report's `recommendations` field. This split exists because an early version of the feature just listed every past snapshot's recommendations end to end, which answers neither question well — a transcript of old advice is not a synthesis of the trend. The prompt for this path is explicit that a finding must reference a pattern across checkpoints (a climb, a plateau, a correlation between two metrics over time), not a restatement of the latest snapshot. Both entry points call through the same `ReasoningProvider.chat(prompt, jsonSchema)` primitive, so adding a third reasoning entry point later never means adding a third provider implementation.

The UI renders every free-text field this layer produces (per-engineer notes, `team_recommendations.notes`/`sprint_feasibility`, and the cumulative pass's `summary`/`recommendations`/`concerning_trends`) as markdown, not as escaped plain text — see claude.md's "Rendering model-generated text as markdown" for the mechanism (`formatMessage`) and the `<p>`-vs-`<div>` wrapping pitfall it surfaced.

### 7. Persistence Layer

A local SQLite file (single file, no server process — `./teamgauge.db` by default, overridable via `TEAMGAUGE_DB` or `--db`). Three tables:

- **`teams`** — a saved profile: name, sprint length, charter. Created/edited via the `setup` questionnaire or `team create`.
- **`roster_entries`** — append-only, dated role facts. A role change is a new row with a new `effective_from`, never an overwrite of the old one. Resolving a roster "as of" a date takes the most recent entry with `effective_from <= that date` per engineer — this is what keeps a historical snapshot's engineer roles accurate even after someone's real-world role later changes. A departure is the same pattern: a dated row with a `departed` flag, not a deletion — it excludes someone from the default roster view/autocomplete from that date forward without touching any past snapshot. Reactivation is just a later ordinary role entry — no separate mechanism needed, since the "latest entry as of a date" rule already makes it supersede the departure.
- **`snapshots`** — append-only, one row per `analyze` run against a saved team, holding the full `TeamReport` JSON plus `sprint`/`snapshot_date`/optional `sprint_start_date`. Re-analyzing the same sprint — including a manager checking it again mid-sprint — always inserts a new row; it never overwrites a prior one. The one in-place update: `reason` enriches an existing snapshot's `report_json` with recommendations, since that's the same data point gaining an annotation, not a new observation.

Analyzing without `--team` remains fully stateless — this layer is additive, not a requirement for using the tool.

An exact team+sprint+date collision is refused by default (`--force` to override) — see claude.md's "Exact-collision duplicate guard" for why: it's almost always an accidental re-import, and a silent duplicate would pollute `trend`'s deltas with a spurious near-zero (or misleadingly small) same-day change.

Every default-to-"today" date in this layer (a card's roster save, a departure, an `analyze --team` with no `--date`) must be the machine's **local** calendar date — see claude.md's "A note on 'today' and local vs. UTC dates" for a real bug this caused: `toISOString().slice(0, 10)` returns the UTC date, which briefly disagreed with local "today" and caused freshly-saved roster entries to look invisible to a same-day analyzed report. `src/util/date.ts`'s `localToday()` is the one correct way to get this value on the Node side.

---

## CLI Design

### Commands

```text
teamgauge ingest --json <file>
teamgauge ingest --csv <file>
teamgauge ingest --url <endpoint>
teamgauge ingest --jql "<query>"
teamgauge analyze --input <file|url> [--roster <file>]
teamgauge analyze --config <file>
```

`--config <file>` lists one or more teams, each with its own name, provider sources, and an optional per-team `roster` path, and produces a single `reports` array with one entry per team. `sources` keys map 1:1 to provider names, so the config schema doesn't change when a new provider is added. See claude.md's "Multi-Team Config Format" for the exact shape.

A roster maps engineer name to a free-form role label (never a fixed enum, since TeamGauge is team-agnostic), optionally paired with a `weight` — a per-role capacity/tolerance multiplier applied to `derived_metrics.load_score` (defaults to `1`, no adjustment). It's optional at every level: no `--roster`/no per-team `roster` means no roles are known and no weighting happens; a name missing from a supplied roster just leaves that engineer's `role` as `""` and `weight` at `1`. TeamGauge never guesses a title or a seniority hierarchy — the weight is always a number the user supplies.

### Output

Always pure JSON. A `reports` array — one or more entries, one per team.

### Reasoning Command

```text
teamgauge reason --input <reports-file> [--provider ollama|claude] [--url <ollama-url>] [--model <name>] [--context <text>]
```

Reads a `reports` payload (as produced by `analyze`), calls the chosen reasoning provider once per report, and writes back only `recommendations` / `team_recommendations` — `signals`, `derived_metrics`, and `team_metrics` are untouched, since those are already final. `--provider` defaults to `ollama`; `--url` defaults to `http://localhost:11434`. `--context` carries team-specific process facts (e.g. how a team's backlog actually works) the model can't infer from signals alone.

### Model Discovery

```text
teamgauge models [--provider ollama|claude] [--url <ollama-url>]
```

Lists what's actually available from a provider — Ollama via its own `GET /api/tags` (the same endpoint `ollama list` uses), Claude via the Anthropic Models API — rather than requiring the user to know a model name in advance. The UI's model field is a live-populated dropdown (`GET /api/models`), refreshed on provider/URL change, not a free-text field.

### Team Profile & History Commands

```text
teamgauge setup [--db <path>]
teamgauge team list|show|create|set-role [...] [--db <path>]
teamgauge analyze --input <file|url> --team <name> --sprint <label> [--date <date>] [--sprint-start <date>] [--force] [--db <path>]
teamgauge history --team <name> [--sprint <label>] [--db <path>]
teamgauge trend --team <name> [--sprint <label>] [--db <path>] [--reason --provider ollama|claude --url <ollama-url> --model <name> --context <text>]
teamgauge reason --team <name> --sprint <label> [--snapshot-date <date>] [...]
```

See claude.md's "Persistence Layer" section for the full contract. In short: `setup`/`team` manage a saved profile (roster with dated role history, sprint length, charter); `analyze --team` saves a dated, append-only snapshot instead of just printing JSON; `history`/`trend` read those snapshots back (`trend` computes deterministic deltas — team-wide and per engineer — between consecutive snapshots); `reason --team` auto-enriches the prompt with the profile's charter, sprint-position, and roster notes instead of requiring `--context` every time. All of this is additive — every command still works exactly as before without `--team`, with zero persistence.

`trend --reason` additionally runs the cumulative reasoning pass (see "6. Reasoning Layer" above) over the whole trend and merges it into the same JSON output — a distinct, freestanding `{ summary, recommendations, concerning_trends }`, not a fill-in of any single snapshot's fields. `POST /api/trend-reason` is the server equivalent, returning `{ trend, cumulative }`.

---

## UI Design

### Features

- Upload JSON/CSV, enter a URL, or enter a JQL query — the UI auto-detects which from the input itself (file content/extension, or `http(s)://` prefix), no explicit source-type selector required
- Manual input form
- Optional roster upload (name → free-form role)
- Visualize signals
- Visualize derived metrics
- Visualize recommendations
- Trigger the reasoning step ("Generate Recommendations": provider, URL, model, optional team context) and display the result — the model call happens server-side, never in the browser
- Download JSON
- Switch between teams when a payload contains more than one report
- Create/edit a saved team profile and its dated roster (Team Setup panel), and analyze against a saved team — pulling its roster automatically and saving the run to history, with a non-blocking notice (not a silent failure, and not a blocked view) if the exact snapshot already exists
- Browse saved history and trend deltas for a saved team, and trigger the cumulative reasoning pass over that whole trend (History & Trends panel)
- Render every reasoning-provider free-text field as markdown (bold, lists, headings, inline code), not raw text with literal asterisks/hashes

### Components

- Team Setup panel: team picker, profile fields (name/sprint length/charter), read-only roster overview (mark-as-departed/reactivate only — no add/edit-role form; role/weight/notes are edited on the engineer card in an analyzed report instead, which is the roster's only feeder)
- History & Trends panel: team/sprint selector, saved-snapshots table, team-wide and per-engineer trend-delta tables (colored by whether each metric's direction is actually good or bad, not by raw arrow direction), and an Accumulated Report sub-form that triggers the cumulative reasoning pass and renders `{ summary, recommendations, concerning_trends }`
- Input panel, with a "Use saved team" selector that swaps manual team-name/roster-upload for a saved profile
- Team selector (hidden when `reports` has a single entry)
- Team metrics table (velocity, closeout counts/times — per engineer and team-wide; populated immediately from `analyze`, no reasoning step required to see it)
- Signal dashboard
- Engineer cards
- Team summary
- JSON viewer
- Collision notice (shown when `POST /api/analyze` reports `collision: true` — the report itself still renders normally; the notice only offers a "Save as new snapshot" action for recording a new history entry)

---

## Extensibility

Future providers:

- Zendesk
- Asana
- Linear
- Productboard
- Salesforce
- Slack
- Calendar systems

All must output normalized signals.

---

## Planned (Future Phase — not yet built)

Multi-sprint trend analysis (previously listed here) is now built — see "7. Persistence Layer" and the "Team Profile & History Commands" section above. `history`/`trend` browsing and the cumulative reasoning pass are now in the UI too (see "UI Design" above) — nothing in this system is CLI-only anymore.

- **PTO/reduced-capacity notes**, **sprint goal/commitment tracking**, **on-call rotation flags**, and **cross-team dependency notes** — see claude.md's "Deferred to a future phase" list for the shape of each; all are cheap additions to the snapshot/roster schema once there's a concrete need.

---

## Non-Goals

- No reasoning inside ingestion, normalization, or aggregation (layers 1-5) — reasoning is confined to the explicit, separate layer 6
- No agent-specific output formats
- No hard dependency on GitHub
- No hard dependency on any single LLM vendor — Ollama is the default reasoning provider precisely to avoid this; Claude is an alternate, not a replacement requirement

---

## Summary

TeamGauge is a universal workload signal engine with a built-in reasoning step:

- flexible ingestion
- unified normalization
- CLI + UI interfaces
- a pluggable reasoning layer (local Ollama by default, Claude as an alternative) that turns signals into recommendations
- the normalized JSON remains usable by any external LLM/agent that skips the built-in reasoning step entirely

This design ensures TeamGauge works for engineering, PMO, product, support, and leadership.
