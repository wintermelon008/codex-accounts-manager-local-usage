"use strict";

const TINGBAI_BASE_URL = "https://tingbai.top";
const STORE_PATH = "/bugteam-api/store";

class TingbaiApiError extends Error {
  constructor(message, { status, code, payload, retryAfterMs } = {}) {
    super(message);
    this.name = "TingbaiApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.retryAfterMs = retryAfterMs;
  }
}

class TingbaiClient {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = TINGBAI_BASE_URL } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("Tingbai client requires fetch");
    this.fetchImpl = fetchImpl;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.cookies = new Map();
    this.csrfToken = "";
  }

  get authenticated() {
    return Boolean(this.csrfToken && this.cookies.size);
  }

  clearSession() {
    this.cookies.clear();
    this.csrfToken = "";
  }

  getCatalog() {
    return this.request(`${STORE_PATH}/catalog`);
  }

  async login(username, password) {
    this.clearSession();
    const payload = await this.request(`${STORE_PATH}/buyer/login`, {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    const csrfToken = readString(payload?.csrf_token);
    if (!csrfToken || !this.cookies.size) {
      this.clearSession();
      throw new TingbaiApiError("登录响应缺少会话信息");
    }
    this.csrfToken = csrfToken;
    return payload;
  }

  getWallet() {
    return this.buyerRequest(`${STORE_PATH}/buyer/wallet?limit=1`);
  }

  getQuote(product, quantity = 1) {
    return this.request(`${STORE_PATH}/quote`, {
      method: "POST",
      body: JSON.stringify({ product, quantity })
    });
  }

  createOrder({ product, quantity = 1, expectedUnitPriceFen, expectedTotalFen, quoteId, idempotencyKey }) {
    const body = {
      product,
      quantity,
      expected_unit_price_fen: expectedUnitPriceFen,
      expected_total_fen: expectedTotalFen
    };
    if (quoteId) body.quote_id = quoteId;
    return this.buyerRequest(`${STORE_PATH}/orders`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body)
    });
  }

  getOrder(orderId) {
    return this.buyerRequest(`${STORE_PATH}/buyer/orders/${encodeURIComponent(String(orderId))}`);
  }

  downloadSub2(orderId) {
    return this.buyerRequest(
      `${STORE_PATH}/buyer/orders/${encodeURIComponent(String(orderId))}/download?format=sub2`
    );
  }

  buyerRequest(pathname, options = {}) {
    if (!this.authenticated) throw new TingbaiApiError("请先登录买家账户", { status: 401, code: "buyer_login_required" });
    const method = String(options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers ?? {});
    if (method !== "GET" && method !== "HEAD") headers.set("X-CSRF-Token", this.csrfToken);
    return this.request(pathname, { ...options, headers });
  }

  async request(pathname, options = {}) {
    if (!pathname.startsWith(`${STORE_PATH}/`)) throw new TingbaiApiError("Tingbai 请求路径无效");
    const headers = new Headers(options.headers ?? {});
    headers.set("Accept", "application/json");
    headers.set("Origin", this.baseUrl);
    headers.set("Referer", `${this.baseUrl}/bugteam/`);
    if (options.body) headers.set("Content-Type", "application/json");
    const cookie = this.cookieHeader();
    if (cookie) headers.set("Cookie", cookie);

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...options,
      headers,
      cache: "no-store"
    });
    this.updateCookies(response.headers);
    const payload = await readPayload(response);
    if (!response.ok) {
      const code = readString(payload?.error) ?? readString(payload?.code);
      throw new TingbaiApiError(resolveErrorMessage(response.status, code, payload), {
        status: response.status,
        code,
        payload,
        retryAfterMs: parseRetryAfter(response.headers?.get?.("Retry-After"))
      });
    }
    return payload;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  updateCookies(headers) {
    const values = typeof headers?.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookieHeader(headers?.get?.("set-cookie"));
    for (const value of values) {
      const match = String(value).match(/^\s*([^=;\s]+)=([^;]*)/u);
      if (!match) continue;
      if (!match[2] || /(?:^|;)\s*Max-Age=0(?:;|$)/iu.test(value)) this.cookies.delete(match[1]);
      else this.cookies.set(match[1], match[2]);
    }
  }
}

function normalizeBaseUrl(value) {
  const input = typeof value === "string" && value.trim() ? value.trim() : TINGBAI_BASE_URL;
  const url = new URL(input);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Tingbai base URL must use HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}

function splitSetCookieHeader(value) {
  if (typeof value !== "string" || !value) return [];
  return value.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/u);
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function resolveErrorMessage(status, code, payload) {
  if (code === "invalid_credentials") return "买家账号或密码错误";
  if (code === "buyer_login_required" || status === 401) return "买家登录已失效";
  if (code === "stock_unavailable" || code === "insufficient_stock") return "商品已售罄";
  if (code === "quote_changed" || code === "quote_expired") return "商品报价已变化";
  if (code === "balance_insufficient" || status === 402) return "买家余额不足";
  if (status === 429) return "请求过于频繁，请稍后重试";
  if (status >= 500) return "超级炸弹车服务暂不可用";
  const message = readString(payload?.message);
  return message && message.length <= 160 ? message : `超级炸弹车请求失败（HTTP ${status}）`;
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

module.exports = {
  STORE_PATH,
  TINGBAI_BASE_URL,
  TingbaiApiError,
  TingbaiClient,
  normalizeBaseUrl
};
