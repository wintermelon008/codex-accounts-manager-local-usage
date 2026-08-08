"use strict";

const IMPORT_PATH = "/api/v1/admin/accounts/data";
const REQUEST_TIMEOUT_MS = 30_000;

async function submitSub2ApiImport(configuration, payload, options = {}) {
  const client = await createSub2ApiAdminClient(configuration, options);
  return client.importPayload(payload);
}

async function createSub2ApiAdminClient(configuration, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function requestJson(path, request = {}) {
    const result = await sendRequest(path, request);
    if (!result.response.ok) {
      throw new Sub2ApiImportError("remoteRejected", result.response.status);
    }
    if (result.body === undefined) {
      throw new Sub2ApiImportError("invalidResponse", result.response.status);
    }
    return unwrapEnvelope(result.body, result.response.status);
  }

  async function sendRequest(path, request) {
    const headers = {
      accept: "application/json",
      "x-api-key": configuration.adminApiKey,
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
    super(Number.isInteger(statusCode) ? `Sub2API request failed with HTTP ${statusCode}.` : "Sub2API request failed.");
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

module.exports = {
  IMPORT_PATH,
  Sub2ApiImportError,
  createSub2ApiAdminClient,
  submitSub2ApiImport,
  summarizeImportResult,
  validatePayload
};
