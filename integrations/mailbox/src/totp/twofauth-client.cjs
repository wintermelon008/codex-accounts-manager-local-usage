"use strict";

const DEFAULT_TIMEOUT_MS = 15_000;
const OTPAUTH_URI_PATTERN = /^otpauth:\/\/(totp|hotp)\//iu;
const BASE32_SECRET_PATTERN = /^[A-Z2-7]+=*$/u;

class TwoFAuthClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = normalizeToken(token);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required");
    }
    this.fetchImpl = fetchImpl;
    this.timeoutMs = normalizeTimeout(timeoutMs);
  }

  async listAccounts({ signal } = {}) {
    const payload = await this.request("/api/v1/twofaccounts", { signal });
    return normalizeCollection(payload).map(sanitizeAccount);
  }

  async getOtp(accountId, { signal } = {}) {
    const id = normalizeAccountId(accountId);
    const payload = await this.request(`/api/v1/twofaccounts/${encodeURIComponent(id)}/otp`, { signal });
    return sanitizeOtp(payload);
  }

  async deleteAccount(accountId) {
    const id = normalizeAccountId(accountId);
    await this.request(`/api/v1/twofaccounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    return true;
  }

  async createAccount({ uri, secret, label, account } = {}) {
    const normalizedUri = normalizeOtpauthUri(uri);
    const normalizedSecret = normalizeSecret(secret);
    let body;
    if (normalizedUri) {
      body = { uri: normalizedUri };
    } else if (normalizedSecret) {
      body = { uri: createTotpUri({ secret: normalizedSecret, label, account }) };
    } else {
      throw new Error("请粘贴 otpauth:// URI 或填写 Base32 secret");
    }

    const payload = await this.request("/api/v1/twofaccounts", {
      method: "POST",
      body
    });
    return sanitizeAccount(payload?.data || payload);
  }

  async request(pathname, { method = "GET", body, signal } = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    let abortedByCaller = false;
    const abortFromCaller = () => {
      abortedByCaller = true;
      controller?.abort();
    };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
    const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...((controller ? { signal: controller.signal } : signal ? { signal } : {}))
      });
      const text = await response.text();
      let payload;
      if (text.trim()) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = undefined;
        }
      }
      if (!response.ok) {
        throw new Error(messageForStatus(response.status));
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(abortedByCaller ? "2FAuth 请求已取消" : "2FAuth 请求超时");
      }
      throw error instanceof Error ? error : new Error("2FAuth 请求失败");
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abortFromCaller);
    }
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("2FAuth 地址不能为空");
  }
  const candidate = value.trim().replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("2FAuth 地址无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("2FAuth 地址必须是 http(s) URL，且不能包含凭据、查询参数或片段");
  }
  return candidate;
}

function normalizeToken(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("2FAuth Personal Access Token 不能为空");
  }
  return value.trim();
}

function normalizeTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) ? Math.max(1_000, Math.min(120_000, Math.floor(timeout))) : DEFAULT_TIMEOUT_MS;
}

function normalizeAccountId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 160 || /[\r\n]/u.test(id)) {
    throw new Error("2FAuth 条目 ID 无效");
  }
  return id;
}

function normalizeOtpauthUri(value) {
  const uri = typeof value === "string" ? value.trim() : "";
  if (!uri) return "";
  if (uri.length > 4096 || !OTPAUTH_URI_PATTERN.test(uri)) {
    throw new Error("otpauth URI 无效，仅支持 otpauth://totp 或 otpauth://hotp");
  }
  return uri;
}

function normalizeSecret(value) {
  const secret = typeof value === "string" ? value.replace(/[\s-]+/gu, "").toUpperCase() : "";
  if (!secret) return "";
  if (secret.length > 256 || !BASE32_SECRET_PATTERN.test(secret)) {
    throw new Error("Base32 secret 无效");
  }
  return secret;
}

function createTotpUri({ secret, label, account } = {}) {
  const issuer = "OpenAI";
  const normalizedAccount = typeof account === "string" && account.trim() ? account.trim() : "account";
  const normalizedLabel = typeof label === "string" && label.trim() ? label.trim() : normalizedAccount;
  const pathLabel = `${issuer}:${normalizedLabel}`;
  return `otpauth://totp/${encodeURIComponent(pathLabel)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function normalizeCollection(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function sanitizeAccount(value) {
  const account = value && typeof value === "object" ? value : {};
  const sanitized = {
    id: String(account.id ?? "").trim(),
    service: safeText(account.service),
    account: safeText(account.account),
    otpType: safeText(account.otp_type || account.otpType),
    digits: finiteInteger(account.digits),
    algorithm: safeText(account.algorithm),
    period: finiteInteger(account.period),
    counter: finiteInteger(account.counter)
  };
  const createdAt = timestampValue(account.created_at ?? account.createdAt);
  const updatedAt = timestampValue(account.updated_at ?? account.updatedAt);
  if (createdAt !== undefined) sanitized.createdAt = createdAt;
  if (updatedAt !== undefined) sanitized.updatedAt = updatedAt;
  if (account.otp && typeof account.otp === "object") {
    sanitized.otp = sanitizeOtp(account.otp);
  }
  return sanitized;
}

function sanitizeOtp(value) {
  const otp = value && typeof value === "object" ? value : {};
  return {
    code: normalizeOtpCode(otp.password ?? otp.code),
    nextCode: normalizeOtpCode(otp.next_password ?? otp.nextCode),
    generatedAt: finiteInteger(otp.generated_at ?? otp.generatedAt),
    period: finiteInteger(otp.period)
  };
}

function normalizeOtpCode(value) {
  const code = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^\d{6,10}$/u.test(code) ? code : "";
}

function safeText(value) {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 160) : "";
}

function finiteInteger(value) {
  return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : undefined;
}

function timestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 100000000000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0 && numeric < 100000000000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function messageForStatus(status) {
  if (status === 401 || status === 403) return "2FAuth 访问令牌无效或权限不足";
  if (status === 404) return "2FAuth API 地址不存在，请检查服务地址";
  if (status === 422) return "2FAuth 拒绝了请求，请检查 TOTP 参数";
  return `2FAuth 请求失败（HTTP ${Number(status) || 0}）`;
}

module.exports = {
  TwoFAuthClient,
  createTotpUri,
  normalizeBaseUrl,
  normalizeOtpauthUri,
  normalizeSecret,
  sanitizeAccount,
  sanitizeOtp
};
