# TeamGauge

A workload intelligence system. It ingests signals from Jira (and other sources), normalizes them into a deterministic JSON schema, and runs a separate reasoning step — local Ollama by default, Claude as an alternate — to turn those signals into concrete, named recommendations. Ships as both a CLI and a web UI backed by a local SQLite store.

## Features

### Ingestion
- **Jira provider** — JSON export, live URL, or JQL query.
- **CSV provider** — Jira CSV exports, including multi-column `Sprint` history (correctly resolves to each issue's *current* sprint, not its oldest).
- Auto-detects file type (JSON vs CSV) and input type (URL vs JQL) from the content itself — no source-type selector needed.
- **Team name / sprint auto-detection**, but only on unanimous agreement across every issue in the source — never a majority guess. Falls back to asking only when detection genuinely can't resolve it.
- **Multi-team config file** — analyze several teams from different sources in one run, producing one JSON payload with a report per team.
- Optional roster file (name → role, or name → `{ role, weight }`) to enrich engineers with team-specific labels and load-capacity weighting.

### Normalization
- Deterministic signal computation — work items, cycle time, blocked items, priority pressure, context-switching index, unplanned-work ratio — with zero interpretation baked in.
- Derived metrics: load score (weight-adjusted), burnout risk, resolved count, velocity (story points when available).
- Team-wide metrics (total work items, total resolved, team velocity, average cycle time), including the `Unassigned` backlog bucket's real throughput.
- Output is always a `reports` array — a single-team run is just a one-element array, never a special-cased shape.

### Reasoning (the actual point of the tool)
- A separate, explicit step turns clean signals into recommendations — ingestion never reasons.
- **Local Ollama by default** (no vendor lock-in, no API key) — **Claude as a pluggable alternate provider**.
- Live model discovery (`GET /api/models` / `teamgauge models`) — pick from what's actually installed, never type a model name from memory.
- Deterministic, code-enforced guardrail: the `Unassigned` bucket can never be named as a redistribution source or target, even if a model tries to sneak it into a sentence.
- **Cumulative reasoning over a team's full trend** — a second, distinct reasoning pass that synthesizes patterns only visible across multiple sprints (a climb, a plateau, a correlation over time), never a rehash of the latest snapshot.
- Prompts require plain, one-idea-per-sentence writing — comparative and specific, but never several statistics stacked into one dense clause.
- Model output renders as real formatted text in the UI (bold, lists, headings) instead of raw markdown syntax, styled like actual content rather than a muted placeholder hint.

### Persistence
- Local SQLite file, zero server process required (`./teamgauge.db` by default).
- **Saved team profiles** — name, sprint length, charter — so you don't retype a team's makeup on every run.
- **Versioned roster history** — a role or weight change is a new dated fact, never an overwrite; a past snapshot always shows the role that was true when it was taken.
- **Departure tracking** — marking someone departed is a dated fact too, not a deletion; past snapshots stay accurate, and reactivating is just a normal new entry.
- **Append-only sprint snapshots** — re-analyzing a sprint (including a manager updating it mid-sprint) always adds a new dated data point; nothing is silently overwritten.
- Exact-collision duplicate guard — re-importing the same team+sprint+date doesn't silently create a confusing near-duplicate, but never blocks you from seeing current numbers either.

### CLI
```
teamgauge ingest --json|--csv|--url|--jql <source>
teamgauge analyze --input <file|url> [--roster <file>] [--config <file>]
teamgauge reason --input <file> [--provider ollama|claude] [--context <text>]
teamgauge models [--provider ollama|claude]
teamgauge setup                                  # interactive team questionnaire
teamgauge team list|show|create|set-role|depart
teamgauge analyze --team <name> --sprint <label> # saves a dated snapshot
teamgauge history --team <name>
teamgauge trend --team <name> [--reason]         # deltas, or the cumulative reasoning pass
```
CLI output is always pure JSON — safe to pipe into another tool.

### Web UI
- **Team Setup** — create/edit team profiles; a read-only roster overview (configured / seen-but-unconfigured / departed).
- **The analyzed report is the roster's one editing surface** — role, weight, and work-pattern notes are set directly on each engineer's card, with an explicit save button (no silent auto-save, no separate "add person" form).
- **History & Trends** — browse every saved snapshot for a team, see team-wide and per-engineer deltas (colored by whether the direction is actually good or bad for that metric, not by raw arrow direction), and generate the cumulative/accumulated report on demand.
- Live-populated model dropdowns, non-blocking duplicate-snapshot notices, team switcher for multi-team payloads, and a raw-JSON viewer with one-click download.

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com) running locally for the default reasoning provider (optional — Claude works without it via `ANTHROPIC_API_KEY`)

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# CLI (ad hoc, stateless)
npm run dev -- analyze --input ./export.json --roster ./roster.json > report.json
npm run dev -- reason --input report.json --provider ollama

# Web UI + API server
npm run server
# open http://localhost:4000
```

## Configuration

- `TEAMGAUGE_DB` (or `--db <path>`) — SQLite file location. Defaults to `./teamgauge.db`.
- `ANTHROPIC_API_KEY` — required only when using `--provider claude`.

Both the CLI and the server load a `.env` file automatically (`cp .env.example .env` to get started). `.env` is gitignored — never commit real keys.

See `claude.md` and `design.md` for the full working specification and architecture.
