"use strict";

const os = require("node:os");
const path = require("node:path");

function loadConfiguration(env = process.env) {
  const adminBaseUrl = normalizeAdminBaseUrl(required(env, "SUB2API_ADMIN_BASE_URL"));
  const adminToken = required(env, "SUB2API_ADMIN_TOKEN");
  const adminRefreshToken = optionalSecret(env.SUB2API_ADMIN_REFRESH_TOKEN);
  const adminSessionStateFile =
    optionalPrivateStateFile(env.SUB2API_ADMIN_SESSION_STATE_FILE, "SUB2API_ADMIN_SESSION_STATE_FILE") ?? resolveDefaultAdminSessionStateFile(env);
  const queueDirectory = optionalAbsolutePath(env.SUB2API_IMPORT_QUEUE_DIR, "SUB2API_IMPORT_QUEUE_DIR") ?? resolveDefaultOutbox(env);
  const pollSeconds = normalizePollSeconds(env.SUB2API_IMPORT_POLL_SECONDS ?? "5");
  const importProxyName = normalizeLabel(env.SUB2API_IMPORT_PROXY_NAME ?? "default", "SUB2API_IMPORT_PROXY_NAME");
  const importGroupName = normalizeLabel(env.SUB2API_IMPORT_GROUP_NAME ?? "test", "SUB2API_IMPORT_GROUP_NAME");
  const importConcurrency = normalizeImportConcurrency(env.SUB2API_IMPORT_CONCURRENCY ?? "2");
  return {
    adminBaseUrl,
    adminToken,
    adminRefreshToken,
    adminSessionStateFile,
    queueDirectory,
    pollSeconds,
    importProxyName,
    importGroupName,
    importConcurrency
  };
}

function resolveDefaultOutbox(env = process.env) {
  const stateDirectory = optionalAbsolutePath(env.SESSION_INGRESS_STATE_DIR, "SESSION_INGRESS_STATE_DIR") ?? path.join(resolveStateHome(env), "codex-account-integrations");
  return path.join(stateDirectory, "sub2api-import", "outbox");
}

function resolveDefaultAdminSessionStateFile(env = process.env) {
  const stateDirectory = optionalAbsolutePath(env.SESSION_INGRESS_STATE_DIR, "SESSION_INGRESS_STATE_DIR") ?? path.join(resolveStateHome(env), "codex-account-integrations");
  return path.join(stateDirectory, "sub2api-import", "admin-session.json");
}

function normalizeAdminBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SUB2API_ADMIN_BASE_URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("SUB2API_ADMIN_BASE_URL must be an HTTP(S) service root without a path or credentials.");
  }
  return url.toString().replace(/\/$/u, "");
}

function required(env, key) {
  const value = typeof env[key] === "string" ? env[key].trim() : "";
  if (!value) {
    throw new Error(`${key} is required private configuration.`);
  }
  return value;
}

function optionalSecret(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate || undefined;
}

function optionalAbsolutePath(value, key) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return undefined;
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${key} must be an absolute private directory.`);
  }
  return path.normalize(candidate);
}

function optionalPrivateStateFile(value, key) {
  const candidate = optionalAbsolutePath(value, key);
  if (!candidate) return undefined;
  if (path.dirname(candidate) === path.parse(candidate).root) {
    throw new Error(`${key} must not place private state directly in the filesystem root.`);
  }
  return candidate;
}

function resolveStateHome(env) {
  const configured = typeof env.XDG_STATE_HOME === "string" ? env.XDG_STATE_HOME.trim() : "";
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), ".local", "state");
}

function normalizePollSeconds(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error("SUB2API_IMPORT_POLL_SECONDS must be an integer from 1 to 3600.");
  }
  return seconds;
}

function normalizeImportConcurrency(value) {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error("SUB2API_IMPORT_CONCURRENCY must be an integer from 1 to 100.");
  }
  return concurrency;
}

function normalizeLabel(value, key) {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label) {
    throw new Error(`${key} must be a non-empty private setting.`);
  }
  return label;
}

module.exports = { loadConfiguration, normalizeAdminBaseUrl, resolveDefaultAdminSessionStateFile, resolveDefaultOutbox };
