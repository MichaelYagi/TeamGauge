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
let currentRosterNotes = {};

// ---- Team Setup ----

const setupTeamSelect = document.getElementById("setupTeamSelect");
const setupTeamName = document.getElementById("setupTeamName");
const setupSprintLength = document.getElementById("setupSprintLength");
const setupCharter = document.getElementById("setupCharter");
const setupStatusEl = document.getElementById("setup-status");
const rosterTableWrap = document.getElementById("roster-table-wrap");
const rosterStatusEl = document.getElementById("roster-status");
const analyzeTeamSelect = document.getElementById("analyzeTeamSelect");
const cardSaveStatusEl = document.getElementById("card-save-status");

// The team a currently-loaded report was analyzed against, if any — role/
// weight/notes edits on an engineer card only persist to the roster when
// this is set (i.e. the report came from a saved team, not an ad hoc run).
let currentAnalyzedTeam = null;

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
          <td>${escapeHtml(r.role || (r.unconfigured ? "seen in reports — not yet configured" : "—"))}</td>
          <td>${r.weight ?? 1}</td>
          <td>${escapeHtml(r.notes || "—")}</td>
          <td>${escapeHtml(r.effective_from || "—")}</td>
          <td><button type="button" class="depart-btn" data-name="${escapeHtml(r.engineer_name)}">Mark as departed</button></td>
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

async function loadTeamProfile(name) {
  if (!name) {
    setupTeamName.value = "";
    setupSprintLength.value = "";
    setupCharter.value = "";
    renderRosterTable([], [], []);
    renderDepartedTable([]);
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
}

document.getElementById("showPastMembers").addEventListener("change", (event) => {
  document.getElementById("departed-table-wrap").hidden = !event.target.checked;
});

rosterTableWrap.addEventListener("click", async (event) => {
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

function renderHistorySnapshots(history) {
  const rows = history
    .map(
      (h) => `
        <tr>
          <td>${escapeHtml(h.snapshot_date)}</td>
          <td>${escapeHtml(h.sprint)}</td>
          <td>${h.team_velocity}</td>
          <td>${h.total_resolved} / ${h.total_work_items}</td>
          <td>${h.team_avg_cycle_time_hours.toFixed(1)}</td>
          <td>${h.team_recommendations_notes || h.engineer_recommendations.length ? '<span class="recommendation-badge">yes</span>' : "—"}</td>
        </tr>
      `,
    )
    .join("");
  document.getElementById("history-snapshots-wrap").innerHTML = `
    <table class="metrics-table">
      <thead><tr><th>Date</th><th>Sprint</th><th>Velocity</th><th>Resolved / Total</th><th>Avg cycle time (h)</th><th>Recommendations?</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderHistoryTrend(trend) {
  const wrap = document.getElementById("history-trend-wrap");
  if (trend.deltas.length === 0) {
    wrap.innerHTML = `<p class="notes-placeholder">Need at least two snapshots to compute a trend — only one saved so far.</p>`;
    return;
  }

  const teamRows = trend.deltas
    .map(
      (d) => `
        <tr>
          <td>${escapeHtml(d.from_date)} → ${escapeHtml(d.to_date)}</td>
          <td class="${deltaClass(d.velocity_delta, true)}">${deltaArrow(d.velocity_delta)} ${d.velocity_delta}</td>
          <td class="${deltaClass(d.resolved_count_delta, true)}">${deltaArrow(d.resolved_count_delta)} ${d.resolved_count_delta}</td>
          <td class="${deltaClass(d.cycle_time_hours_delta, false)}">${deltaArrow(d.cycle_time_hours_delta)} ${d.cycle_time_hours_delta.toFixed(1)}</td>
        </tr>
      `,
    )
    .join("");

  const engineerRows = trend.engineers
    .flatMap((e) =>
      e.deltas.map(
        (d) => `
          <tr>
            <td>${escapeHtml(e.name)}</td>
            <td>${escapeHtml(d.from_date)} → ${escapeHtml(d.to_date)}</td>
            <td class="${deltaClass(d.load_score_delta, false)}">${deltaArrow(d.load_score_delta)} ${d.load_score_delta}</td>
            <td class="${deltaClass(d.velocity_delta, true)}">${deltaArrow(d.velocity_delta)} ${d.velocity_delta}</td>
            <td class="${deltaClass(d.cycle_time_hours_delta, false)}">${deltaArrow(d.cycle_time_hours_delta)} ${d.cycle_time_hours_delta.toFixed(1)}</td>
          </tr>
        `,
      ),
    )
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
      <tbody>${engineerRows || '<tr><td colspan="5">No engineer had more than one snapshot in this range.</td></tr>'}</tbody>
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

    renderHistorySnapshots(historyBody.history);
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
    document.getElementById("cumulative-result-wrap").innerHTML = `
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
  if (usingSavedTeam && !document.getElementById("snapshotDate").value) {
    document.getElementById("snapshotDate").value = localToday();
  }
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
}

function renderTeam(report, teamIndex) {
  document.getElementById("team-summary").innerHTML = `
    <h2>${escapeHtml(report.team.name)}</h2>
    <div class="team-meta-row">
      <span>Sprint: ${escapeHtml(report.team.sprint || "—")}</span>
      <span>Members: ${report.team.members}</span>
    </div>
  `;

  renderTeamMetrics(report);

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
  teamSelector.innerHTML = payload.reports
    .map((r, i) => `<option value="${i}">${escapeHtml(r.team.name)}</option>`)
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

// The engineer card is the one place role/weight/notes get edited. Nothing
// saves until "Save Role/Weight/Notes to Roster" is clicked — no
// save-on-blur, so there's never ambiguity about whether typing into a
// field did or didn't persist. When the loaded report came from a saved
// team, that button writes to that team's roster (dated today) — this is
// the roster's real feeder, not a separate form. When it didn't (ad hoc
// analysis), it says so explicitly rather than pretending to save.
async function persistCardToRoster(teamIndex, engineerIndex) {
  const selector = `[data-team-index="${teamIndex}"][data-engineer-index="${engineerIndex}"]`;
  const cardStatusEl = document.querySelector(`.card-save-status${selector}`);

  if (!currentAnalyzedTeam) {
    cardStatusEl.textContent = "Not saved — this analysis wasn't run against a saved team (pick one under \"Use saved team\" and re-analyze to persist edits).";
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
      body: JSON.stringify({ team: currentAnalyzedTeam, engineerName: engineer.name, role, weight, notes: notes || undefined }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "save failed");

    engineer.role = role;
    currentRosterNotes[engineer.name] = notes;
    jsonOutput.textContent = JSON.stringify(currentPayload, null, 2);
    cardStatusEl.textContent = `✓ Saved to the "${currentAnalyzedTeam}" roster just now.`;
    cardStatusEl.classList.remove("error");
  } catch (error) {
    cardStatusEl.textContent = `Not saved — ${error.message}`;
    cardStatusEl.classList.add("error");
  }
}

document.getElementById("engineer-cards").addEventListener("click", async (event) => {
  if (!event.target.classList.contains("save-card-btn")) return;
  const teamIndex = Number(event.target.dataset.teamIndex);
  const engineerIndex = Number(event.target.dataset.engineerIndex);
  await persistCardToRoster(teamIndex, engineerIndex);
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

async function submitAnalyze(force) {
  setStatus("Analyzing…");
  resultsEl.hidden = true;
  collisionBox.hidden = true;

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
    if (currentAnalyzedTeam) {
      const profileResponse = await fetch(`/api/teams/profile?team=${encodeURIComponent(currentAnalyzedTeam)}`);
      const profileBody = await profileResponse.json();
      if (profileResponse.ok) {
        for (const row of profileBody.roster || []) currentRosterNotes[row.engineer_name] = row.notes || "";
      }
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
