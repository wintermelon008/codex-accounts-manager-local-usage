"use strict";

const {
  Sms688OrderError,
  Sms688PhoneOrderSession
} = require("./sms688-phone-order.cjs");

const DEFAULT_BASE_URL = "http://miaoic.shop";

class MiaoicOrderError extends Sms688OrderError {
  constructor(message, options) {
    super(message, options);
    this.name = "MiaoicOrderError";
  }
}

class MiaoicClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30000,
    onLog = () => {}
  } = {}) {
    if (typeof fetchImpl !== "function") throw new MiaoicOrderError("当前 Node 环境不支持网络请求");
    this.baseUrl = text(baseUrl).replace(/\/+$/u, "") || DEFAULT_BASE_URL;
    this.token = text(token);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onLog = typeof onLog === "function" ? onLog : () => {};
    this.lastState = null;
  }

  async request(method, path) {
    if (!this.token) throw new MiaoicOrderError("缺少 Miaoic Token", { code: "MISSING_TOKEN" });
    if (/[\r\n;,]/u.test(this.token)) throw new MiaoicOrderError("Miaoic Token 包含无效字符", { code: "INVALID_TOKEN" });
    const requestUrl = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.onLog("info", `Miaoic 请求 ${method} ${path}`);
    try {
      const response = await this.fetchImpl(requestUrl, {
        method,
        headers: {
          accept: "application/json",
          "cache-control": "no-cache, no-store, max-age=0",
          cookie: `bj_user=${this.token}`,
          referer: `${this.baseUrl}/?tab=recv`,
          "x-requested-with": "fetch"
        },
        signal: controller.signal
      });
      const raw = typeof response.text === "function"
        ? await response.text()
        : typeof response.json === "function"
          ? JSON.stringify(await response.json())
          : "";
      const payload = parsePayload(raw);
      if (!response.ok || payload?.ok === false) {
        const message = responseMessage(payload) || `HTTP ${response.status}`;
        this.onLog("error", `Miaoic 响应 ${method} ${path} 失败：${safeError(message, this.token)}`);
        throw new MiaoicOrderError(message, { status: response.status, code: responseCode(payload) });
      }
      return payload;
    } catch (error) {
      if (error instanceof MiaoicOrderError) throw error;
      this.onLog("error", `Miaoic 网络请求失败 ${method} ${path}`);
      throw new MiaoicOrderError(
        error?.name === "AbortError" ? "Miaoic 请求超时" : "Miaoic 网络请求失败",
        { code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK" }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async profile() {
    const state = await this.request("GET", "/recv/state");
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new MiaoicOrderError("Miaoic 未返回账户状态");
    }
    this.lastState = state;
    const balance = finiteOrNull(state?.balance);
    return {
      ...state,
      quota: {
        available_uses: balance,
        remaining_uses: balance
      }
    };
  }

  async createLease() {
    const current = this.lastState;
    this.lastState = null;
    if (current?.active === true || current?.can_release === true) {
      return normalizeMiaoicState(current, "Miaoic 未返回有效号码", "state");
    }
    return normalizeMiaoicState(await this.request("POST", "/recv/open"), "Miaoic 未返回有效号码", "open");
  }

  async orderStatus() {
    return normalizeMiaoicState(await this.request("GET", "/recv/state"), "Miaoic 未返回有效状态", "state");
  }

  async changeLease() {
    return normalizeMiaoicState(await this.request("POST", "/recv/switch"), "Miaoic 未返回换号结果", "switch");
  }

  async releaseLease() {
    return normalizeMiaoicState(await this.request("POST", "/recv/release"), "Miaoic 未返回释放结果", "release");
  }
}

class MiaoicPhoneOrderSession extends Sms688PhoneOrderSession {
  constructor(options = {}) {
    const baseUrl = text(options.baseUrl) || DEFAULT_BASE_URL;
    const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : undefined;
    const clientFactory = options.clientFactory || ((token) => new MiaoicClient({
      baseUrl,
      token,
      fetchImpl,
      timeoutMs: options.timeoutMs,
      onLog: (level, message) => options.onLog?.(level, message)
    }));
    super({
      ...options,
      baseUrl,
      sourceId: options.sourceId || "miaoic",
      providerName: "Miaoic",
      credentialLabel: "Token",
      errorClass: MiaoicOrderError,
      clientFactory
    });
  }
}

function normalizeMiaoicState(payload, fallbackMessage, action) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MiaoicOrderError(fallbackMessage);
  }
  const phone = text(payload.phone || payload.phone_number || payload.phoneNumber);
  const smsCode = text(payload.code || payload.sms_code || payload.smsCode);
  const status = smsCode
    ? "code_received"
    : action === "release"
      ? "cancelled"
      : payload.active === true
        ? "waiting_code"
        : "complete";
  return {
    ...payload,
    id: "miaoic",
    job_id: "miaoic",
    status,
    phone,
    sms_code: smsCode,
    can_change: payload.can_switch === undefined ? payload.active === true : Boolean(payload.can_switch),
    can_release: payload.can_release === undefined ? payload.active === true : Boolean(payload.can_release)
  };
}

function parsePayload(raw) {
  const value = text(raw);
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function responseMessage(payload) {
  if (typeof payload === "string") return payload.trim();
  if (!payload || typeof payload !== "object") return "";
  return text(payload.msg || payload.error || payload.message || payload.detail || payload.reason);
}

function responseCode(payload) {
  if (!payload || typeof payload !== "object") return "";
  return text(payload.code || payload.error_code || payload.reasonCode || payload.reason_code);
}

function safeError(error, secret = "") {
  let message = error instanceof Error ? error.message : text(error);
  if (secret) message = message.split(secret).join("[已隐藏]");
  return (message || "Miaoic 请求失败").replace(/[\r\n\t]+/gu, " ").slice(0, 180);
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  return String(value ?? "").trim();
}

module.exports = {
  DEFAULT_BASE_URL,
  MiaoicClient,
  MiaoicOrderError,
  MiaoicPhoneOrderSession,
  normalizeMiaoicState
};
