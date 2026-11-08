// Thin GitHub REST client for the engine repo. The token comes from the vault; nothing is stored here.

const API = "https://api.github.com";
export const ENGINE_REPO = "car-finder-engine";
export const SEARCH_WORKFLOW = "search.yml";
export const SAVE_WORKFLOW = "save-search.yml";
export const DAILY_WORKFLOW = "daily-scan.yml";

export class GitHubError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status;
    this.kind = kind; // "token" | "forbidden" | "notfound" | "rate" | "network" | "other"
  }
}

function classify(status, body) {
  const message = (body && body.message) || `GitHub returned ${status}`;
  if (status === 401) return new GitHubError("Your GitHub token was rejected. It may have expired or been revoked.", status, "token");
  if (status === 403 && /rate limit/i.test(message)) return new GitHubError("GitHub's rate limit was hit. Wait a few minutes and try again.", status, "rate");
  if (status === 403) return new GitHubError("Your token doesn't have permission for that. It needs Actions: read and write, and Contents: read-only on car-finder-engine.", status, "forbidden");
  if (status === 404) return new GitHubError("Not found. Check that car-finder-engine exists and the token can see it.", status, "notfound");
  return new GitHubError(message, status, "other");
}

export async function api(token, path, { method = "GET", body, raw = false, headers = {} } = {}) {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...headers,
    },
    cache: "no-store",
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${API}${path}`, init);
  } catch (error) {
    throw new GitHubError("Couldn't reach GitHub. Check your connection.", 0, "network");
  }
  const expiry = response.headers.get("github-authentication-token-expiration");
  if (response.status === 204) return { data: null, expiry };
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = raw ? text : null;
    }
  }
  if (!response.ok) throw classify(response.status, data);
  return { data, expiry, status: response.status };
}

export async function whoami(token) {
  const { data, expiry } = await api(token, "/user");
  return { login: data.login, expiry };
}

export async function checkEngineAccess(token, owner) {
  const { data } = await api(token, `/repos/${owner}/${ENGINE_REPO}`);
  return { name: data.full_name, private: data.private, defaultBranch: data.default_branch };
}

export async function dispatch(token, owner, workflow, inputs) {
  await api(token, `/repos/${owner}/${ENGINE_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: { ref: "main", inputs },
  });
}

export async function findRun(token, owner, workflow, runName) {
  const { data } = await api(token, `/repos/${owner}/${ENGINE_REPO}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=30`);
  const runs = (data && data.workflow_runs) || [];
  return runs.find((run) => run.name === runName || run.display_title === runName) || null;
}

export async function getRun(token, owner, runId) {
  const { data } = await api(token, `/repos/${owner}/${ENGINE_REPO}/actions/runs/${runId}`);
  return data;
}

export async function runSteps(token, owner, runId) {
  const { data } = await api(token, `/repos/${owner}/${ENGINE_REPO}/actions/runs/${runId}/jobs?per_page=10`);
  const jobs = (data && data.jobs) || [];
  const steps = [];
  for (const job of jobs) for (const step of job.steps || []) steps.push({ job: job.name, ...step });
  return { jobs, steps };
}

export function phaseFromSteps(run, steps) {
  if (!run) return "queued";
  if (run.status === "queued" || run.status === "waiting" || run.status === "pending") return "queued";
  if (run.status === "completed") return "done";
  const active = steps.find((s) => s.status === "in_progress") || [...steps].reverse().find((s) => s.status === "completed");
  if (!active) return "starting";
  const name = (active.name || "").toLowerCase();
  if (name.startsWith("search the web")) return "searching";
  if (/validate|photo|build the results|record usage|commit|read the photo|delete downloaded/.test(name)) return "checking";
  if (active.status === "completed" && /search the web/.test(name)) return "checking";
  return "starting";
}

export async function getJson(token, owner, path) {
  try {
    const { data } = await api(token, `/repos/${owner}/${ENGINE_REPO}/contents/${path}?ref=main&t=${Date.now()}`, { raw: true });
    if (typeof data === "string") return JSON.parse(data);
    return data;
  } catch (error) {
    if (error.kind === "notfound") return null;
    throw error;
  }
}

export async function listRecentRuns(token, owner, workflow, perPage = 20) {
  const { data } = await api(token, `/repos/${owner}/${ENGINE_REPO}/actions/workflows/${workflow}/runs?per_page=${perPage}`);
  return (data && data.workflow_runs) || [];
}
