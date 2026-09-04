import os from "node:os";
import path from "node:path";

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 43118;
const DEFAULT_MANAGER_CONTROL_URL = "http://127.0.0.1:43117";
const DEFAULT_GATEWAY_STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "codex-accounts-manager",
  "gateway"
);

export function loadConfig(env = process.env) {
  const host = optional(env.MANAGER_GATEWAY_HOST) ?? DEFAULT_GATEWAY_HOST;
  const gatewayToken = optional(env.MANAGER_GATEWAY_TOKEN);
  if (!isLoopbackHost(host) && !gatewayToken) {
    throw new Error("MANAGER_GATEWAY_TOKEN is required when MANAGER_GATEWAY_HOST is not loopback");
  }

  const stateDir = optional(env.MANAGER_GATEWAY_STATE_DIR) ?? DEFAULT_GATEWAY_STATE_DIR;
  const codexHome = optional(env.MANAGER_GATEWAY_CODEX_HOME ?? env.CODEX_HOME);
  if (codexHome && !path.isAbsolute(codexHome)) {
    throw new Error("MANAGER_GATEWAY_CODEX_HOME must be an absolute path when configured");
  }
  return {
    server: {
      host,
      port: parsePort(env.MANAGER_GATEWAY_PORT, DEFAULT_GATEWAY_PORT),
      token: gatewayToken,
      corsOrigin: optional(env.MANAGER_GATEWAY_CORS_ORIGIN) ?? (isLoopbackHost(host) ? "*" : undefined),
      stateDir
    },
    manager: {
      baseUrl: normalizeBaseUrl(env.MANAGER_CONTROL_URL ?? DEFAULT_MANAGER_CONTROL_URL, "MANAGER_CONTROL_URL"),
      token: optional(env.MANAGER_CONTROL_TOKEN ?? env.CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN),
      timeoutMs: parseBoundedInteger(env.MANAGER_CONTROL_TIMEOUT_MS, 10_000, 1_000, 120_000)
    },
    codex: {
      binary: optional(env.MANAGER_GATEWAY_CODEX_BINARY) ?? "codex",
      home: codexHome,
      projectRoot: optional(env.MANAGER_GATEWAY_PROJECT_ROOT),
      timeoutSeconds: parseBoundedInteger(env.MANAGER_GATEWAY_CODEX_TIMEOUT_SECONDS, 1_800, 10, 86_400)
    },
    research: {
      baseUrl: optional(env.MANAGER_GATEWAY_RESEARCH_BASE_URL)
        ? normalizeBaseUrl(env.MANAGER_GATEWAY_RESEARCH_BASE_URL, "MANAGER_GATEWAY_RESEARCH_BASE_URL")
        : undefined,
      apiKey: optional(env.MANAGER_GATEWAY_RESEARCH_API_KEY),
      model: optional(env.MANAGER_GATEWAY_RESEARCH_MODEL) ?? "gpt-5.6"
    },
    maxSessions: parseBoundedInteger(env.MANAGER_GATEWAY_MAX_SESSIONS, 4, 1, 32)
  };
}

export function normalizeBaseUrl(value, name) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error(`${name} must be a valid http(s) URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an http(s) URL without credentials, query, or hash`);
  }
  return url.toString().replace(/\/+$/u, "");
}

export function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function optional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePort(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("MANAGER_GATEWAY_PORT must be an integer from 1 to 65535; use the default fixed port for browser access");
  }
  return parsed;
}

function parseBoundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
