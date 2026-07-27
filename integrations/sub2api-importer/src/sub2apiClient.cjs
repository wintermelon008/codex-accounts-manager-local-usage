"use strict";

const { readRefreshToken, writeRefreshToken } = require("./adminSession.cjs");

const IMPORT_PATH = "/api/v1/admin/accounts/data";
const REFRESH_PATH = "/api/v1/auth/refresh";
const REQUEST_TIMEOUT_MS = 30_000;

async function submitSub2ApiImport(configuration, payload, options = {}) {
  const client = await createSub2ApiAdminClient(configuration, options);
  return client.importPayload(payload);
}

async function createSub2ApiAdminClient(configuration, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const loadRefreshToken = options.loadRefreshToken ?? readRefreshToken;
  const saveRefreshToken = options.saveRefreshToken ?? writeRefreshToken;
  let accessToken = configuration.adminToken;
  let refreshToken = configuration.adminRefreshToken;
  try {
    const saved = await loadRefreshToken(configuration.adminSessionStateFile);
    if (saved) refreshToken = saved;
  } catch {
    throw new Sub2ApiImportError("sessionStateFailure");
  }

  async function requestJson(path, request = {}) {
    let result = await sendRequest(path, request, accessToken);
    if (isExpiredTokenResponse(result.response, result.body) && refreshToken) {
      const refreshed = await refreshAccessToken();
      accessToken = refreshed.accessToken;
      result = await sendRequest(path, request, accessToken);
    }
    if (!result.response.ok) {
      throw new Sub2ApiImportError("remoteRejected", result.response.status);
    }
    if (result.body === undefined) {
      throw new Sub2ApiImportError("invalidResponse", result.response.status);
    }
    return unwrapEnvelope(result.body, result.response.status);
  }

  async function sendRequest(path, request, token) {
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "x-admin-ui-request": "1",
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      ...(request.headers ?? {})
    };
    const response = await requestWithTimeout(fetchImpl, `${configuration.adminBaseUrl}${path}`, {
      method: request.method ?? "GET",
      headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
    });
    return { response, body: await readJson(response) };
  }

  async function refreshAccessToken() {
    const response = await requestWithTimeout(fetchImpl, `${configuration.adminBaseUrl}${REFRESH_PATH}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    const body = await readJson(response);
    if (!response.ok || !body || typeof body !== "object" || Array.isArray(body) || body.code !== 0 || !body.data || typeof body.data !== "object") {
      throw new Sub2ApiImportError("tokenRefreshFailed", response.status);
    }
    const nextAccessToken = nonemptyString(body.data.access_token);
    const nextRefreshToken = nonemptyString(body.data.refresh_token);
    if (!nextAccessToken) {
      throw new Sub2ApiImportError("tokenRefreshFailed", response.status);
    }
    if (nextRefreshToken && nextRefreshToken !== refreshToken) {
      try {
        await saveRefreshToken(configuration.adminSessionStateFile, nextRefreshToken);
      } catch {
        throw new Sub2ApiImportError("sessionStateFailure");
      }
      refreshToken = nextRefreshToken;
    }
    return { accessToken: nextAccessToken };
  }

  return {
    getJson: (path) => requestJson(path),
    importPayload: async (payload) => {
      validatePayload(payload);
      const data = await requestJson(IMPORT_PATH, {
        method: "POST",
        body: { data: payload, skip_default_group_bind: true }
      });
      return { statusCode: 200, ...summarizeImportResult(data) };
    },
    putJson: (path, body) => requestJson(path, { method: "PUT", body })
  };
}

class Sub2ApiImportError extends Error {
  constructor(kind, statusCode) {
    super("The Sub2API import request did not complete safely.");
    this.name = "Sub2ApiImportError";
    this.kind = kind;
    this.statusCode = Number.isInteger(statusCode) ? statusCode : undefined;
  }
}

async function requestWithTimeout(fetchImpl, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch {
    throw new Sub2ApiImportError("transportFailure");
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isExpiredTokenResponse(response, body) {
  return response.status === 401 && body && typeof body === "object" && !Array.isArray(body) && body.code === "TOKEN_EXPIRED";
}

function unwrapEnvelope(value, statusCode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Sub2ApiImportError("invalidResponse", statusCode);
  }
  if (Object.prototype.hasOwnProperty.call(value, "code")) {
    if (value.code !== 0) throw new Sub2ApiImportError("remoteRejected", statusCode);
    return value.data;
  }
  return value;
}

function summarizeImportResult(value) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    accountCreated: nonNegativeInteger(record.account_created) ?? 0,
    accountFailed: nonNegativeInteger(record.account_failed) ?? 0,
    proxyCreated: nonNegativeInteger(record.proxy_created) ?? 0,
    proxyReused: nonNegativeInteger(record.proxy_reused) ?? 0,
    proxyFailed: nonNegativeInteger(record.proxy_failed) ?? 0
  };
}

function validatePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Sub2ApiImportError("invalidPayload");
  }
  if (![
    "sub2api-data",
    "sub2api-bundle"
  ].includes(value.type) || value.version !== 1 || !Array.isArray(value.proxies) || !Array.isArray(value.accounts) || value.accounts.length === 0) {
    throw new Sub2ApiImportError("invalidPayload");
  }
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

module.exports = {
  IMPORT_PATH,
  REFRESH_PATH,
  Sub2ApiImportError,
  createSub2ApiAdminClient,
  submitSub2ApiImport,
  summarizeImportResult,
  validatePayload
};
