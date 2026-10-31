// Shared helpers for the npm scripts. Plain Node, so they work on Windows too.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SECRETS_FILE = path.join(ROOT, ".secrets.local.txt");
export const DEV_VARS = path.join(ROOT, ".dev.vars");
export const DB_NAME = "urbes-telemetry";
export const BUCKET = "urbes-telemetry-shots";
export const LOCAL_URL = "http://localhost:8787";

const WRANGLER = (() => {
  try {
    return createRequire(path.join(ROOT, "package.json")).resolve("wrangler/bin/wrangler.js");
  } catch {
    return null;
  }
})();

/**
 * Runs wrangler with node directly (no shell, so it behaves the same on Windows).
 * `capture: true` returns stdout+stderr instead of streaming them.
 */
export function wrangler(args, { capture = false, input, env } = {}) {
  if (!WRANGLER) fatal("wrangler is not installed. Run `npm install` first.");
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    stdio: capture || input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...env },
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function fatal(message) {
  console.error(`\n✕ ${message}\n`);
  process.exit(1);
}

/** Reads KEY=value lines (ignores comments and blanks). */
export function readVars(file) {
  if (!existsSync(file)) return {};
  const vars = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

/** Adds or replaces KEY=value lines in the git-ignored secrets file. */
export function saveSecrets(values) {
  const current = readVars(SECRETS_FILE);
  const merged = { ...current, ...values };
  const lines = [
    "# Urbes telemetry secrets written by `npm run setup`. Git-ignored. Keep it private.",
    ...Object.entries(merged).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  writeFileSync(SECRETS_FILE, lines.join("\n"));
}

/**
 * Resolves the target URL and credentials for seed/smoke:
 * a URL argument means production (secrets from env vars or .secrets.local.txt),
 * no argument means local dev (secrets from .dev.vars).
 */
export function target(urlArg) {
  if (!urlArg) {
    const vars = { ...readVars(path.join(ROOT, ".dev.vars.example")), ...readVars(DEV_VARS) };
    return { url: LOCAL_URL, ingestKey: vars.INGEST_KEY, password: vars.VIEWER_PASSWORD };
  }
  const saved = readVars(SECRETS_FILE);
  const ingestKey = process.env.INGEST_KEY ?? saved.INGEST_KEY;
  const password = process.env.VIEWER_PASSWORD ?? saved.VIEWER_PASSWORD;
  if (!ingestKey) fatal("No INGEST_KEY: set the INGEST_KEY env var or keep .secrets.local.txt from `npm run setup`.");
  return { url: urlArg.replace(/\/+$/, ""), ingestKey, password };
}

/** Logs in to the viewer API and returns a fetch wrapper that sends the cookie. */
export async function viewerClient(url, password) {
  if (!password) fatal("No VIEWER_PASSWORD: set the env var or keep .secrets.local.txt from `npm run setup`.");
  const res = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) fatal(`Viewer login failed: HTTP ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return (pathname, init = {}) => fetch(`${url}/api/v/${pathname}`, { ...init, headers: { ...init.headers, Cookie: cookie } });
}

export function ingestBatch(url, key, body) {
  return fetch(`${url}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Key": key },
    body: JSON.stringify(body),
  });
}

export function putShot(url, key, sessionId, seq, jpeg) {
  return fetch(`${url}/api/shot/${sessionId}/${seq}`, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg", "X-Ingest-Key": key },
    body: jpeg,
  });
}
