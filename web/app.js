// ---- Tabs ----
// Purely a top-level visibility switch between the three page sections —
// independent of every other `hidden`/class toggle already in this file,
// which all operate on elements nested inside whichever tab is showing.
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPages = document.querySelectorAll(".tab-page");
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    tabButtons.forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-selected", String(b === btn));
    });
    tabPages.forEach((page) => {
      page.hidden = page.dataset.tab !== target;
    });
  });
});

const form = document.getElementById("analyze-form");
const multiTeamToggle = document.getElementById("multiTeamToggle");
const singleTeamFields = document.getElementById("single-team-fields");
const configField = document.getElementById("field-config");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const teamSelectorWrap = document.getElementById("team-selector-wrap");
const teamSelector = document.getElementById("team-selector");
const jsonOutput = document.getElementById("json-output");
const downloadBtn = document.getElementById("download-json");
const reasonForm = document.getElementById("reason-form");
const reasonProvider = document.getElementById("reasonProvider");
const reasonUrlField = document.getElementById("reason-url-field");
const reasonUrlInput = document.getElementById("reasonUrl");
const reasonModelSelect = document.getElementById("reasonModel");
const refreshModelsBtn = document.getElementById("refreshModels");
const reasonStatusEl = document.getElementById("reason-status");

let currentPayload = null;
let currentTeamIndex = 0;
let currentRosterNotes = {}; // standing roster fact, same regardless of which report/sprint is showing
// Per-report state below — indexed by the same teamIndex as currentPayload.reports,
// since a multi-sprint auto-split (see CSVProvider.ingestGroupedBySprint) can
// save several sprints from one saved-team analyze, each on ITS OWN date
// (that sprint's own last-activity date, not necessarily "today"). A single
// shared date/context here would silently misattribute a card edit on report
// N to report 0's date — the exact class of bug already fixed once for the
// single-report case.
let currentSnapshotDates = [];
let currentEngineerContextByIndex = [];
let currentSnapshotMetaByIndex = [];

function currentSnapshotDateFor(teamIndex) {
  return currentSnapshotDates[teamIndex] ?? null;
}

// ---- Team Setup ----

const setupTeamSelect = document.getElementById("setupTeamSelect");
const setupTeamName = document.getElementById("setupTeamName");
const setupSprintLength = document.getElementById("setupSprintLength");
const setupCharter = document.getElementById("setupCharter");
const setupStatusEl = document.getElementById("setup-status");
const rosterTableWrap = document.getElementById("roster-table-wrap");
const rosterStatusEl = document.getElementById("roster-status");
const mergeSprintFrom = document.getElementById("mergeSprintFrom");
const mergeSprintTo = document.getElementById("mergeSprintTo");
const mergeSprintStatusEl = document.getElementById("merge-sprint-status");
const analyzeTeamSelect = document.getElementById("analyzeTeamSelect");
const cardSaveStatusEl = document.getElementById("card-save-status");

// The team a currently-loaded report was analyzed against, if any — role/
// weight/notes edits on an engineer card only persist to the roster when
// this is set (i.e. the report came from a saved team, not an ad hoc run).
let currentAnalyzedTeam = null;

// "Pick one under Use saved team" is only sensible advice when a team
// actually exists to pick — telling a brand-new user with zero saved teams
// to "pick one" from a dropdown that only ever shows "— none —" sent them
// looking for a control that doesn't do anything yet. analyzeTeamSelect
// always has exactly one placeholder option ("— none (ad hoc, not saved)
// —") plus one per real team, so its length is a reliable check without
// tracking separate state.
function noSavedTeamMessage() {
  const hasAnyTeam = analyzeTeamSelect.options.length > 1;
  return hasAnyTeam
    ? "Not saved — this analysis wasn't run against a saved team (pick one under \"Use saved team\" and re-analyze to persist edits)."
    : "Not saved — this analysis wasn't run against a saved team, and none exist yet. Create one in Team Setup first, then re-analyze with it selected under \"Use saved team\" to persist edits.";
}

async function loadTeams() {
  const response = await fetch("/api/teams");
  const body = await response.json();
  const names = (body.teams || []).map((t) => t.name);

  const currentSetupValue = setupTeamSelect.value;
  setupTeamSelect.innerHTML =
    `<option value="">— new team —</option>` +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (names.includes(currentSetupValue)) setupTeamSelect.value = currentSetupValue;

  const currentAnalyzeValue = analyzeTeamSelect.value;
  analyzeTeamSelect.innerHTML =
    `<option value="">— none (ad hoc, not saved) —</option>` +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (names.includes(currentAnalyzeValue)) analyzeTeamSelect.value = currentAnalyzeValue;

  const currentHistoryValue = historyTeamSelect.value;
  historyTeamSelect.innerHTML =
    `<option value="">— select a team —</option>` +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (names.includes(currentHistoryValue)) historyTeamSelect.value = currentHistoryValue;
}

// Role/weight/notes are editable directly in this table (not just on an
// engineer card in an analyzed report) — Team Setup is where a manager
// naturally goes to set these up before ever running an analysis, and
// requiring a source file just to get an editable card was pure friction
// for a fact that has nothing to do with any particular sprint. Saves use
// the exact same endpoint and epoch backdating as the engineer card
// (ROSTER_FACT_EPOCH), so both entry points are equivalent — this is just a
// second, more direct door to the same roster write.
function renderRosterTable(roster, knownEngineers, departed) {
  const configuredNames = new Set((roster || []).map((r) => r.engineer_name));
  const departedNames = new Set((departed || []).map((r) => r.engineer_name));
  const unconfigured = (knownEngineers || [])
    .filter((name) => !configuredNames.has(name) && !departedNames.has(name))
    .map((name) => ({ engineer_name: name, role: "", weight: 1, notes: "", effective_from: "", unconfigured: true }));
  const allRows = [...(roster || []), ...unconfigured];

  if (allRows.length === 0) {
    rosterTableWrap.innerHTML = `<p class="notes-placeholder">No one seen yet — run an analysis against this team first, or add someone manually below.</p>`;
    return;
  }

  const rows = allRows
    .map(
      (r) => `
        <tr class="${r.unconfigured ? "roster-unconfigured" : ""}">
          <td>${escapeHtml(r.engineer_name)}</td>
          <td><input type="text" class="roster-role-input" data-name="${escapeHtml(r.engineer_name)}" value="${escapeHtml(r.role || "")}" placeholder="${r.unconfigured ? "not yet configured" : "e.g. QA Engineer"}" /></td>
          <td><input type="number" step="0.05" min="0.05" class="roster-weight-input" data-name="${escapeHtml(r.engineer_name)}" value="${r.weight ?? 1}" /></td>
          <td><input type="text" class="roster-notes-input" data-name="${escapeHtml(r.engineer_name)}" value="${escapeHtml(r.notes || "")}" placeholder="work-pattern notes" /></td>
          <td>${escapeHtml(r.effective_from || "—")}</td>
          <td>
            <div class="roster-table-actions">
              <button type="button" class="roster-save-btn" data-name="${escapeHtml(r.engineer_name)}">Save</button>
              <button type="button" class="depart-btn" data-name="${escapeHtml(r.engineer_name)}">Mark as departed</button>
            </div>
            <p class="roster-row-status" data-name="${escapeHtml(r.engineer_name)}"></p>
          </td>
        </tr>
      `,
    )
    .join("");
  rosterTableWrap.innerHTML = `
    <table class="metrics-table">
      <thead><tr><th>Name</th><th>Role</th><th>Weight</th><th>Notes</th><th>Effective from</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderDepartedTable(departed) {
  const wrap = document.getElementById("departed-table-wrap");
  if (!departed || departed.length === 0) {
    wrap.innerHTML = `<p class="notes-placeholder">No past members.</p>`;
    return;
  }
  const rows = departed
    .map(
      (r) => `
        <tr>
          <td>${escapeHtml(r.engineer_name)}</td>
          <td>${escapeHtml(r.effective_from)}</td>
          <td><button type="button" class="reactivate-btn" data-name="${escapeHtml(r.engineer_name)}">Reactivate…</button></td>
        </tr>
      `,
    )
    .join("");
  wrap.innerHTML = `
    <table class="metrics-table">
      <thead><tr><th>Name</th><th>Departed since</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMergeSprintSelects(knownSprints) {
  const options = knownSprints.length
    ? knownSprints.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")
    : `<option value="">— no saved sprints for this team yet —</option>`;
  mergeSprintFrom.innerHTML = options;
  mergeSprintTo.innerHTML = options;
}

async function loadTeamProfile(name) {
  if (!name) {
    setupTeamName.value = "";
    setupSprintLength.value = "";
    setupCharter.value = "";
    renderRosterTable([], [], []);
    renderDepartedTable([]);
    renderMergeSprintSelects([]);
    return;
  }
  const response = await fetch(`/api/teams/profile?team=${encodeURIComponent(name)}`);
  const body = await response.json();
  if (!response.ok) {
    setupStatusEl.textContent = body.error || "failed to load team";
    setupStatusEl.classList.add("error");
    return;
  }
  setupTeamName.value = body.profile.name;
  setupSprintLength.value = body.profile.sprint_length_days ?? "";
  setupCharter.value = body.profile.charter ?? "";
  renderRosterTable(body.roster, body.knownEngineers, body.departed);
  renderDepartedTable(body.departed);
  renderMergeSprintSelects(body.knownSprints || []);
}

document.getElementById("mergeSprintBtn").addEventListener("click", async () => {
  const team = setupTeamSelect.value;
  const from = mergeSprintFrom.value;
  const to = mergeSprintTo.value;

  mergeSprintStatusEl.classList.remove("error");

  if (!team) {
    mergeSprintStatusEl.textContent = "Select a team above first.";
    mergeSprintStatusEl.classList.add("error");
    return;
  }
  if (!from || !to) {
    mergeSprintStatusEl.textContent = "Pick both a \"from\" and a \"to\" sprint.";
    mergeSprintStatusEl.classList.add("error");
    return;
  }
  if (from === to) {
    mergeSprintStatusEl.textContent = "\"From\" and \"to\" are the same sprint — nothing to merge.";
    mergeSprintStatusEl.classList.add("error");
    return;
  }
  if (!confirm(`Rename every snapshot for "${team}" currently labeled "${from}" to "${to}"? This cannot be undone from the UI.`)) return;

  mergeSprintStatusEl.textContent = "Merging…";

  try {
    const response = await fetch("/api/snapshots/rename-sprint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team, from, to }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "merge failed");

    mergeSprintStatusEl.textContent = `✓ Merged — ${body.snapshots_renamed} snapshot(s) renamed from "${from}" to "${to}".`;
    await loadTeamProfile(team);
  } catch (error) {
    mergeSprintStatusEl.textContent = error.message;
    mergeSprintStatusEl.classList.add("error");
  }
});

document.getElementById("showPastMembers").addEventListener("change", (event) => {
  document.getElementById("departed-table-wrap").hidden = !event.target.checked;
});

rosterTableWrap.addEventListener("click", async (event) => {
  if (event.target.classList.contains("roster-save-btn")) {
    const name = event.target.dataset.name;
    const team = setupTeamName.value;
    const rowStatusEl = rosterTableWrap.querySelector(`.roster-row-status[data-name="${name}"]`);
    if (!team) {
      rowStatusEl.textContent = "Select or create a team above first.";
      rowStatusEl.classList.add("error");
      return;
    }

    const role = rosterTableWrap.querySelector(`.roster-role-input[data-name="${name}"]`).value;
    const weight = Number(rosterTableWrap.querySelector(`.roster-weight-input[data-name="${name}"]`).value) || 1;
    const notes = rosterTableWrap.querySelector(`.roster-notes-input[data-name="${name}"]`).value;

    rowStatusEl.textContent = "Saving…";
    rowStatusEl.classList.remove("error");
    try {
      const response = await fetch("/api/teams/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team, engineerName: name, role, weight, notes: notes || undefined, effectiveFrom: ROSTER_FACT_EPOCH }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "save failed");
      // loadTeamProfile re-renders the whole table (effective_from, and a
      // previously-unconfigured row now moving into the configured group,
      // both need fresh data) — which replaces rowStatusEl along with
      // everything else, so the success message has to be set on the NEW
      // element after reload, not the one that just got thrown away.
      await loadTeamProfile(team);
      const freshStatusEl = rosterTableWrap.querySelector(`.roster-row-status[data-name="${name}"]`);
      if (freshStatusEl) freshStatusEl.textContent = "✓ Saved — applies to every sprint for this team, past and future.";
    } catch (error) {
      rowStatusEl.textContent = error.message;
      rowStatusEl.classList.add("error");
    }
    return;
  }

  if (!event.target.classList.contains("depart-btn")) return;
  const name = event.target.dataset.name;
  if (!setupTeamName.value) return;
  if (!confirm(`Mark ${name} as departed as of today? This doesn't change any past reports — it just hides them from the current roster going forward. You can reactivate them later.`)) return;

  rosterStatusEl.classList.remove("error");
  try {
    const response = await fetch("/api/teams/roster/depart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: setupTeamName.value, engineerName: name }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "failed");
    rosterStatusEl.textContent = `Marked ${name} as departed.`;
    await loadTeamProfile(setupTeamName.value);
  } catch (error) {
    rosterStatusEl.textContent = error.message;
    rosterStatusEl.classList.add("error");
  }
});

document.getElementById("departed-table-wrap").addEventListener("click", async (event) => {
  if (!event.target.classList.contains("reactivate-btn")) return;
  const name = event.target.dataset.name;

  // Reactivating is just a normal (non-departed) roster entry — role/weight
  // get (re)set on their engineer card next time they show up in an
  // analyzed report, same as everyone else. This just clears the departure.
  rosterStatusEl.classList.remove("error");
  try {
    const response = await fetch("/api/teams/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team: setupTeamName.value, engineerName: name, role: "" }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "failed");
    rosterStatusEl.textContent = `Reactivated ${name} — set their role on their card next time they appear in an analyzed report.`;
    await loadTeamProfile(setupTeamName.value);
  } catch (error) {
    rosterStatusEl.textContent = error.message;
    rosterStatusEl.classList.add("error");
  }
});

// Convenience only, never a redirect: picking a team in Team Setup pre-fills
// "Use saved team" in the Input panel, but only while that selector is still
// on its default — an explicit choice there is never overridden just because
// you're browsing a different team's profile in Team Setup.
function syncAnalyzeTeamSelection(teamName) {
  if (teamName && !analyzeTeamSelect.value) {
    analyzeTeamSelect.value = teamName;
    updateAnalyzeTeamFields();
  }
}

setupTeamSelect.addEventListener("change", () => {
  loadTeamProfile(setupTeamSelect.value);
  syncAnalyzeTeamSelection(setupTeamSelect.value);
});

document.getElementById("team-setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setupStatusEl.classList.remove("error");
  setupStatusEl.textContent = "Saving…";

  try {
    const response = await fetch("/api/teams/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: setupTeamName.value,
        sprintLengthDays: setupSprintLength.value ? Number(setupSprintLength.value) : null,
        charter: setupCharter.value || null,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "save failed");

    setupStatusEl.textContent = `Saved "${setupTeamName.value}".`;
    await loadTeams();
    setupTeamSelect.value = setupTeamName.value;
    syncAnalyzeTeamSelection(setupTeamName.value);
    await loadTeamProfile(setupTeamName.value);
  } catch (error) {
    setupStatusEl.textContent = error.message;
    setupStatusEl.classList.add("error");
  }
});

document.getElementById("refreshTeams").addEventListener("click", loadTeams);

// ---- History & Trends ----

const historyTeamSelect = document.getElementById("historyTeamSelect");
const historySprintFilter = document.getElementById("historySprintFilter");
const historyStatusEl = document.getElementById("history-status");
const historyContentEl = document.getElementById("history-content");
const cumulativeProvider = document.getElementById("cumulativeProvider");
const cumulativeUrlField = document.getElementById("cumulative-url-field");
const cumulativeUrl = document.getElementById("cumulativeUrl");
const cumulativeModel = document.getElementById("cumulativeModel");
const cumulativeStatusEl = document.getElementById("cumulative-status");

// Color reflects whether the change is good or bad for that specific metric —
// not the arrow direction. Velocity/resolved: higher is better. Load
// score/cycle time: lower is better. Arrow direction always follows the
// actual sign, independent of the color.
function deltaClass(value, higherIsBetter) {
  const sentiment = higherIsBetter ? value : -value;
  if (sentiment > 0) return "delta-good";
  if (sentiment < 0) return "delta-bad";
  return "delta-flat";
}

function deltaArrow(value) {
  if (value > 0) return "▲";
  if (value < 0) return "▼";
  return "–";
}

// Cached so a Snapshots row click can look up that row's full history entry
// (engineers, existing recommendations) without a second fetch — /api/history
// already returned everything the Sprint Report panel needs.
let currentHistoryRows = [];

function renderHistorySnapshots(history) {
  currentHistoryRows = history;
  const rows = history
    .map(
      (h) => `
        <tr class="snapshot-row" data-sprint="${escapeHtml(h.sprint)}" data-date="${escapeHtml(h.snapshot_date)}">
          <td>${escapeHtml(h.snapshot_date)}</td>
          <td>${escapeHtml(h.sprint)}</td>
          <td>${h.team_velocity}</td>
          <td>${h.total_resolved} / ${h.total_work_items}</td>
          <td>${h.team_avg_cycle_time_hours.toFixed(1)}</td>
          <td>${h.team_recommendations_notes || h.engineer_recommendations.length ? '<span class="recommendation-badge">yes</span>' : "—"}</td>
          <td><button type="button" class="delete-snapshot-btn" data-sprint="${escapeHtml(h.sprint)}" data-date="${escapeHtml(h.snapshot_date)}">Delete</button></td>
        </tr>
      `,
    )
    .join("");
  document.getElementById("history-snapshots-wrap").innerHTML = `
    <table class="metrics-table">
      <thead><tr><th>Date</th><th>Sprint</th><th>Velocity</th><th>Resolved / Total</th><th>Avg cycle time (h)</th><th>Recommendations?</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Three small single-line charts (one per team-wide metric already in the
// Snapshots table above) rather than one combined chart — velocity (story
// points), resolved count (items), and cycle time (hours) are different
// units/scales, and the dataviz skill's "never dual-axis" rule means that's
// three charts, not one with two y-axes.
function renderHistoryCharts(history) {
  const wrap = document.getElementById("history-charts-wrap");
  wrap.innerHTML = `
    <div class="chart-card"><h3>Velocity</h3><div id="chart-velocity"></div></div>
    <div class="chart-card"><h3>Resolved items</h3><div id="chart-resolved"></div></div>
    <div class="chart-card"><h3>Avg cycle time (h)</h3><div id="chart-cycletime"></div></div>
  `;
  const sorted = [...history].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  renderTrendLineChart(
    document.getElementById("chart-velocity"),
    sorted.map((h) => ({ date: h.snapshot_date, sprint: h.sprint, value: h.team_velocity })),
    { formatValue: (v) => v.toFixed(0) },
  );
  renderTrendLineChart(
    document.getElementById("chart-resolved"),
    sorted.map((h) => ({ date: h.snapshot_date, sprint: h.sprint, value: h.total_resolved })),
    { formatValue: (v) => v.toFixed(0) },
  );
  renderTrendLineChart(
    document.getElementById("chart-cycletime"),
    sorted.map((h) => ({ date: h.snapshot_date, sprint: h.sprint, value: h.team_avg_cycle_time_hours })),
    { formatValue: (v) => v.toFixed(0) },
  );
}

// Same rule as isMeaningfulPair in src/normalization/trend.ts (kept in sync
// by hand — one's a chart concern, the other a delta-math concern, but the
// underlying judgment is identical): a line between two points implies "this
// is what changed, in this order, over this time" — true when real time
// elapsed (dates differ) or it's the same sprint re-checked same-day, false
// when it's two DIFFERENT sprints that only look adjacent because a
// multi-sprint CSV import (see CSVProvider.ingestGroupedBySprint) happened
// to save them under the same import date. That pair gets a gap, not a
// line — connecting them read as a real same-day collapse in exactly the
// case that prompted this (a real user screenshot: two unrelated sprints,
// same date, joined by a steep declining line).
function isMeaningfulPair(prev, point) {
  return prev.date !== point.date || prev.sprint === point.sprint;
}

// Delegated onto the stable wrapper (its innerHTML is replaced on every
// render, but the wrapper element itself isn't) so this is wired up once,
// not re-bound per render. Deletion is the one deliberate escape hatch out
// of "append-only" (see deleteSnapshot in src/db/snapshots.ts) — confirmed
// here the same way "Merge Sprint Labels" confirms, since there's no undo.
document.getElementById("history-snapshots-wrap").addEventListener("click", async (event) => {
  const btn = event.target.closest(".delete-snapshot-btn");
  if (!btn) return;
  const team = historyTeamSelect.value;
  const sprint = btn.dataset.sprint;
  const snapshotDate = btn.dataset.date;
  if (!confirm(`Permanently delete the "${sprint}" snapshot from ${snapshotDate} for "${team}"? This cannot be undone.`)) return;

  historyStatusEl.textContent = "Deleting…";
  historyStatusEl.classList.remove("error");
  try {
    const res = await fetch("/api/snapshots/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team, sprint, snapshotDate }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Delete failed");
    historyStatusEl.textContent = `✓ Deleted snapshot id ${body.deletedSnapshotId}.`;
    document.getElementById("sprint-report-wrap").hidden = true;
    await loadHistory();
  } catch (error) {
    historyStatusEl.textContent = error.message;
    historyStatusEl.classList.add("error");
  }
});

// Renders the read-only "who worked this sprint" list plus whatever
// recommendations already exist (from the lightweight /api/history entry —
// no extra fetch needed to show this much). The full report only gets
// fetched once "Generate Sprint Report" is actually clicked.
function renderSprintReportPanel(row) {
  const wrap = document.getElementById("sprint-report-wrap");
  const content = document.getElementById("sprint-report-content");
  wrap.hidden = false;

  const engineerRows = (row.engineers || [])
    .filter((e) => e.name !== "Unassigned")
    .map((e) => `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.role || "—")}</td></tr>`)
    .join("");

  const existingRecommendations =
    row.team_recommendations_notes || row.engineer_recommendations.length
      ? `
        <div class="cumulative-report">
          ${row.team_recommendations_notes ? `<div><h4>Team notes</h4><div class="reasoning-output">${formatMessage(row.team_recommendations_notes)}</div></div>` : ""}
          ${
            row.engineer_recommendations.length
              ? `<div><h4>Engineer notes</h4><ul>${row.engineer_recommendations.map((e) => `<li><strong>${escapeHtml(e.name)}:</strong> ${formatMessage(e.notes)}</li>`).join("")}</ul></div>`
              : ""
          }
        </div>
      `
      : `<p class="notes-placeholder">No recommendations saved for this snapshot yet.</p>`;

  content.innerHTML = `
    <p class="chart-subtitle"><strong>${escapeHtml(row.sprint)}</strong> — ${escapeHtml(row.snapshot_date)}</p>
    <table class="metrics-table">
      <thead><tr><th>Engineer</th><th>Role</th></tr></thead>
      <tbody>${engineerRows || '<tr><td colspan="2">No engineers on this snapshot.</td></tr>'}</tbody>
    </table>
    <h4>Recommendations</h4>
    ${existingRecommendations}
    <button type="button" id="generate-sprint-report-btn" data-sprint="${escapeHtml(row.sprint)}" data-date="${escapeHtml(row.snapshot_date)}">
      ${row.team_recommendations_notes || row.engineer_recommendations.length ? "Regenerate Sprint Report" : "Generate Sprint Report"}
    </button>
    <p id="sprint-report-status" role="status"></p>
  `;
}

// Delegated the same way as the delete button — row selection and delete
// share one table, so this ignores clicks that landed on the delete button
// (which has its own listener above) rather than treating them as a select.
document.getElementById("history-snapshots-wrap").addEventListener("click", (event) => {
  if (event.target.closest(".delete-snapshot-btn")) return;
  const row = event.target.closest(".snapshot-row");
  if (!row) return;

  document.querySelectorAll(".snapshot-row.selected").forEach((r) => r.classList.remove("selected"));
  row.classList.add("selected");

  const sprint = row.dataset.sprint;
  const snapshotDate = row.dataset.date;
  const match = currentHistoryRows.find((h) => h.sprint === sprint && h.snapshot_date === snapshotDate);
  if (match) renderSprintReportPanel(match);
});

// Delegated onto the panel's stable wrapper — the "Generate Sprint Report"
// button is recreated every renderSprintReportPanel call, same reasoning
// as every other delegated listener in this file.
document.getElementById("sprint-report-content").addEventListener("click", async (event) => {
  const btn = event.target.closest("#generate-sprint-report-btn");
  if (!btn) return;
  const team = historyTeamSelect.value;
  const sprint = btn.dataset.sprint;
  const snapshotDate = btn.dataset.date;
  const statusEl = document.getElementById("sprint-report-status");

  btn.disabled = true;
  statusEl.textContent = "Generating — this reasons over this one saved snapshot, may take a while…";
  statusEl.classList.remove("error");

  try {
    const response = await fetch("/api/snapshot-reason", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team,
        sprint,
        snapshotDate,
        provider: cumulativeProvider.value,
        url: cumulativeUrl.value,
        model: cumulativeModel.value || undefined,
        context: document.getElementById("cumulativeContext").value || undefined,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "request failed");

    // The server already saved this back into the snapshot (matching the
    // CLI's `reason --team` behavior — a second run replaces the first's
    // recommendations, not versioned), so a plain history reload picks up
    // the fresh "Recommendations?" badge and re-selects this same row.
    await loadHistory();
    const refreshed = currentHistoryRows.find((h) => h.sprint === sprint && h.snapshot_date === snapshotDate);
    if (refreshed) {
      renderSprintReportPanel(refreshed);
      const row = document.querySelector(`.snapshot-row[data-sprint="${CSS.escape(sprint)}"][data-date="${CSS.escape(snapshotDate)}"]`);
      if (row) row.classList.add("selected");
    }
    document.getElementById("sprint-report-status").textContent = "✓ Sprint report generated and saved.";
  } catch (error) {
    statusEl.textContent = error.message;
    statusEl.classList.add("error");
    btn.disabled = false;
  }
});

// Shared shape between the team-wide Accumulated Report and a per-person
// one (see renderPersonReportRow below) — same {summary, recommendations,
// concerning_trends} schema either way (CumulativeReportOutputSchema),
// just scoped to different data server-side, so the same markup fits both.
function renderCumulativeReportHtml(cumulative) {
  return `
    <div class="cumulative-report">
      <div>
        <h4>Summary</h4>
        <div class="reasoning-output">${formatMessage(cumulative.summary)}</div>
      </div>
      <div>
        <h4>Recommendations</h4>
        <ul>${cumulative.recommendations.map((r) => `<li>${formatMessage(r)}</li>`).join("") || "<li>None.</li>"}</ul>
      </div>
      <div>
        <h4>Concerning Trends</h4>
        <ul class="concerning-trends">${cumulative.concerning_trends.map((t) => `<li>${formatMessage(t)}</li>`).join("") || "<li>None identified.</li>"}</ul>
      </div>
    </div>
  `;
}

// Cached so a per-person "Generate Report" click can re-render the Per
// Engineer table (to insert that person's result) without re-fetching
// /api/trend — the team/sprint filter hasn't changed, only new reasoning
// output arrived. Reset whenever the team/sprint selection changes (see
// loadHistory) so a stale result never survives into a different context.
let currentTrendData = null;
let personCumulativeResults = {};

function renderHistoryTrend(trend) {
  currentTrendData = trend;
  const wrap = document.getElementById("history-trend-wrap");
  // Two different messages for what looks like the same "empty" state:
  // truly one snapshot vs. two-or-more that just don't form a comparable
  // pair (see isMeaningfulPair) — several sprints saved under one shared
  // import date (a multi-sprint CSV split) are each real data, just not
  // orderable relative to each other. trend.deltas.length alone can't tell
  // these apart once the meaningful-pair filter can legitimately produce
  // zero deltas with 2+ snapshots present — conflating them here previously
  // told a user with two real saved snapshots "only one saved so far,"
  // which is simply false and was confusing enough to ask about directly.
  if (trend.points.length < 2) {
    wrap.innerHTML = `<p class="notes-placeholder">Need at least two snapshots to compute a trend — only one saved so far.</p>`;
    return;
  }
  if (trend.deltas.length === 0) {
    wrap.innerHTML = `<p class="notes-placeholder">${trend.points.length} snapshots saved, but none are comparable to each other — they're all different sprints saved under the same date (e.g. from one multi-sprint import), so there's no meaningful before/after between them. A trend appears once two snapshots either share a sprint or land on different dates.</p>`;
    return;
  }

  // Cross-sprint history (no sprint filter) deliberately compares different
  // sprints when they're genuinely sequential in time — but with only dates
  // shown, a reader has no way to tell that apart from a meaningless jump
  // (e.g. a bulk historical import gives sprint 16/17 dates that don't sort
  // between 15 and 18, so "date A → date B" silently skips two sprints).
  // Always naming both sprints makes a cross-sprint row visually distinct
  // from a same-sprint progression instead of reading as an unexplained
  // near-duplicate of the row before it.
  function formatPeriod(d) {
    if (d.from_sprint === d.to_sprint) {
      return `<strong>${escapeHtml(d.from_sprint)}</strong><br>${escapeHtml(d.from_date)} → ${escapeHtml(d.to_date)}`;
    }
    return `<strong>${escapeHtml(d.from_sprint)} → ${escapeHtml(d.to_sprint)}</strong><br>${escapeHtml(d.from_date)} → ${escapeHtml(d.to_date)}`;
  }

  const teamRows = trend.deltas
    .map(
      (d) => `
        <tr>
          <td>${formatPeriod(d)}</td>
          <td class="${deltaClass(d.velocity_delta, true)}">${deltaArrow(d.velocity_delta)} ${d.velocity_delta}</td>
          <td class="${deltaClass(d.resolved_count_delta, true)}">${deltaArrow(d.resolved_count_delta)} ${d.resolved_count_delta}</td>
          <td class="${deltaClass(d.cycle_time_hours_delta, false)}">${deltaArrow(d.cycle_time_hours_delta)} ${d.cycle_time_hours_delta.toFixed(1)}</td>
        </tr>
      `,
    )
    .join("");

  // One row per TRANSITION, not per engineer — an engineer with 3 snapshots
  // genuinely has 2 rows here. Nothing distinguished "this name repeats
  // because they have multiple real transitions" from "these are duplicate
  // rows," which is exactly why it read as duplicate noise. rowspan groups
  // every transition for one engineer under a single name cell instead of
  // repeating it on every row, so the structure (one person, several
  // periods) is visible instead of implied.
  const engineerRows = trend.engineers
    .filter((e) => e.deltas.length > 0)
    .flatMap((e) => {
      // "Unassigned" is a backlog bucket, not a person — no individual
      // trajectory to report on (the server rejects it too; this just
      // avoids offering a button that would only ever error).
      const canReport = e.name !== "Unassigned";
      const nameCell = `
        <td rowspan="${e.deltas.length}">
          ${escapeHtml(e.name)}
          ${
            canReport
              ? `<button type="button" class="person-report-btn" data-engineer="${escapeHtml(e.name)}">Generate Report</button>
                 <p class="person-report-status" data-engineer="${escapeHtml(e.name)}"></p>`
              : ""
          }
        </td>
      `;
      const rows = e.deltas.map(
        (d, i) => `
          <tr>
            ${i === 0 ? nameCell : ""}
            <td>${formatPeriod(d)}</td>
            <td class="${deltaClass(d.load_score_delta, false)}">${deltaArrow(d.load_score_delta)} ${d.load_score_delta}</td>
            <td class="${deltaClass(d.velocity_delta, true)}">${deltaArrow(d.velocity_delta)} ${d.velocity_delta}</td>
            <td class="${deltaClass(d.cycle_time_hours_delta, false)}">${deltaArrow(d.cycle_time_hours_delta)} ${d.cycle_time_hours_delta.toFixed(1)}</td>
          </tr>
        `,
      );
      const result = personCumulativeResults[e.name];
      if (result) {
        rows.push(`
          <tr>
            <td colspan="5" class="person-report-result">
              <strong>Accumulated report for ${escapeHtml(e.name)}</strong>
              ${renderCumulativeReportHtml(result)}
            </td>
          </tr>
        `);
      }
      return rows;
    })
    .join("");

  wrap.innerHTML = `
    <p class="notes-placeholder">Coloring: red = worse direction (load/cycle time up, or velocity/resolved down), green = better. Neutral gray = no change.</p>
    <h4>Team</h4>
    <table class="metrics-table">
      <thead><tr><th>Period</th><th>Velocity Δ</th><th>Resolved Δ</th><th>Cycle time Δ (h)</th></tr></thead>
      <tbody>${teamRows}</tbody>
    </table>
    <h4>Per Engineer</h4>
    <table class="metrics-table">
      <thead><tr><th>Engineer</th><th>Period</th><th>Load score Δ</th><th>Velocity Δ</th><th>Cycle time Δ (h)</th></tr></thead>
      <tbody>${engineerRows || '<tr><td colspan="5">No engineer has a comparable pair of snapshots in this range — either they appear in only one, or their snapshots share a date across different sprints.</td></tr>'}</tbody>
    </table>
  `;
}

async function loadHistory() {
  const team = historyTeamSelect.value;
  if (!team) {
    historyContentEl.hidden = true;
    historyStatusEl.textContent = "";
    return;
  }

  historyStatusEl.textContent = "Loading…";
  historyStatusEl.classList.remove("error");

  try {
    const sprint = historySprintFilter.value.trim();
    const params = new URLSearchParams({ team, ...(sprint ? { sprint } : {}) });

    const [historyResponse, trendResponse] = await Promise.all([
      fetch(`/api/history?${params}`),
      fetch(`/api/trend?${params}`),
    ]);
    const historyBody = await historyResponse.json();
    const trendBody = await trendResponse.json();
    if (!historyResponse.ok) throw new Error(historyBody.error || "failed to load history");
    if (!trendResponse.ok) throw new Error(trendBody.error || "failed to load trend");

    if (historyBody.history.length === 0) {
      historyContentEl.hidden = true;
      historyStatusEl.textContent = "No saved snapshots yet for this team.";
      return;
    }

    // A cached per-person result from a different team/sprint selection
    // must never survive into this one — it'd render under whichever
    // engineer happens to share a name, showing a stale, wrong report.
    personCumulativeResults = {};
    renderHistorySnapshots(historyBody.history);
    renderHistoryCharts(historyBody.history);
    renderHistoryTrend(trendBody);
    document.getElementById("cumulative-result-wrap").innerHTML = "";
    cumulativeStatusEl.textContent = "";
    historyContentEl.hidden = false;
    historyStatusEl.textContent = `${historyBody.history.length} snapshot(s) loaded.`;
  } catch (error) {
    historyStatusEl.textContent = error.message;
    historyStatusEl.classList.add("error");
  }
}

historyTeamSelect.addEventListener("change", loadHistory);
historySprintFilter.addEventListener("change", loadHistory);

// Delegated onto the stable wrapper (innerHTML replaced on every render,
// the element itself isn't) — same pattern as history-snapshots-wrap's
// delete button. Reuses the Accumulated Report form's provider/URL/model/
// context fields rather than giving every engineer their own picker, since
// it's the same underlying reasoning call just scoped to one person.
document.getElementById("history-trend-wrap").addEventListener("click", async (event) => {
  const btn = event.target.closest(".person-report-btn");
  if (!btn) return;
  const engineerName = btn.dataset.engineer;
  const team = historyTeamSelect.value;
  const sprint = historySprintFilter.value.trim();
  const statusEl = document.querySelector(`.person-report-status[data-engineer="${CSS.escape(engineerName)}"]`);

  btn.disabled = true;
  if (statusEl) {
    statusEl.textContent = "Generating…";
    statusEl.classList.remove("error");
  }

  try {
    const response = await fetch("/api/trend-reason-person", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team,
        sprint: sprint || undefined,
        engineerName,
        provider: cumulativeProvider.value,
        url: cumulativeUrl.value,
        model: cumulativeModel.value || undefined,
        context: document.getElementById("cumulativeContext").value || undefined,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "request failed");

    personCumulativeResults[engineerName] = body.cumulative;
    // Re-renders from the cached trend (no need to re-fetch /api/trend —
    // the team/sprint selection hasn't changed, only this one person's
    // reasoning result arrived) so the new result row appears immediately.
    if (currentTrendData) renderHistoryTrend(currentTrendData);
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = error.message;
      statusEl.classList.add("error");
    }
    btn.disabled = false;
  }
});

function updateCumulativeFields() {
  cumulativeUrlField.hidden = cumulativeProvider.value !== "ollama";
}

async function refreshCumulativeModels() {
  cumulativeModel.innerHTML = `<option value="">Loading…</option>`;
  try {
    const params = new URLSearchParams({ provider: cumulativeProvider.value, url: cumulativeUrl.value });
    const response = await fetch(`/api/models?${params}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "failed to list models");
    cumulativeModel.innerHTML = body.models.length
      ? body.models.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
      : `<option value="">No models found</option>`;
  } catch (error) {
    cumulativeModel.innerHTML = `<option value="">Could not load models</option>`;
  }
}

cumulativeProvider.addEventListener("change", () => {
  updateCumulativeFields();
  refreshCumulativeModels();
});
cumulativeUrl.addEventListener("change", refreshCumulativeModels);
document.getElementById("refreshCumulativeModels").addEventListener("click", refreshCumulativeModels);
updateCumulativeFields();
refreshCumulativeModels();

document.getElementById("cumulative-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const team = historyTeamSelect.value;
  if (!team) {
    cumulativeStatusEl.textContent = "Select a team above first.";
    cumulativeStatusEl.classList.add("error");
    return;
  }

  cumulativeStatusEl.textContent = "Generating accumulated report — this reasons over every saved snapshot, may take a while…";
  cumulativeStatusEl.classList.remove("error");
  document.getElementById("cumulative-result-wrap").innerHTML = "";

  try {
    const sprint = historySprintFilter.value.trim();
    const response = await fetch("/api/trend-reason", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team,
        sprint: sprint || undefined,
        provider: cumulativeProvider.value,
        url: cumulativeUrl.value,
        model: cumulativeModel.value || undefined,
        context: document.getElementById("cumulativeContext").value || undefined,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "request failed");

    const { cumulative } = body;
    document.getElementById("cumulative-result-wrap").innerHTML = renderCumulativeReportHtml(cumulative);
    cumulativeStatusEl.textContent = "Accumulated report generated.";
  } catch (error) {
    cumulativeStatusEl.textContent = error.message;
    cumulativeStatusEl.classList.add("error");
  }
});

loadTeams();

function updateReasonFields() {
  reasonUrlField.hidden = reasonProvider.value !== "ollama";
}

async function refreshModels() {
  reasonModelSelect.innerHTML = `<option value="">Loading…</option>`;
  try {
    const params = new URLSearchParams({ provider: reasonProvider.value, url: reasonUrlInput.value });
    const response = await fetch(`/api/models?${params}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "failed to list models");

    reasonModelSelect.innerHTML = body.models.length
      ? body.models.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
      : `<option value="">No models found</option>`;
  } catch (error) {
    reasonModelSelect.innerHTML = `<option value="">Could not load models</option>`;
    reasonStatusEl.textContent = error.message;
    reasonStatusEl.classList.add("error");
  }
}

reasonProvider.addEventListener("change", () => {
  updateReasonFields();
  refreshModels();
});
reasonUrlInput.addEventListener("change", refreshModels);
refreshModelsBtn.addEventListener("click", refreshModels);

updateReasonFields();
refreshModels();

function updateMode() {
  const multi = multiTeamToggle.checked;
  singleTeamFields.hidden = multi;
  configField.hidden = !multi;
}

multiTeamToggle.addEventListener("change", updateMode);
updateMode();

function localToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function updateAnalyzeTeamFields() {
  const usingSavedTeam = Boolean(analyzeTeamSelect.value);
  document.getElementById("field-roster").hidden = usingSavedTeam;
  document.getElementById("field-teamName").hidden = usingSavedTeam;
  document.getElementById("saved-team-fields").hidden = !usingSavedTeam;
  // Deliberately NOT auto-filled with today: leaving it blank lets the
  // server decide per sprint (today for a single sprint, but each sprint's
  // own latest-activity date for a multi-sprint CSV split — see
  // CSVProvider.deriveGroupDate) instead of always forcing every sprint in
  // a bulk historical import onto one arbitrary import-day date.
}

analyzeTeamSelect.addEventListener("change", updateAnalyzeTeamFields);
updateAnalyzeTeamFields();

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function burnoutClass(risk) {
  const normalized = (risk || "").toLowerCase();
  return ["low", "medium", "high"].includes(normalized) ? `burnout-${normalized}` : "burnout-low";
}

// ---- Charts ----
// Hand-built inline SVG rather than a charting library — this app has no
// build step and no other JS dependency beyond one markdown renderer, and
// these are two simple, fixed-shape charts (a status-colored bar chart, a
// single-line trend chart). Mark specs (bar thickness/rounding, 2px lines,
// >=8px end-dots, hairline gridlines, hover tooltips) follow the dataviz
// skill; colors come from the validated palette (--chart-good/warning/
// critical in styles.css) rather than the ad hoc --risk-* badge colors,
// since those aren't contrast-safe as fill colors with a label beside them.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function riskChartColor(risk) {
  const normalized = (risk || "").toLowerCase();
  if (normalized === "high") return "var(--chart-critical)";
  if (normalized === "medium") return "var(--chart-warning)";
  return "var(--chart-good)";
}

// One bar per engineer (load_score), colored by burnout_risk status, with a
// dashed team-average reference line so a single number reads as "high or
// low relative to this team" instead of a bare figure. Hover/focus on a bar
// shows the fuller picture (role, resolved/velocity, cycle time) that the
// bar alone can't carry.
function renderLoadScoreChart(container, engineers) {
  if (!engineers || engineers.length === 0) {
    container.innerHTML = `<p class="chart-empty">No engineers to chart.</p>`;
    return;
  }

  const width = 900;
  const height = 260;
  const marginTop = 28;
  const marginBottom = 46;
  const marginLeft = 8;
  const marginRight = 8;
  const plotHeight = height - marginTop - marginBottom;
  const maxLoad = Math.max(...engineers.map((e) => e.derived_metrics.load_score), 1);
  const avgLoad = engineers.reduce((sum, e) => sum + e.derived_metrics.load_score, 0) / engineers.length;

  const slot = (width - marginLeft - marginRight) / engineers.length;
  const barWidth = Math.min(24, slot * 0.55);

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Load score by engineer" });

  // Baseline
  const baselineY = marginTop + plotHeight;
  svg.appendChild(svgEl("line", { class: "chart-gridline", x1: marginLeft, x2: width - marginRight, y1: baselineY, y2: baselineY }));

  // Team-average reference line
  const avgY = baselineY - (avgLoad / maxLoad) * plotHeight;
  svg.appendChild(svgEl("line", { class: "chart-avg-line", x1: marginLeft, x2: width - marginRight, y1: avgY, y2: avgY }));
  const avgLabel = svgEl("text", { class: "chart-axis-text", x: width - marginRight, y: avgY - 5, "text-anchor": "end" });
  avgLabel.textContent = `team avg ${avgLoad.toFixed(0)}`;
  svg.appendChild(avgLabel);

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;

  engineers.forEach((engineer, i) => {
    const cx = marginLeft + slot * i + slot / 2;
    const barHeight = Math.max(2, (engineer.derived_metrics.load_score / maxLoad) * plotHeight);
    const y = baselineY - barHeight;
    const color = riskChartColor(engineer.derived_metrics.burnout_risk);

    const bar = svgEl("rect", {
      class: "chart-bar",
      x: cx - barWidth / 2,
      y,
      width: barWidth,
      height: barHeight,
      rx: 4,
      fill: color,
    });
    svg.appendChild(bar);

    const valueLabel = svgEl("text", { class: "chart-value-label", x: cx, y: y - 6, "text-anchor": "middle" });
    valueLabel.textContent = engineer.derived_metrics.load_score.toFixed(0);
    svg.appendChild(valueLabel);

    const nameLabel = svgEl("text", { class: "chart-axis-text", x: cx, y: baselineY + 16, "text-anchor": "middle" });
    const shortName = engineer.name.length > 12 ? engineer.name.slice(0, 11) + "…" : engineer.name;
    nameLabel.textContent = shortName;
    svg.appendChild(nameLabel);

    // Hit area bigger than the bar itself (interaction.md: hit target
    // bigger than the mark), covering the full column slot top-to-bottom.
    const hit = svgEl("rect", {
      class: "chart-hit-area",
      x: marginLeft + slot * i,
      y: marginTop,
      width: slot,
      height: plotHeight,
      tabindex: "0",
      role: "img",
      "aria-label": `${engineer.name}: load score ${engineer.derived_metrics.load_score.toFixed(0)}, ${engineer.derived_metrics.burnout_risk} burnout risk`,
    });

    const showTooltip = () => {
      bar.classList.add("hovered");
      tooltip.innerHTML = "";
      const title = document.createElement("strong");
      title.textContent = engineer.name;
      const body = document.createElement("div");
      body.textContent = `${engineer.role || "role unknown"} · load ${engineer.derived_metrics.load_score.toFixed(0)} (${engineer.derived_metrics.burnout_risk}) · resolved ${engineer.derived_metrics.resolved_count} · velocity ${engineer.derived_metrics.velocity} · cycle ${engineer.signals.cycle_time_hours.toFixed(0)}h`;
      tooltip.appendChild(title);
      tooltip.appendChild(body);
      tooltip.hidden = false;
      const wrapRect = container.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      tooltip.style.left = `${barRect.left - wrapRect.left + barRect.width / 2}px`;
      tooltip.style.top = `${barRect.top - wrapRect.top}px`;
    };
    const hideTooltip = () => {
      bar.classList.remove("hovered");
      tooltip.hidden = true;
    };
    hit.addEventListener("pointermove", showTooltip);
    hit.addEventListener("pointerleave", hideTooltip);
    hit.addEventListener("focus", showTooltip);
    hit.addEventListener("blur", hideTooltip);
    svg.appendChild(hit);
  });

  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML = [
    ["Low burnout risk", "var(--chart-good)"],
    ["Medium", "var(--chart-warning)"],
    ["High", "var(--chart-critical)"],
  ]
    .map(([label, color]) => `<span class="chart-legend-item"><span class="chart-legend-swatch" style="background:${color}"></span>${escapeHtml(label)}</span>`)
    .join("");

  const wrap = document.createElement("div");
  wrap.className = "chart-svg-wrap";
  wrap.appendChild(svg);
  wrap.appendChild(tooltip);

  container.innerHTML = "";
  container.appendChild(wrap);
  container.appendChild(legend);
}

// A single metric's value across saved snapshots, oldest to newest — used
// three times in History & Trends (velocity, resolved, cycle time), each as
// its own chart per the "never dual-axis" rule (different units/scales).
// No legend: one series, and the title already names it.
function renderTrendLineChart(container, points, { formatValue = (v) => String(v) } = {}) {
  if (!points || points.length === 0) {
    container.innerHTML = `<p class="chart-empty">No data yet.</p>`;
    return;
  }
  if (points.length === 1) {
    container.innerHTML = `<p class="chart-empty">Only one snapshot so far — need at least two to plot a trend.</p>`;
    return;
  }

  const width = 320;
  const height = 180;
  const marginTop = 16;
  const marginBottom = 28;
  const marginLeft = 8;
  const marginRight = 8;
  const plotHeight = height - marginTop - marginBottom;
  const plotWidth = width - marginLeft - marginRight;

  const maxVal = Math.max(...points.map((p) => p.value), 0.0001) * 1.15;
  const xFor = (i) => marginLeft + (points.length === 1 ? plotWidth / 2 : (plotWidth * i) / (points.length - 1));
  const yFor = (v) => marginTop + plotHeight - (v / maxVal) * plotHeight;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Trend over time" });

  // Gridlines at 0 / mid / max, with axis text carrying the values the
  // line's own end-labels don't (marks-and-anatomy.md: keep ticks unless
  // every value is labeled).
  [0, 0.5, 1].forEach((frac) => {
    const y = marginTop + plotHeight - frac * plotHeight;
    svg.appendChild(svgEl("line", { class: "chart-gridline", x1: marginLeft, x2: width - marginRight, y1: y, y2: y }));
    const label = svgEl("text", { class: "chart-axis-text", x: marginLeft, y: y - 3 });
    label.textContent = formatValue(frac * maxVal);
    svg.appendChild(label);
  });

  // Split into runs wherever a pair isn't "meaningful" (see isMeaningfulPair)
  // — each run gets its own line + area fill, with a visual gap (no line)
  // between runs instead of a connector implying a real before/after that
  // isn't there. Every point is still plotted and hoverable either way.
  const runs = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const point = points[i];
    if (isMeaningfulPair(prev, point)) {
      runs[runs.length - 1].push(point);
    } else {
      runs.push([point]);
    }
  }
  let runStartIndex = 0;
  for (const run of runs) {
    if (run.length > 1) {
      const runIndices = run.map((_, j) => runStartIndex + j);
      const pathD = run.map((p, j) => `${j === 0 ? "M" : "L"} ${xFor(runIndices[j])} ${yFor(p.value)}`).join(" ");
      svg.appendChild(svgEl("path", { class: "chart-line-path", d: pathD }));
      const areaD = `${pathD} L ${xFor(runIndices[runIndices.length - 1])} ${marginTop + plotHeight} L ${xFor(runIndices[0])} ${marginTop + plotHeight} Z`;
      svg.appendChild(svgEl("path", { class: "chart-area-fill", d: areaD }));
    }
    runStartIndex += run.length;
  }

  points.forEach((p, i) => {
    svg.appendChild(svgEl("circle", { class: "chart-dot", cx: xFor(i), cy: yFor(p.value), r: 4 }));
  });

  // First/last date labels only — every point would collide at typical
  // sprint-history lengths; the crosshair tooltip carries the rest.
  const firstLabel = svgEl("text", { class: "chart-axis-text", x: xFor(0), y: height - 8, "text-anchor": "start" });
  firstLabel.textContent = points[0].date;
  svg.appendChild(firstLabel);
  const lastLabel = svgEl("text", { class: "chart-axis-text", x: xFor(points.length - 1), y: height - 8, "text-anchor": "end" });
  lastLabel.textContent = points[points.length - 1].date;
  svg.appendChild(lastLabel);

  const crosshair = svgEl("line", { class: "chart-crosshair", x1: 0, x2: 0, y1: marginTop, y2: marginTop + plotHeight });
  crosshair.style.display = "none";
  svg.appendChild(crosshair);

  const hit = svgEl("rect", { x: 0, y: 0, width, height, fill: "transparent" });
  svg.appendChild(hit);

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;

  function nearestIndex(offsetX) {
    const ratio = offsetX / width;
    const i = Math.round(ratio * (points.length - 1));
    return Math.max(0, Math.min(points.length - 1, i));
  }

  hit.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = width / rect.width;
    const offsetX = (event.clientX - rect.left) * scaleX;
    const i = nearestIndex(offsetX);
    const x = xFor(i);
    crosshair.setAttribute("x1", x);
    crosshair.setAttribute("x2", x);
    crosshair.style.display = "block";

    tooltip.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = formatValue(points[i].value);
    const dateEl = document.createElement("div");
    dateEl.textContent = points[i].sprint ? `${points[i].date} · ${points[i].sprint}` : points[i].date;
    tooltip.appendChild(strong);
    tooltip.appendChild(dateEl);
    tooltip.hidden = false;
    const wrapRect = container.getBoundingClientRect();
    tooltip.style.left = `${(x / width) * rect.width + (rect.left - wrapRect.left)}px`;
    tooltip.style.top = `${yFor(points[i].value) * (rect.height / height) + (rect.top - wrapRect.top)}px`;
  });
  hit.addEventListener("pointerleave", () => {
    crosshair.style.display = "none";
    tooltip.hidden = true;
  });

  const wrap = document.createElement("div");
  wrap.className = "chart-svg-wrap";
  wrap.appendChild(svg);
  wrap.appendChild(tooltip);
  container.innerHTML = "";
  container.appendChild(wrap);
}

function renderTeamMetrics(report) {
  const tm = report.team_metrics;
  const rows = report.engineers
    .map(
      (e) => `
        <tr>
          <td>${escapeHtml(e.name)}</td>
          <td>${escapeHtml(e.role || "—")}</td>
          <td>${e.signals.work_items}</td>
          <td>${e.derived_metrics.resolved_count}</td>
          <td>${e.derived_metrics.velocity}</td>
          <td>${e.signals.cycle_time_hours.toFixed(1)}</td>
        </tr>
      `,
    )
    .join("");

  document.getElementById("team-metrics").innerHTML = `
    <h2>Team Metrics</h2>
    <div class="team-totals-row">
      <span>Work items<strong>${tm.total_work_items}</strong></span>
      <span>Resolved<strong>${tm.total_resolved}</strong></span>
      <span>Velocity<strong>${tm.team_velocity}</strong></span>
      <span>Avg cycle time (h)<strong>${tm.team_avg_cycle_time_hours.toFixed(1)}</strong></span>
    </div>
    <div class="chart-card">
      <h3>Load score by engineer</h3>
      <p class="chart-subtitle">Higher bars carry more relative workload; color is burnout risk, the dashed line is this team's average. Hover a bar for the full picture.</p>
      <div id="load-score-chart-wrap"></div>
    </div>
    <div style="overflow-x:auto">
      <table class="metrics-table">
        <thead>
          <tr>
            <th>Engineer</th><th>Role</th><th>Work items</th><th>Resolved</th><th>Velocity</th><th>Avg cycle time (h)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  renderLoadScoreChart(document.getElementById("load-score-chart-wrap"), report.engineers);
}

function renderTeam(report, teamIndex) {
  const snapshotMeta = currentSnapshotMetaByIndex[teamIndex] || { sprint_goal: null, blocked_by: null };
  document.getElementById("team-summary").innerHTML = `
    <h2>${escapeHtml(report.team.name)}</h2>
    <div class="team-meta-row">
      <span>Sprint: ${escapeHtml(report.team.sprint || "—")}</span>
      <span>Members: ${report.team.members}</span>
    </div>
    ${snapshotMeta.sprint_goal ? `<p><strong>Sprint goal:</strong> ${escapeHtml(snapshotMeta.sprint_goal)}</p>` : ""}
    ${snapshotMeta.blocked_by ? `<p><strong>Blocked by:</strong> ${escapeHtml(snapshotMeta.blocked_by)}</p>` : ""}
  `;

  renderTeamMetrics(report);

  const engineerContext = currentEngineerContextByIndex[teamIndex] || {};
  const cards = report.engineers
    .map((engineer, engineerIndex) => {
      const s = engineer.signals;
      const notes = engineer.recommendations.notes || "No recommendations yet — click Generate Recommendations below.";
      return `
        <article class="engineer-card">
          <h3>${escapeHtml(engineer.name)}</h3>
          <input
            class="role-input"
            type="text"
            value="${escapeHtml(engineer.role)}"
            placeholder="Role unknown"
            data-team-index="${teamIndex}"
            data-engineer-index="${engineerIndex}"
          />
          <dl class="signals-grid">
            <dt>Work items</dt><dd>${s.work_items}</dd>
            <dt>Resolved</dt><dd>${engineer.derived_metrics.resolved_count}</dd>
            <dt>Velocity</dt><dd>${engineer.derived_metrics.velocity}</dd>
            <dt>Cycle time (h)</dt><dd>${s.cycle_time_hours.toFixed(1)}</dd>
            <dt>Blocked</dt><dd>${s.blocked_items}</dd>
            <dt>Priority pressure</dt><dd>${escapeHtml(s.priority_pressure)}</dd>
            <dt>Context switching</dt><dd>${s.context_switching_index}</dd>
            <dt>Unplanned ratio</dt><dd>${(s.unplanned_work_ratio * 100).toFixed(0)}%</dd>
          </dl>
          <label class="weight-field">
            Load weight
            <input
              class="weight-input"
              type="number"
              step="0.05"
              min="0.05"
              value="${engineer.derived_metrics.weight}"
              data-team-index="${teamIndex}"
              data-engineer-index="${engineerIndex}"
            />
          </label>
          <div>
            Load score:
            <strong class="load-score-value" data-team-index="${teamIndex}" data-engineer-index="${engineerIndex}">${engineer.derived_metrics.load_score.toFixed(0)}</strong>
            <span class="burnout-badge ${burnoutClass(engineer.derived_metrics.burnout_risk)}" data-team-index="${teamIndex}" data-engineer-index="${engineerIndex}">${escapeHtml(engineer.derived_metrics.burnout_risk)}</span>
          </div>
          <label class="card-field">
            Work-pattern notes
            <input
              class="notes-input"
              type="text"
              value="${escapeHtml(currentRosterNotes[engineer.name] || "")}"
              placeholder="e.g. tests in the back half of the sprint"
              data-team-index="${teamIndex}"
              data-engineer-index="${engineerIndex}"
            />
          </label>
          <button type="button" class="save-card-btn" data-team-index="${teamIndex}" data-engineer-index="${engineerIndex}">Save Role/Weight/Notes to Roster</button>
          <p class="card-save-status" data-team-index="${teamIndex}" data-engineer-index="${engineerIndex}"></p>
          <div class="sprint-context-fields">
            <label class="card-field">
              PTO days this sprint
              <input
                class="pto-days-input"
                type="number"
                step="0.5"
                min="0"
                value="${engineerContext[engineer.name]?.pto_days ?? ""}"
                placeholder="0"
                data-team-index="${teamIndex}"
                data-engineer-index="${engineerIndex}"
              />
            </label>
            <label class="checkbox-label">
              <input
                class="on-call-input"
                type="checkbox"
                ${engineerContext[engineer.name]?.on_call ? "checked" : ""}
                data-team-index="${teamIndex}"
                data-engineer-index="${engineerIndex}"
              />
              On-call this sprint
            </label>
            <button type="button" class="save-sprint-context-btn" data-team-index="${teamIndex}" data-engineer-index="${engineerIndex}">Save Sprint Context</button>
            <p class="sprint-context-status" data-team-index="${teamIndex}" data-engineer-index="${engineerIndex}"></p>
          </div>
          <div class="${engineer.recommendations.notes ? "reasoning-output" : "notes-placeholder"}">${engineer.recommendations.notes ? formatMessage(notes) : escapeHtml(notes)}</div>
        </article>
      `;
    })
    .join("");
  document.getElementById("engineer-cards").innerHTML = `<h2>Engineers</h2><div class="cards-grid">${cards}</div>`;

  const tr = report.team_recommendations;
  const hasContent = Boolean(tr.notes || tr.sprint_feasibility || tr.redistribute_work.length);
  document.getElementById("team-recommendations").innerHTML = hasContent
    ? `
      <h2>Team recommendations</h2>
      ${tr.sprint_feasibility ? `<p><strong>Sprint feasibility:</strong> ${formatMessage(tr.sprint_feasibility)}</p>` : ""}
      ${
        tr.redistribute_work.length
          ? `<p><strong>Redistribute work from:</strong> ${tr.redistribute_work.map((name) => `<span class="recommendation-badge">${escapeHtml(name)}</span>`).join(" ")}</p>`
          : ""
      }
      ${tr.notes ? `<div class="reasoning-output">${formatMessage(tr.notes)}</div>` : ""}
    `
    : `
      <h2>Team recommendations</h2>
      <p class="notes-placeholder">Empty until you click Generate Recommendations above.</p>
    `;
}

function renderPayload(payload) {
  currentPayload = payload;
  resultsEl.hidden = false;

  const multi = payload.reports.length > 1;
  teamSelectorWrap.hidden = !multi;
  // Includes sprint, not just team name — a multi-sprint CSV split (see
  // ingestGroupedBySprint) produces several reports for the SAME team, and
  // a dropdown of identical "BDPSA"/"BDPSA"/"BDPSA" labels would be useless.
  teamSelector.innerHTML = payload.reports
    .map((r, i) => `<option value="${i}">${escapeHtml(r.team.name)} — ${escapeHtml(r.team.sprint)}</option>`)
    .join("");

  currentTeamIndex = 0;
  renderTeam(payload.reports[0], 0);
  jsonOutput.textContent = JSON.stringify(payload, null, 2);
}

teamSelector.addEventListener("change", () => {
  currentTeamIndex = Number(teamSelector.value);
  if (currentPayload) renderTeam(currentPayload.reports[currentTeamIndex], currentTeamIndex);
});

reasonForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentPayload) return;

  reasonStatusEl.classList.remove("error");
  reasonStatusEl.textContent = "Generating recommendations…";

  try {
    const response = await fetch("/api/reason", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: currentPayload,
        provider: reasonProvider.value,
        url: reasonUrlInput.value,
        model: reasonModelSelect.value || undefined,
        context: document.getElementById("reasonContext").value || undefined,
        // When set, the server auto-enriches with charter/sprint-position/
        // roster notes/sprint goal/blocked-by/PTO/on-call from the DB — the
        // same enrichment `teamgauge reason --team` already did, now
        // available to the UI's Recommendations panel too.
        team: currentAnalyzedTeam || undefined,
        sprint: currentAnalyzedTeam ? currentPayload.reports[currentTeamIndex]?.team.sprint : undefined,
        snapshotDate: currentAnalyzedTeam ? currentSnapshotDateFor(currentTeamIndex) : undefined,
      }),
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "reasoning step failed");

    currentPayload = payload;
    renderTeam(currentPayload.reports[currentTeamIndex], currentTeamIndex);
    jsonOutput.textContent = JSON.stringify(currentPayload, null, 2);
    reasonStatusEl.textContent = "Recommendations generated.";
  } catch (error) {
    reasonStatusEl.textContent = error.message;
    reasonStatusEl.classList.add("error");
  }
});

// A role/weight/notes set from an engineer card is meant as a standing fact
// ("this is who this person is"), not a deliberately-dated role CHANGE —
// that power-user case already has its own path (`teamgauge team set-role
// --effective <date>`). Backdating the card save to "the earliest date in
// the current batch" (an earlier fix) still broke across separate uploads:
// analyzing a narrower CSV, saving a role, then analyzing a WIDER CSV whose
// multi-sprint split reaches further back in time meant the role's
// effective_from was still later than some of the newly-visible sprints,
// so it silently didn't apply to them — a real, observed case ("roles and
// weights disappear when I analyze other CSVs"). Using a fixed, far-past
// epoch instead means a card save always applies to every sprint that team
// will ever have, past or future upload, closing this class of bug
// entirely rather than chasing "earliest so far" across uploads.
const ROSTER_FACT_EPOCH = "1970-01-01";

// The engineer card is the one place role/weight/notes get edited. Nothing
// saves until "Save Role/Weight/Notes to Roster" is clicked — no
// save-on-blur, so there's never ambiguity about whether typing into a
// field did or didn't persist. This is the roster's real feeder, not a
// separate form. When it didn't (ad hoc analysis), it says so explicitly
// rather than pretending to save.
async function persistCardToRoster(teamIndex, engineerIndex) {
  const selector = `[data-team-index="${teamIndex}"][data-engineer-index="${engineerIndex}"]`;
  const cardStatusEl = document.querySelector(`.card-save-status${selector}`);

  if (!currentAnalyzedTeam) {
    cardStatusEl.textContent = noSavedTeamMessage();
    cardStatusEl.classList.add("error");
    return;
  }

  const engineer = currentPayload.reports[teamIndex].engineers[engineerIndex];
  const role = document.querySelector(`.role-input${selector}`).value;
  const weight = Number(document.querySelector(`.weight-input${selector}`).value) || 1;
  const notes = document.querySelector(`.notes-input${selector}`).value;

  cardStatusEl.textContent = "Saving…";
  cardStatusEl.classList.remove("error");

  try {
    const response = await fetch("/api/teams/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team: currentAnalyzedTeam,
        engineerName: engineer.name,
        role,
        weight,
        notes: notes || undefined,
        effectiveFrom: ROSTER_FACT_EPOCH,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "save failed");

    engineer.role = role;
    currentRosterNotes[engineer.name] = notes;
    jsonOutput.textContent = JSON.stringify(currentPayload, null, 2);
    cardStatusEl.textContent = `✓ Saved to the "${currentAnalyzedTeam}" roster — applies to every sprint for this team, past and future.`;
    cardStatusEl.classList.remove("error");
  } catch (error) {
    cardStatusEl.textContent = `Not saved — ${error.message}`;
    cardStatusEl.classList.add("error");
  }
}

// PTO days / on-call are true for THIS sprint only — a different kind of
// fact from role/weight/notes (standing roster facts), so they persist to
// the snapshot they were entered against, not the roster, via their own
// button and endpoint. Requires knowing which exact snapshot is loaded
// (team + sprint + snapshotDate), same gating as the roster save.
async function persistCardSprintContext(teamIndex, engineerIndex) {
  const selector = `[data-team-index="${teamIndex}"][data-engineer-index="${engineerIndex}"]`;
  const statusEl = document.querySelector(`.sprint-context-status${selector}`);

  const snapshotDate = currentSnapshotDateFor(teamIndex);
  if (!currentAnalyzedTeam || !snapshotDate) {
    statusEl.textContent = noSavedTeamMessage();
    statusEl.classList.add("error");
    return;
  }

  const report = currentPayload.reports[teamIndex];
  const engineer = report.engineers[engineerIndex];
  const ptoDaysRaw = document.querySelector(`.pto-days-input${selector}`).value;
  const onCall = document.querySelector(`.on-call-input${selector}`).checked;

  statusEl.textContent = "Saving…";
  statusEl.classList.remove("error");

  try {
    const response = await fetch("/api/snapshots/engineer-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team: currentAnalyzedTeam,
        sprint: report.team.sprint,
        snapshotDate,
        engineerName: engineer.name,
        ptoDays: ptoDaysRaw ? Number(ptoDaysRaw) : undefined,
        onCall,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "save failed");

    if (!currentEngineerContextByIndex[teamIndex]) currentEngineerContextByIndex[teamIndex] = {};
    currentEngineerContextByIndex[teamIndex][engineer.name] = { pto_days: ptoDaysRaw ? Number(ptoDaysRaw) : null, on_call: onCall };
    statusEl.textContent = `✓ Saved for this sprint (${report.team.sprint}, ${snapshotDate}).`;
    statusEl.classList.remove("error");
  } catch (error) {
    statusEl.textContent = `Not saved — ${error.message}`;
    statusEl.classList.add("error");
  }
}

document.getElementById("engineer-cards").addEventListener("click", async (event) => {
  const teamIndex = Number(event.target.dataset.teamIndex);
  const engineerIndex = Number(event.target.dataset.engineerIndex);
  if (event.target.classList.contains("save-card-btn")) {
    await persistCardToRoster(teamIndex, engineerIndex);
  } else if (event.target.classList.contains("save-sprint-context-btn")) {
    await persistCardSprintContext(teamIndex, engineerIndex);
  }
});

document.getElementById("engineer-cards").addEventListener("change", async (event) => {
  if (!currentPayload) return;
  const teamIndex = Number(event.target.dataset.teamIndex);
  const engineerIndex = Number(event.target.dataset.engineerIndex);
  if (Number.isNaN(teamIndex) || Number.isNaN(engineerIndex)) return;
  const engineer = currentPayload.reports[teamIndex].engineers[engineerIndex];

  // Role/notes just update the in-memory JSON preview here — actually
  // saving happens only via the Save button (persistCardToRoster).
  if (event.target.classList.contains("role-input")) {
    engineer.role = event.target.value;
    jsonOutput.textContent = JSON.stringify(currentPayload, null, 2);
    return;
  }

  if (event.target.classList.contains("notes-input")) {
    return;
  }

  if (event.target.classList.contains("weight-input")) {
    const weight = Number(event.target.value);
    if (!(weight > 0)) return;

    try {
      const response = await fetch("/api/derive-metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signals: engineer.signals,
          weight,
          resolved_count: engineer.derived_metrics.resolved_count,
          velocity: engineer.derived_metrics.velocity,
        }),
      });
      const derivedMetrics = await response.json();
      if (!response.ok) throw new Error(derivedMetrics.error || "recompute failed");

      engineer.derived_metrics = derivedMetrics;
      jsonOutput.textContent = JSON.stringify(currentPayload, null, 2);

      const selector = `[data-team-index="${teamIndex}"][data-engineer-index="${engineerIndex}"]`;
      document.querySelector(`.load-score-value${selector}`).textContent = derivedMetrics.load_score.toFixed(0);
      const badge = document.querySelector(`.burnout-badge${selector}`);
      badge.textContent = derivedMetrics.burnout_risk;
      badge.className = `burnout-badge ${burnoutClass(derivedMetrics.burnout_risk)}`;
    } catch (error) {
      setStatus(error.message, true);
    }
  }
});

downloadBtn.addEventListener("click", () => {
  if (!currentPayload) return;
  const blob = new Blob([JSON.stringify(currentPayload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "teamgauge-report.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

const collisionBox = document.getElementById("collision-box");
const collisionMessageEl = document.getElementById("collision-message");
const similarSprintBox = document.getElementById("similar-sprint-box");
const similarSprintMessageEl = document.getElementById("similar-sprint-message");
const adhocTeamBox = document.getElementById("adhoc-team-box");
const adhocTeamMessageEl = document.getElementById("adhoc-team-message");
const adhocTeamSaveBtn = document.getElementById("adhoc-team-save-btn");

async function submitAnalyze(force) {
  setStatus("Analyzing…");
  resultsEl.hidden = true;
  collisionBox.hidden = true;
  similarSprintBox.hidden = true;
  adhocTeamBox.hidden = true;

  try {
    let response;
    if (multiTeamToggle.checked) {
      response = await fetch("/api/analyze-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configPath: document.getElementById("configPath").value }),
      });
    } else {
      const formData = new FormData(form);
      if (force) formData.set("force", "true");
      response = await fetch("/api/analyze", { method: "POST", body: formData });
    }

    const payload = await response.json();
    if (!response.ok) {
      // Prefill whatever WAS detected, even though the request failed on
      // the other field — only if the user hasn't already typed something,
      // so a partial detection isn't just thrown away.
      const teamNameInput = document.getElementById("teamName");
      const sprintInput = document.getElementById("sprint");
      if (payload.detected?.team && !teamNameInput.value) teamNameInput.value = payload.detected.team;
      if (payload.detected?.sprint && !sprintInput.value) sprintInput.value = payload.detected.sprint;
      throw new Error(payload.error || "request failed");
    }

    currentAnalyzedTeam = multiTeamToggle.checked ? null : analyzeTeamSelect.value || null;
    currentRosterNotes = {};
    currentEngineerContextByIndex = [];
    currentSnapshotMetaByIndex = [];
    // The server is the source of truth for what date each report actually
    // saved (or would save) under — a multi-sprint auto-split (see
    // CSVProvider.ingestGroupedBySprint) gives each sprint ITS OWN date, not
    // one shared "today", so this is never recomputed from the form field.
    currentSnapshotDates = currentAnalyzedTeam ? payload.snapshotDates || [] : [];
    if (currentAnalyzedTeam) {
      const profileResponse = await fetch(`/api/teams/profile?team=${encodeURIComponent(currentAnalyzedTeam)}`);
      const profileBody = await profileResponse.json();
      if (profileResponse.ok) {
        for (const row of profileBody.roster || []) currentRosterNotes[row.engineer_name] = row.notes || "";
      }

      // One history lookup per report — each may be a different sprint
      // (multi-sprint split) with its own PTO/on-call/sprint-goal/blocked-by
      // facts, not just report[0]'s.
      await Promise.all(
        payload.reports.map(async (report, i) => {
          const snapshotDate = currentSnapshotDates[i];
          const sprint = report.team.sprint;
          if (!sprint || !snapshotDate) return;
          const historyResponse = await fetch(
            `/api/history?${new URLSearchParams({ team: currentAnalyzedTeam, sprint })}`,
          );
          const historyBody = await historyResponse.json();
          if (!historyResponse.ok) return;
          const match = (historyBody.history || []).find((h) => h.snapshot_date === snapshotDate);
          if (match) {
            currentEngineerContextByIndex[i] = match.engineer_context || {};
            currentSnapshotMetaByIndex[i] = { sprint_goal: match.sprint_goal, blocked_by: match.blocked_by };
          }
        }),
      );
    }

    // A collision no longer blocks the view — the report reflects current
    // data/roster either way. It just means this run wasn't ALSO saved as a
    // new history entry, and "Save as new snapshot" is offered for that.
    renderPayload(payload);
    if (payload.collision) {
      collisionMessageEl.textContent = payload.collisionMessage || payload.error;
      document.getElementById("collision-force-btn").textContent = "Save as new snapshot";
      collisionBox.hidden = false;
    }
    if (payload.similarSprintWarning) {
      similarSprintMessageEl.textContent = payload.similarSprintWarning;
      similarSprintBox.hidden = false;
    }

    // Uploading a file feels like it should be enough to "have a team" —
    // it isn't, by design (a team profile carries sprint length/charter
    // that no CSV/JSON export has), but that gap confused a real first-time
    // user badly enough to be worth closing here instead of just
    // documenting it: offer to create the team from the name already on
    // the report, right where the ad hoc run just landed, instead of
    // sending them off to a separate Team Setup tab to retype it.
    if (!currentAnalyzedTeam && !multiTeamToggle.checked && payload.reports?.length > 0) {
      const teamName = payload.reports[0].team.name;
      const sprintCount = new Set(payload.reports.map((r) => r.team.sprint)).size;
      // A file whose detected/typed team name happens to match an already-
      // saved team doesn't auto-select "Use saved team" — nothing currently
      // does that unless you visit Team Setup first (see
      // syncAnalyzeTeamSelection) or pick it yourself. That produced a real,
      // confusing loop: a team you already saved kept getting treated as ad
      // hoc, forever prompting "Save as a team" again. Detect that case
      // here and point at what's actually needed (select it / link this run
      // to it) instead of implying a brand-new team must be created.
      const teamAlreadyExists = Array.from(analyzeTeamSelect.options).some((o) => o.value === teamName);
      adhocTeamSaveBtn.textContent = teamAlreadyExists ? "Use existing team" : "Save as a team";
      if (teamAlreadyExists) {
        adhocTeamMessageEl.textContent = `"${teamName}" is already a saved team, but this run wasn't associated with it — the "Use saved team" dropdown was left on "— none —". Click "Use existing team" to re-run this analysis against it${sprintCount > 1 ? `, recording all ${sprintCount} sprints found above as history` : ""}, without creating a duplicate or touching its existing profile.`;
      } else {
        adhocTeamMessageEl.textContent =
          sprintCount > 1
            ? `This was an ad hoc analysis — nothing is saved yet. Click "Save as a team" to create "${teamName}" as a saved team and re-run this analysis against it, recording all ${sprintCount} sprints found above as history.`
            : `This was an ad hoc analysis — nothing is saved yet. Click "Save as a team" to create "${teamName}" as a saved team and re-run this analysis against it, recording it as the first history entry.`;
      }
      adhocTeamSaveBtn.dataset.teamName = teamName;
      adhocTeamSaveBtn.dataset.teamExists = String(teamAlreadyExists);
      adhocTeamBox.hidden = false;
    }

    cardSaveStatusEl.textContent = currentAnalyzedTeam
      ? `Editing a card here saves to the "${currentAnalyzedTeam}" roster.`
      : "";
    cardSaveStatusEl.classList.remove("error");
    setStatus(`Loaded ${payload.reports.length} team report(s).`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAnalyze(false);
});

document.getElementById("collision-force-btn").addEventListener("click", () => submitAnalyze(true));

adhocTeamSaveBtn.addEventListener("click", async () => {
  const teamName = adhocTeamSaveBtn.dataset.teamName;
  if (!teamName) return;
  // Never re-create/upsert a team that already exists — createOrUpdateTeam
  // (src/db/teamProfile.ts) sets charter/sprint_length_days unconditionally
  // on every call, including to null when not given. This button only ever
  // knows the team's NAME, so calling create for an existing team would
  // silently wipe out a charter/sprint length someone already configured.
  // Re-check fresh here (not just trust the dataset flag from render time)
  // in case the team was created moments ago in another tab.
  const alreadyExists = adhocTeamSaveBtn.dataset.teamExists === "true";
  adhocTeamSaveBtn.disabled = true;
  adhocTeamMessageEl.textContent = alreadyExists ? `Linking to "${teamName}"…` : `Creating "${teamName}"…`;
  try {
    if (!alreadyExists) {
      const response = await fetch("/api/teams/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: teamName }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "failed to create team");
      await loadTeams();
    }

    analyzeTeamSelect.value = teamName;
    updateAnalyzeTeamFields();
    adhocTeamBox.hidden = true;
    // Re-runs the exact same analysis (the file input still holds the
    // upload) now targeted at the team, so this one click both
    // creates/links the team and saves the already-computed data as a
    // snapshot — not just an empty profile the user re-uploads into.
    await submitAnalyze(false);
  } catch (error) {
    adhocTeamMessageEl.textContent = `Couldn't create team: ${error.message}`;
  } finally {
    adhocTeamSaveBtn.disabled = false;
  }
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
