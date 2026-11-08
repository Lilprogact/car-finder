// Car Finder — site controller. Plain ES module, no build step, no third-party code.

import * as vault from "./vault.js";
import * as gh from "./github.js";
import { el, clear, carCard, siteRow, sortListings, searchSummary, fmtTime, fmtDate } from "./render.js";
import { gbp } from "./finance.js";

const FORM_KEY = "cf.form.v1";
const SETTINGS_KEY = "cf.settings.v1";
const CURRENT_KEY = "cf.current.v1";
const POLL_MS = 10000;
const FORM_IDS = ["car", "price_max", "price_min", "mileage_max", "year_min", "year_max", "include_new", "finish", "sellers",
  "engine_min", "engine_max", "body", "gearbox", "postcode_district", "max_distance_miles", "deposit_value", "deposit_type",
  "term_months", "apr", "balloon_percent"];
const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-5-5"];

const $ = (id) => document.getElementById(id);
const state = {
  owner: null,
  current: null,        // {request_id, started_at, car, run_id, done}
  results: null,        // results JSON currently shown
  pollTimer: null,
  tickTimer: null,
  pollMisses: 0,
  sortBy: "value",
  view: "search",
  pendingSave: null,
};

// ---------- small helpers ----------

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  if (value === null || value === undefined) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}
function settings() {
  return readJson(SETTINGS_KEY, { model: "claude-sonnet-5-5", daily_model: "claude-sonnet-5-5", budget: 100 });
}
function saveSettings(patch) {
  writeJson(SETTINGS_KEY, { ...settings(), ...patch });
}
function notice(text, kind = "") {
  const node = $("global-notice");
  node.textContent = text || "";
  node.className = `notice ${kind}`.trim();
  node.hidden = !text;
}
function setText(id, text) {
  $(id).textContent = text == null ? "" : String(text);
}
function show(id, visible) {
  $(id).hidden = !visible;
}
function requestId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(36).slice(-1)).join("");
  return `${stamp}-${rand}`;
}
function numOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function token() {
  const t = await vault.getToken();
  if (!t) throw new gh.GitHubError("Add your GitHub token in Settings first.", 0, "token");
  return t;
}

function handleError(error, where = "") {
  console.error(where, error);
  if (error && error.kind === "token") {
    notice(`${error.message} Settings has the steps for making a new token.`, "warn");
    switchView("settings");
    refreshTokenState();
    return;
  }
  notice(error && error.message ? error.message : "Something went wrong.", "warn");
}

// ---------- views ----------

function switchView(name) {
  state.view = name;
  for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== `view-${name}`;
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("is-active", tab.dataset.view === name);
  window.scrollTo({ top: 0 });
  if (name === "past") loadPast();
  if (name === "saved") loadSaved();
  if (name === "settings") {
    refreshTokenState();
    loadUsage();
  }
}

// ---------- form ----------

function formValues() {
  const values = {};
  for (const id of FORM_IDS) {
    const node = $(id);
    values[id] = node.type === "checkbox" ? node.checked : node.value;
  }
  return values;
}
function applyFormValues(values) {
  for (const id of FORM_IDS) {
    if (!(id in values)) continue;
    const node = $(id);
    if (node.type === "checkbox") node.checked = !!values[id];
    else node.value = values[id];
  }
}
function rememberForm() {
  writeJson(FORM_KEY, formValues());
}

function buildSearch() {
  const v = formValues();
  const errors = [];
  const car = String(v.car || "").trim().replace(/\s+/g, " ");
  if (car.length < 2) errors.push("Type a car.");
  const price_max = numOrNull(v.price_max);
  if (price_max === null || price_max < 500) errors.push("Max price needs to be at least £500.");
  const mileage_max = numOrNull(v.mileage_max);
  if (mileage_max === null || mileage_max < 0) errors.push("Max mileage is missing.");
  const year_min = numOrNull(v.year_min);
  if (year_min === null || year_min < 1980 || year_min > 2100) errors.push("Year from looks wrong.");
  const year_max = numOrNull(v.year_max);
  if (year_max !== null && year_min !== null && year_max < year_min) errors.push("Year to is before year from.");
  const term = numOrNull(v.term_months);
  if (term === null || term < 24 || term > 60) errors.push("Term must be 24 to 60 months.");
  const postcode = String(v.postcode_district || "").trim().toUpperCase();
  if (postcode && !/^[A-Z]{1,2}\d[A-Z\d]?$/.test(postcode)) errors.push("Postcode district should be the first half only, like HA9 or SW1A.");
  if (errors.length) return { errors };
  const search = {
    version: 1,
    car,
    price_max,
    price_min: numOrNull(v.price_min),
    mileage_max,
    year_min,
    year_max,
    include_new: !!v.include_new,
    finish: v.finish,
    engine_min: numOrNull(v.engine_min),
    engine_max: numOrNull(v.engine_max),
    body: v.body,
    gearbox: v.gearbox,
    postcode_district: postcode,
    max_distance_miles: postcode ? numOrNull(v.max_distance_miles) : null,
    sellers: v.sellers,
    finance: {
      deposit_value: numOrNull(v.deposit_value) ?? 10,
      deposit_type: v.deposit_type === "gbp" ? "gbp" : "percent",
      term_months: term,
      apr: numOrNull(v.apr) ?? 18.5,
      balloon_percent: numOrNull(v.balloon_percent) ?? 35,
    },
    model: MODELS.includes(settings().model) ? settings().model : "claude-sonnet-5-5",
  };
  return { search };
}

// ---------- search run + polling ----------

async function startSearch(event) {
  event.preventDefault();
  show("search-error", false);
  const built = buildSearch();
  if (built.errors) {
    setText("search-error", built.errors.join(" "));
    show("search-error", true);
    return;
  }
  const btn = $("search-btn");
  btn.disabled = true;
  btn.textContent = "Starting…";
  try {
    const t = await token();
    const id = requestId();
    await gh.dispatch(t, state.owner, gh.SEARCH_WORKFLOW, { request_id: id, search: JSON.stringify(built.search) });
    state.current = { request_id: id, started_at: new Date().toISOString(), car: built.search.car, run_id: null, done: false, search: built.search };
    writeJson(CURRENT_KEY, state.current);
    state.results = null;
    showStatus("queued");
    switchView("results");
    startPolling();
  } catch (error) {
    handleError(error, "startSearch");
  } finally {
    btn.disabled = false;
    btn.textContent = "Search";
  }
}

function showStatus(phase, errorText = "") {
  const card = $("status-card");
  show("results-empty", false);
  show("status-card", true);
  show("results", !!state.results);
  const labels = { queued: "Queued", starting: "Starting", searching: "Searching the web", checking: "Checking listings", done: "Done", failed: "Failed" };
  setText("status-label", labels[phase] || phase);
  card.classList.toggle("is-done", phase === "done");
  card.classList.toggle("is-failed", phase === "failed");
  const order = ["queued", "searching", "checking", "done"];
  const current = phase === "starting" ? "queued" : phase === "failed" ? "done" : phase;
  const index = order.indexOf(current);
  for (const li of card.querySelectorAll(".phases li")) {
    const i = order.indexOf(li.dataset.phase);
    li.classList.toggle("is-done", i < index);
    li.classList.toggle("is-current", i === index);
  }
  setText("status-error", errorText);
  show("status-error", !!errorText);
  show("status-help", phase !== "done" && phase !== "failed");
  tick();
}

function tick() {
  if (!state.current) return;
  const start = new Date(state.current.started_at).getTime();
  const finished = state.current.finished_at ? new Date(state.current.finished_at).getTime() : NaN;
  const end = Number.isFinite(finished) && finished > start ? finished : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  setText("status-elapsed", `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  clearInterval(state.tickTimer);
  state.pollTimer = null;
  state.tickTimer = null;
}

function startPolling() {
  stopPolling();
  state.pollMisses = 0;
  state.tickTimer = setInterval(tick, 1000);
  pollOnce();
}

async function pollOnce() {
  if (!state.current || state.current.done) return stopPolling();
  try {
    const t = await token();
    const runName = `Search ${state.current.request_id}`;
    if (!state.current.run_id) {
      const run = await gh.findRun(t, state.owner, gh.SEARCH_WORKFLOW, runName);
      if (run) {
        state.current.run_id = run.id;
        writeJson(CURRENT_KEY, state.current);
      } else {
        state.pollMisses += 1;
        const ageMin = (Date.now() - new Date(state.current.started_at).getTime()) / 60000;
        showStatus("queued", ageMin > 3 ? "GitHub hasn't listed the run yet. It is probably queued behind another search; this page keeps checking." : "");
        if (ageMin > 60) {
          showStatus("failed", "No run appeared within an hour. Check the Actions tab of car-finder-engine, then search again.");
          return finishCurrent();
        }
      }
    }
    // Whatever the Actions API says, a committed results file means the run is finished.
    const early = await gh.getJson(t, state.owner, `results/${state.current.request_id}.json`).catch(() => null);
    if (early) {
      state.current.finished_at = early.finished_at || new Date().toISOString();
      renderResults(early);
      showStatus(early.status === "done" ? "done" : "failed", early.status === "done" ? "" : early.error || `Run ended with status ${early.status}.`);
      return finishCurrent();
    }
    if (state.current.run_id) {
      const run = await gh.getRun(t, state.owner, state.current.run_id);
      if (run.status === "completed") {
        showStatus("checking");
        const results = await fetchResultsWithRetry(t, state.current.request_id);
        if (results) {
          state.current.finished_at = results.finished_at || new Date().toISOString();
          renderResults(results);
          showStatus(results.status === "done" ? "done" : "failed", results.status === "done" ? "" : results.error || `Run ended with status ${results.status}.`);
          if (results.status !== "done" && (results.matches.length || results.near_misses.length)) show("results", true);
        } else {
          showStatus("failed", `The run finished (${run.conclusion || "unknown"}) but no results file was committed. Open the run in the Actions tab of car-finder-engine to see why.`);
        }
        return finishCurrent();
      }
      const { steps } = await gh.runSteps(t, state.owner, state.current.run_id);
      showStatus(gh.phaseFromSteps(run, steps));
    }
  } catch (error) {
    if (error.kind === "token") {
      handleError(error, "poll");
      return stopPolling();
    }
    showStatus(state.current.run_id ? "searching" : "queued", `Couldn't check progress just now: ${error.message} Retrying every 10 seconds; the search itself carries on in GitHub.`);
  }
  state.pollTimer = setTimeout(pollOnce, POLL_MS);
}

async function fetchResultsWithRetry(t, id) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const results = await gh.getJson(t, state.owner, `results/${id}.json`);
    if (results) return results;
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  return null;
}

function finishCurrent() {
  if (state.current) {
    state.current.done = true;
    writeJson(CURRENT_KEY, state.current);
  }
  stopPolling();
  tick();
  loadDailyCount();
}

// ---------- results rendering ----------

function renderResults(results) {
  state.results = results;
  show("results-empty", false);
  show("results", true);
  const search = results.search || {};
  setText("results-title", search.car || "Results");
  const meta = [searchSummary(search)];
  meta.push(`${results.trigger === "daily" ? "Daily scan" : "Search"} ${fmtTime(results.started_at)}`);
  if (results.model) meta.push(`${results.model.replace("claude-", "").replace(/-(\d)-(\d)/, " $1.$2")}`);
  if (results.usage && typeof results.usage.total_cost_usd === "number") meta.push(`cost reported $${results.usage.total_cost_usd.toFixed(2)}`);
  setText("results-meta", meta.filter(Boolean).join(" — "));

  const banner = $("results-banner");
  if (results.status !== "done" || results.error) {
    banner.textContent = results.error || `This run ended with status ${results.status}.`;
    banner.className = "banner";
    banner.hidden = false;
  } else if (results.stopped_early) {
    banner.textContent = "The agent stopped early (it hit a limit). What it found is below; the sites list shows how far it got.";
    banner.className = "banner warn";
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  const budget = $("results-budget");
  if (results.budget_note && /warning|reached/i.test(results.budget_note)) {
    budget.textContent = results.budget_note;
    budget.hidden = false;
  } else {
    budget.hidden = true;
  }

  const matches = sortListings(results.matches || [], state.sortBy);
  const near = sortListings(results.near_misses || [], state.sortBy);
  setText("matches-count", `${matches.length}`);
  setText("near-count", `${near.length}`);
  const matchesNode = $("matches");
  clear(matchesNode);
  if (!matches.length) matchesNode.append(el("div", { class: "none", text: results.status === "done" ? "No listing met every rule in this run. That is the honest result, not a glitch: see the near misses and the sites list below." : "No matches recorded." }));
  for (const car of matches) matchesNode.append(carCard(car, search));
  const nearNode = $("near-misses");
  clear(nearNode);
  if (!near.length) nearNode.append(el("div", { class: "none", text: "No near misses in this run." }));
  for (const car of near) nearNode.append(carCard(car, search));

  setText("coverage-note", results.coverage_note || "");
  const sitesNode = $("sites");
  clear(sitesNode);
  for (const site of results.sites || []) sitesNode.append(siteRow(site));
  if (!(results.sites || []).length) sitesNode.append(el("div", { class: "none", text: "No sites were recorded for this run." }));
  const notes = [];
  if (results.agent_notes) notes.push(`Agent notes: ${results.agent_notes}`);
  if (results.counts) notes.push(`Checker: ${results.counts.listings_from_agent} listings from the agent, ${results.counts.duplicates_removed} duplicates removed, ${results.counts.filter_rejected} outside your rules, ${results.counts.recheck_dropped} gone on re-check.`);
  setText("agent-notes", notes.join(" "));
}

async function openPastRun(entry) {
  try {
    const t = await token();
    notice("");
    const results = await gh.getJson(t, state.owner, `results/${entry.file || entry.request_id + ".json"}`);
    if (!results) {
      notice("That results file isn't in the engine repo any more.", "warn");
      return;
    }
    const isCurrent = state.current && state.current.request_id === results.request_id && !state.current.done;
    if (!isCurrent) {
      stopPolling();
      show("status-card", false);
    }
    renderResults(results);
    switchView("results");
  } catch (error) {
    handleError(error, "openPastRun");
  }
}

// ---------- past searches ----------

async function loadPast() {
  const list = $("past-list");
  clear(list);
  list.append(el("p", { class: "meta", text: "Loading…" }));
  try {
    const t = await token();
    const index = await gh.getJson(t, state.owner, "results/index.json");
    const runs = (index && index.runs) || [];
    clear(list);
    if (!runs.length) {
      list.append(el("div", { class: "none", text: "No searches recorded yet." }));
      return;
    }
    for (const run of runs) {
      const status = run.status || "unknown";
      const right = status === "done" ? `${run.matches} match${run.matches === 1 ? "" : "es"}, ${run.near_misses} near` : status.replace("_", " ");
      const row = el("button", { type: "button", class: `row ${status === "done" ? "" : "is-failed"}`, onclick: () => openPastRun(run) },
        el("span", { class: "t", text: run.car || run.request_id }),
        el("span", { class: "r", text: right }),
        el("span", { class: "d", text: `${run.trigger === "daily" ? "Daily scan" : "Search"} ${fmtTime(run.started_at)}${run.model ? ", " + run.model.replace("claude-", "") : ""}${typeof run.cost_usd === "number" && run.cost_usd ? `, $${run.cost_usd.toFixed(2)}` : ""}` }));
      list.append(row);
    }
    if (state.current && !state.current.done) {
      list.prepend(el("button", { type: "button", class: "row is-running", onclick: () => switchView("results") },
        el("span", { class: "t", text: state.current.car }),
        el("span", { class: "r", text: "running" }),
        el("span", { class: "d", text: `Search ${fmtTime(state.current.started_at)}, in progress` })));
    }
  } catch (error) {
    clear(list);
    handleError(error, "loadPast");
  }
}

async function loadDailyCount() {
  try {
    const t = await vault.getToken();
    if (!t || !state.owner) return;
    const index = await gh.getJson(t, state.owner, "results/index.json");
    const today = new Date().toISOString().slice(0, 10);
    const used = ((index && index.runs) || []).filter((r) => r.trigger === "manual" && String(r.started_at || "").startsWith(today)).length;
    setText("daily-count", `${used} of 10 manual searches used today (UTC). Only one search runs at a time; the next one queues.`);
  } catch {
    setText("daily-count", "");
  }
}

// ---------- saved searches ----------

async function loadSaved() {
  const list = $("saved-list");
  clear(list);
  list.append(el("p", { class: "meta", text: "Loading…" }));
  try {
    const t = await token();
    const data = await gh.getJson(t, state.owner, "saved-searches.json");
    const searches = (data && data.searches) || [];
    clear(list);
    if (state.pendingSave) list.append(el("p", { class: "meta", text: `Saving "${state.pendingSave}"… this takes about a minute. Tap Refresh.` }));
    if (!searches.length) {
      list.append(el("div", { class: "none", text: "Nothing saved yet. On the Search tab, set your filters and tap Save this search." }));
      return;
    }
    for (const item of searches) {
      const toggle = el("input", { type: "checkbox" });
      toggle.checked = item.enabled !== false;
      toggle.addEventListener("change", () => saveAction("toggle", { id: item.id, enabled: toggle.checked }, `${toggle.checked ? "Switched on" : "Switched off"}: ${item.name}`));
      const remove = el("button", { type: "button", class: "danger", text: "Remove" });
      remove.addEventListener("click", async () => {
        const ok = await modal({ title: `Remove "${item.name}"?`, text: "It will stop being scanned. Past results stay in the engine repo.", okText: "Remove" });
        if (ok) saveAction("remove", { id: item.id }, `Removed: ${item.name}`);
      });
      list.append(el("div", { class: "saved-row" },
        el("div", { class: "top-line" }, el("span", { class: "t", text: item.name || item.id }), el("label", { class: "switch" }, toggle, el("span", { text: "Daily scan" }))),
        el("div", { class: "d", text: searchSummary(item.search) }),
        el("div", { class: "d", text: `Saved ${fmtDate(item.created_at)}` }),
        el("div", { class: "actions" }, remove)));
    }
  } catch (error) {
    clear(list);
    handleError(error, "loadSaved");
  }
}

async function saveAction(action, payload, label) {
  try {
    const t = await token();
    const id = requestId();
    await gh.dispatch(t, state.owner, gh.SAVE_WORKFLOW, { action, payload: JSON.stringify(payload), request_id: id });
    notice(`${label}. GitHub is applying it (about a minute).`, "ok");
    state.pendingSave = label;
    waitForSave(id).then(() => {
      state.pendingSave = null;
      if (state.view === "saved") loadSaved();
      notice(`${label}. Done.`, "ok");
    });
  } catch (error) {
    handleError(error, "saveAction");
  }
}

async function waitForSave(id) {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 7000));
    try {
      const t = await token();
      const runs = await gh.listRecentRuns(t, state.owner, gh.SAVE_WORKFLOW, 10);
      const run = runs.find((r) => String(r.name || r.display_title || "").includes(id));
      if (run && run.status === "completed") return run;
    } catch {
      /* keep waiting */
    }
  }
  return null;
}

async function saveCurrentSearch() {
  show("search-error", false);
  const built = buildSearch();
  if (built.errors) {
    setText("search-error", built.errors.join(" "));
    show("search-error", true);
    return;
  }
  const values = await modal({
    title: "Save this search",
    text: "It joins the daily scan (06:17 UTC). You'll get a GitHub issue when something new appears or a price drops.",
    fields: [{ id: "name", label: "Name", value: built.search.car, type: "text" }],
    okText: "Save",
  });
  if (!values) return;
  await saveAction("add", { name: values.name || built.search.car, search: built.search }, `Saved: ${values.name || built.search.car}`);
  switchView("saved");
}

// ---------- settings ----------

async function refreshTokenState() {
  const meta = vault.tokenMeta();
  if (!vault.hasToken()) {
    setText("token-state", "No token saved on this device yet.");
    return;
  }
  const bits = ["Token saved on this device"];
  if (meta.owner) bits.push(`for ${meta.owner}`);
  if (meta.expiresAt) {
    const days = Math.round((new Date(meta.expiresAt).getTime() - Date.now()) / 86400000);
    bits.push(days < 0 ? `(expired ${fmtDate(meta.expiresAt)})` : `(expires ${fmtDate(meta.expiresAt)}, ${days} days)`);
  }
  setText("token-state", bits.join(" ") + ".");
}

async function connectWithToken(candidate) {
  const { login, expiry } = await gh.whoami(candidate);
  await gh.checkEngineAccess(candidate, login);
  return { login, expiry: expiry ? new Date(expiry).toISOString() : null };
}

async function saveToken() {
  const input = $("token-input");
  const candidate = input.value.trim();
  setText("token-result", "");
  if (!candidate) {
    setText("token-result", "Paste a token first.");
    return;
  }
  try {
    setText("token-result", "Checking the token with GitHub…");
    const info = await connectWithToken(candidate);
    await vault.setToken(candidate, { owner: info.login, expiresAt: info.expiry });
    state.owner = info.login;
    input.value = "";
    setText("token-result", `Connected as ${info.login}. car-finder-engine is reachable.${info.expiry ? ` Token expires ${fmtDate(info.expiry)}.` : ""}`);
    notice("");
    refreshTokenState();
    loadUsage();
    loadDailyCount();
  } catch (error) {
    setText("token-result", error.message || "That token didn't work.");
  }
}

async function testToken() {
  try {
    const t = await token();
    setText("token-result", "Testing…");
    const info = await connectWithToken(t);
    state.owner = info.login;
    vault.setTokenMeta({ owner: info.login, expiresAt: info.expiry });
    setText("token-result", `Connected as ${info.login}. car-finder-engine is reachable.${info.expiry ? ` Token expires ${fmtDate(info.expiry)}.` : ""}`);
    refreshTokenState();
  } catch (error) {
    setText("token-result", error.message || "The test failed.");
  }
}

async function runDiagnostics() {
  const out = $("diagnostics");
  clear(out);
  out.hidden = false;
  out.append(el("p", { class: "meta", text: "Running checks…" }));
  try {
    const t = await token();
    const owner = state.owner || (await gh.whoami(t)).login;
    state.owner = owner;
    const lines = await gh.diagnostics(t, owner);
    clear(out);
    for (const line of lines) out.append(el("div", { class: line.startsWith("OK") ? "diag ok" : "diag bad", text: line }));
    out.append(el("p", { class: "help", text: "If anything failed, open the token on GitHub (Settings → Developer settings → Fine-grained tokens), check it covers car-finder-engine with Actions: Read and write and Contents: Read-only, then copy the message above to Claude." }));
  } catch (error) {
    clear(out);
    out.append(el("div", { class: "diag bad", text: error.message }));
  }
}

async function forgetToken() {
  const ok = await modal({ title: "Forget the token?", text: "The site will stop working on this device until you paste a new one. Also revoke it on GitHub if the device is lost.", okText: "Forget token" });
  if (!ok) return;
  vault.forgetToken();
  state.owner = null;
  setText("token-result", "Token removed from this device.");
  refreshTokenState();
}

async function loadUsage() {
  const line = $("usage-line");
  const bar = $("usage-bar");
  try {
    const t = await vault.getToken();
    if (!t || !state.owner) {
      line.textContent = "Usage loads once a token is saved.";
      return;
    }
    const month = new Date().toISOString().slice(0, 7);
    const [usage, config] = await Promise.all([gh.getJson(t, state.owner, `usage/${month}.json`), gh.getJson(t, state.owner, "config.json")]);
    const total = (usage && Number(usage.total_cost_usd)) || 0;
    const budget = (config && Number(config.monthly_budget_usd)) || Number(settings().budget) || 100;
    const pct = budget ? Math.min(100, (total / budget) * 100) : 0;
    bar.style.width = `${pct}%`;
    bar.className = `bar-fill ${pct >= 100 ? "over" : pct >= 80 ? "warn" : ""}`.trim();
    const runs = (usage && usage.runs && usage.runs.length) || 0;
    line.textContent = `This month: $${total.toFixed(2)} of $${budget.toFixed(0)} (${pct.toFixed(0)}%) across ${runs} run${runs === 1 ? "" : "s"}, as reported by Claude Code.${pct >= 100 ? " Budget reached: new runs are blocked until next month or a higher budget." : pct >= 80 ? " Warning: over 80% of the budget." : ""}`;
    if (config) {
      if (MODELS.includes(config.model) && !settings().touchedModel) $("model").value = config.model;
      if (MODELS.includes(config.daily_scan_model)) $("daily-model").value = config.daily_scan_model;
      if (config.monthly_budget_usd) $("budget").value = config.monthly_budget_usd;
    }
  } catch (error) {
    line.textContent = `Couldn't load usage: ${error.message}`;
  }
}

async function saveConfig() {
  const model = $("model").value;
  const daily = $("daily-model").value;
  const budget = Number($("budget").value);
  saveSettings({ model, daily_model: daily, budget, touchedModel: true });
  setText("config-result", "Sending to the engine…");
  try {
    const t = await token();
    const id = requestId();
    await gh.dispatch(t, state.owner, gh.SAVE_WORKFLOW, { action: "set_config", payload: JSON.stringify({ monthly_budget_usd: budget, model, daily_scan_model: daily }), request_id: id });
    setText("config-result", "Saved locally and sent to the engine (takes about a minute to apply).");
    waitForSave(id).then(() => setText("config-result", "Applied in the engine."));
  } catch (error) {
    setText("config-result", `Saved on this device, but the engine wasn't updated: ${error.message}`);
  }
}

// ---------- modal ----------

function modal({ title, text = "", fields = [], okText = "OK" }) {
  return new Promise((resolve) => {
    const root = $("modal");
    const form = $("modal-form");
    const fieldsNode = $("modal-fields");
    setText("modal-title", title);
    setText("modal-text", text);
    $("modal-ok").textContent = okText;
    show("modal-error", false);
    clear(fieldsNode);
    for (const field of fields) {
      fieldsNode.append(el("label", { class: "field" }, el("span", { text: field.label }),
        el("input", { type: field.type || "text", id: `modal-${field.id}`, value: field.value || "", autocomplete: field.type === "password" ? "new-password" : "off", required: field.required ? "required" : null })));
    }
    root.hidden = false;
    const first = fieldsNode.querySelector("input");
    if (first) first.focus();
    const done = (value) => {
      root.hidden = true;
      form.onsubmit = null;
      $("modal-cancel").onclick = null;
      resolve(value);
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = {};
      for (const field of fields) values[field.id] = $(`modal-${field.id}`).value;
      done(fields.length ? values : true);
    };
    $("modal-cancel").onclick = () => done(null);
  });
}

async function changePassword() {
  const values = await modal({
    title: "Change password",
    fields: [{ id: "old", label: "Current password", type: "password", required: true }, { id: "new1", label: "New password", type: "password", required: true }, { id: "new2", label: "New password again", type: "password", required: true }],
    okText: "Change",
  });
  if (!values) return;
  if (values.new1 !== values.new2) return notice("The new passwords don't match.", "warn");
  try {
    await vault.changePassword(values.old, values.new1);
    notice("Password changed.", "ok");
  } catch (error) {
    notice(error.message, "warn");
  }
}

async function resetDevice() {
  const ok = await modal({ title: "Clear everything on this device?", text: "Password, token and remembered settings are removed from this browser. Nothing in GitHub changes.", okText: "Clear" });
  if (!ok) return;
  stopPolling();
  vault.resetDevice();
  localStorage.removeItem(FORM_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(CURRENT_KEY);
  location.reload();
}

// ---------- lock screen ----------

function showLock(mode) {
  show("lock", true);
  show("lock-create", mode === "create");
  show("lock-unlock", mode === "unlock");
  show("lock-unsupported", mode === "unsupported");
  const input = mode === "create" ? $("create-pass-1") : $("unlock-pass");
  if (input) setTimeout(() => input.focus(), 50);
}

async function onUnlocked() {
  show("lock", false);
  $("unlock-pass").value = "";
  if (!vault.hasToken()) {
    notice("Add your GitHub token in Settings to start searching. Settings has the click-by-click steps.", "");
    switchView("settings");
    return;
  }
  try {
    const t = await vault.getToken();
    const meta = vault.tokenMeta();
    if (meta.owner) state.owner = meta.owner;
    else {
      const info = await connectWithToken(t);
      state.owner = info.login;
      vault.setTokenMeta({ owner: info.login, expiresAt: info.expiry });
    }
    if (meta.expiresAt) {
      const days = (new Date(meta.expiresAt).getTime() - Date.now()) / 86400000;
      if (days < 0) notice("Your GitHub token has expired. Make a new one (Settings has the steps) and paste it in.", "warn");
      else if (days < 7) notice(`Your GitHub token expires in ${Math.ceil(days)} day${Math.ceil(days) === 1 ? "" : "s"}. Make a new one soon (Settings has the steps).`, "warn");
    }
  } catch (error) {
    handleError(error, "onUnlocked");
    return;
  }
  loadDailyCount();
  if (state.current && !state.current.done) {
    switchView("results");
    showStatus(state.current.run_id ? "searching" : "queued");
    startPolling();
  } else if (state.current && state.current.done && !state.results) {
    loadLastResults();
  }
}

async function loadLastResults() {
  try {
    const t = await token();
    const results = await gh.getJson(t, state.owner, `results/${state.current.request_id}.json`);
    if (!results) return;
    state.current.finished_at = results.finished_at || state.current.finished_at;
    renderResults(results);
    showStatus(results.status === "done" ? "done" : "failed", results.status === "done" ? "" : results.error || "");
  } catch (error) {
    if (error.kind === "token") handleError(error, "loadLastResults");
  }
}

function bindLock() {
  $("lock-create").addEventListener("submit", async (event) => {
    event.preventDefault();
    const a = $("create-pass-1").value;
    const b = $("create-pass-2").value;
    show("create-error", false);
    if (a !== b) {
      setText("create-error", "The two passwords don't match.");
      show("create-error", true);
      return;
    }
    try {
      await vault.setPassword(a);
      $("create-pass-1").value = "";
      $("create-pass-2").value = "";
      onUnlocked();
    } catch (error) {
      setText("create-error", error.message);
      show("create-error", true);
    }
  });
  $("lock-unlock").addEventListener("submit", async (event) => {
    event.preventDefault();
    show("unlock-error", false);
    try {
      await vault.unlock($("unlock-pass").value);
      onUnlocked();
    } catch (error) {
      setText("unlock-error", error.message);
      show("unlock-error", true);
    }
  });
  $("forgot-password").addEventListener("click", async () => {
    show("lock", false);
    const ok = await modal({ title: "Clear this device?", text: "Without the password the token can't be recovered. Clearing removes it; you'll set a new password and paste a new token.", okText: "Clear this device" });
    if (ok) {
      vault.resetDevice();
      localStorage.removeItem(CURRENT_KEY);
      location.reload();
    } else {
      showLock("unlock");
    }
  });
  const lockNow = () => {
    stopPolling();
    vault.lock("manual");
  };
  $("lock-now").addEventListener("click", lockNow);
  $("lock-now-2").addEventListener("click", lockNow);
  vault.onLock(() => {
    stopPolling();
    showLock("unlock");
  });
  for (const type of ["click", "keydown", "touchstart"]) document.addEventListener(type, () => vault.noteActivity(), { passive: true });
}

// ---------- boot ----------

function bind() {
  for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => switchView(tab.dataset.view));
  $("search-form").addEventListener("submit", startSearch);
  $("search-form").addEventListener("change", rememberForm);
  $("search-form").addEventListener("input", rememberForm);
  $("save-btn").addEventListener("click", saveCurrentSearch);
  $("to-settings").addEventListener("click", () => switchView("settings"));
  $("sort").addEventListener("change", () => {
    state.sortBy = $("sort").value;
    if (state.results) renderResults(state.results);
  });
  $("refresh-past").addEventListener("click", loadPast);
  $("refresh-saved").addEventListener("click", loadSaved);
  $("token-save").addEventListener("click", saveToken);
  $("token-test").addEventListener("click", testToken);
  $("token-forget").addEventListener("click", forgetToken);
  $("token-diagnose").addEventListener("click", runDiagnostics);
  $("config-save").addEventListener("click", saveConfig);
  $("model").addEventListener("change", () => saveSettings({ model: $("model").value, touchedModel: true }));
  $("daily-model").addEventListener("change", () => saveSettings({ daily_model: $("daily-model").value }));
  $("budget").addEventListener("change", () => saveSettings({ budget: Number($("budget").value) }));
  $("change-password").addEventListener("click", changePassword);
  $("reset-device").addEventListener("click", resetDevice);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.current && !state.current.done && vault.state() === "unlocked" && !state.pollTimer) startPolling();
  });
}

async function boot() {
  bind();
  bindLock();
  applyFormValues(readJson(FORM_KEY, {}));
  const s = settings();
  if (MODELS.includes(s.model)) $("model").value = s.model;
  if (MODELS.includes(s.daily_model)) $("daily-model").value = s.daily_model;
  if (s.budget) $("budget").value = s.budget;
  state.current = readJson(CURRENT_KEY, null);
  if (!vault.supported()) return showLock("unsupported");
  const st = vault.state();
  if (st === "no_password") return showLock("create");
  if (await vault.resumeSession()) return onUnlocked();
  showLock("unlock");
}

boot();
