"use strict";

const DEFAULT_BASE_URL = "https://bugteam.team";

class BugTeamApiError extends Error {
  constructor(message, { status, code, payload, retryAfterMs } = {}) {
    super(message);
    this.name = "BugTeamApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.retryAfterMs = retryAfterMs;
  }
}

class BugTeamClient {
  constructor({ token, fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("BugTeam API client requires fetch");
    }
    const normalizedToken = typeof token === "string" ? token.trim() : "";
    if (!normalizedToken) {
      throw new Error("BugTeam API Token is not configured");
    }
    this.token = normalizedToken;
    this.fetchImpl = fetchImpl;
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  getDashboard() {
    return this.request("/api/customer/dashboard");
  }

  getBalance() {
    return this.request("/api/customer/balance");
  }

  getInventory(product, quantity = 1, expiryBucketStart) {
    const params = new URLSearchParams({ product: String(product), quantity: String(quantity) });
    const bucketStart = typeof expiryBucketStart === "string" ? expiryBucketStart.trim() : "";
    if (bucketStart) params.set("expiry_bucket_start", bucketStart);
    return this.request(`/api/customer/inventory?${params.toString()}`);
  }

  getInventoryShelves(product) {
    const params = new URLSearchParams({ product: String(product) });
    return this.request(`/api/customer/inventory/shelves?${params.toString()}`);
  }

  createPickupOrder({ product, quantity = 1, idempotencyKey, expiryBucketStart }) {
    const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
    if (!key) {
      throw new Error("BugTeam order idempotency key is required");
    }
    const body = { product, quantity };
    const bucketStart = typeof expiryBucketStart === "string" ? expiryBucketStart.trim() : "";
    if (bucketStart) body.expiry_bucket_start = bucketStart;
    return this.request("/api/customer/pickup/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body)
    });
  }

  getPickupOrder(orderId) {
    return this.request(`/api/customer/pickup/orders/${encodeURIComponent(String(orderId))}`);
  }

  downloadSub2(orderId) {
    return this.request(`/api/customer/pickup/orders/${encodeURIComponent(String(orderId))}/download?format=sub2`);
  }

  async request(pathname, options = {}) {
    const headers = new Headers(options.headers ?? {});
    headers.set("Accept", "application/json");
    headers.set("X-Customer-Token", this.token);
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, { ...options, headers });
    const payload = await readPayload(response);
    if (!response.ok) {
      throw new BugTeamApiError(resolveApiErrorMessage(response.status, payload), {
        status: response.status,
        code: readString(payload?.code),
        payload,
        retryAfterMs: parseRetryAfter(response.headers?.get?.("Retry-After"))
      });
    }
    return payload;
  }
}

function normalizeBaseUrl(value) {
  const input = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("BugTeam API base URL is invalid");
  }
  const localDevelopmentHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(localDevelopmentHost && url.protocol === "http:")) {
    throw new Error("BugTeam API base URL must use HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function resolveApiErrorMessage(status, payload) {
  const code = readString(payload?.code);
  if (status === 401) return "BugTeam Token 无效或已过期";
  if (status === 402) return "BugTeam 可用余额不足，订单未创建";
  if (status === 409) return "BugTeam 返回订单或幂等状态冲突，请重新查询订单状态";
  if (status === 429) return "BugTeam 请求过于频繁，请稍后重试";
  if (status >= 500) return "BugTeam 服务暂不可用，请稍后重试";
  return code ? `BugTeam API 请求失败（${code}）` : `BugTeam API 请求失败（HTTP ${status}）`;
}

function parseRetryAfter(value) {
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10 * 60 * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(timestamp - Date.now(), 10 * 60 * 1000)) : undefined;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

module.exports = { BugTeamApiError, BugTeamClient, DEFAULT_BASE_URL, normalizeBaseUrl, parseRetryAfter };
