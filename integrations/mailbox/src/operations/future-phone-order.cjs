"use strict";

const {
  Sms688Client,
  Sms688OrderError,
  Sms688PhoneOrderSession
} = require("./sms688-phone-order.cjs");

const DEFAULT_BASE_URL = "https://sms.futurepixelai.com/api/v1/manual-sms";
const DEFAULT_AUTH_BASE_URL = "https://sms.futurepixelai.com/api/v1/auth";
const DEFAULT_PURCHASE_URL = "https://www.16688.com.cn/shop/AIAISHARE";

class FutureOrderError extends Sms688OrderError {
  constructor(message, options) {
    super(message, options);
    this.name = "FutureOrderError";
  }
}

class FutureClient extends Sms688Client {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    authBaseUrl = DEFAULT_AUTH_BASE_URL,
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30000,
    onLog = () => {}
  } = {}) {
    super({
      baseUrl,
      token,
      fetchImpl,
      timeoutMs,
      onLog,
      providerName: "Future",
      credentialLabel: "Session Token",
      requestIdPrefix: "future",
      errorClass: FutureOrderError
    });
    this.authBaseUrl = text(authBaseUrl).replace(/\/+$/u, "") || DEFAULT_AUTH_BASE_URL;
  }

  async redeem(cdk) {
    const code = text(cdk);
    if (!code) throw new FutureOrderError("请填写 Future CDK", { code: "MISSING_CDK" });
    const requestUrl = `${this.authBaseUrl}/redeem`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.onLog("info", "Future 请求 POST /api/v1/auth/redeem");
    try {
      const response = await this.fetchImpl(requestUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({ code }),
        signal: controller.signal
      });
      const raw = typeof response.text === "function"
        ? await response.text()
        : typeof response.json === "function"
          ? JSON.stringify(await response.json())
          : "";
      const payload = parsePayload(raw);
      if (!response.ok) {
        const message = responseMessage(payload) || `HTTP ${response.status}`;
        const safeMessage = safeError(message, code);
        this.onLog("error", `Future 兑换失败 HTTP ${response.status}：${safeMessage}`);
        throw new FutureOrderError(safeMessage, { status: response.status, code: responseCode(payload) });
      }
      const sessionToken = extractSessionToken(payload);
      if (!sessionToken) {
        throw new FutureOrderError("Future 未返回有效 Session Token", { code: "MISSING_SESSION_TOKEN" });
      }
      return sessionToken;
    } catch (error) {
      if (error instanceof FutureOrderError) throw error;
      this.onLog("error", "Future 兑换请求失败");
      throw new FutureOrderError(
        error?.name === "AbortError" ? "Future 兑换请求超时" : "Future 兑换请求失败",
        { code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK" }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async redeemCdk(cdk) {
    return this.redeem(cdk);
  }
}

class FuturePhoneOrderSession extends Sms688PhoneOrderSession {
  constructor(options = {}) {
    const baseUrl = text(options.baseUrl) || DEFAULT_BASE_URL;
    const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : undefined;
    const clientFactory = options.clientFactory || ((token) => new FutureClient({
      baseUrl,
      token,
      fetchImpl,
      timeoutMs: options.timeoutMs,
      onLog: (level, message) => options.onLog?.(level, message)
    }));
    super({
      ...options,
      baseUrl,
      sourceId: options.sourceId || "future",
      providerName: "Future",
      credentialLabel: "Session Token",
      errorClass: FutureOrderError,
      clientFactory
    });
  }
}

function extractSessionToken(payload) {
  if (!payload || typeof payload !== "object") return "";
  const containers = [payload, payload.data, payload.result].filter((value) => value && typeof value === "object");
  for (const container of containers) {
    const token = text(container.session_token || container.sessionToken || container.token);
    if (token) return token;
  }
  return "";
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
  return text(payload.detail || payload.error || payload.message || payload.reason);
}

function responseCode(payload) {
  if (!payload || typeof payload !== "object") return "";
  return text(payload.code || payload.error_code || payload.reasonCode || payload.reason_code);
}

function safeError(error, secret = "") {
  let message = error instanceof Error ? error.message : text(error);
  if (secret) message = message.split(secret).join("[已隐藏]");
  return (message || "Future 兑换请求失败").replace(/[\r\n\t]+/gu, " ").slice(0, 180);
}

function text(value) {
  return String(value ?? "").trim();
}

module.exports = {
  DEFAULT_AUTH_BASE_URL,
  DEFAULT_BASE_URL,
  DEFAULT_PURCHASE_URL,
  FutureClient,
  FutureOrderError,
  FuturePhoneOrderSession,
  extractSessionToken
};
