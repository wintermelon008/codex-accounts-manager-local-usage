"use strict";

const { normalizeMailboxAccount, normalizeMailboxAddress } = require("../account.cjs");
const { toSafeError } = require("../errors.cjs");
const { normalizeMessage } = require("../messages.cjs");
const { createMailboxProvider } = require("../provider.cjs");

const CDNS_PROVIDER_ID = "cdns";
const CDNS_BASE_URL = "https://ai.cdns.ccwu.cc";
const CDNS_PUBLIC_PROXY_PATH = "/api/card-withdraw/public-proxy";
const CDNS_SOURCE_RESOLVE_PATH = `${CDNS_PUBLIC_PROXY_PATH}/account-sources/resolve`;
const CDNS_RECEIVE_PATH = `${CDNS_PUBLIC_PROXY_PATH}/mail/receive`;
const CDNS_DELIMITER = "----";
const CDNS_MAX_MESSAGES = 1;
const CDNS_DEFAULT_TIMEOUT_MS = 30_000;
const CDNS_CODE_PATTERN = /^\d{6}$/u;

class CdnsProvider {
  constructor({ baseUrl = CDNS_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = CDNS_DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("A fetch implementation is required for the mailbox provider");
    }
    this.baseUrl = new URL(baseUrl).toString().replace(/\/$/u, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = normalizeTimeout(timeoutMs);
  }

  asProvider() {
    return createMailboxProvider({
      id: CDNS_PROVIDER_ID,
      displayName: "cdns",
      capabilities: { history: "latest", maxMessages: CDNS_MAX_MESSAGES, manualRenewal: false },
      importSchema: {
        label: "邮箱----密码----接码令牌----public_ref",
        description: "每行一个 CDNS 四段账号；凭据只保存在 Mailbox 私有存储中。",
        placeholder: "email@example.com----password----receive_token----public_ref"
      },
      parseImport: (input) => parseCdnsImport(input),
      query: (account, options) => this.query(account, options)
    });
  }

  async query(input, { signal } = {}) {
    const account = normalizeInput(input);
    if (!account.ok) {
      return invalidResult(account.error);
    }

    try {
      const source = await this.resolveSource(account.value, { signal });
      if (!source.ok) {
        return failedResult(account.value, source.error);
      }

      const data = await this.postJson(CDNS_RECEIVE_PATH, {
        email: account.value.address,
        password: account.value.credentials.password,
        receive_token: account.value.credentials.receiveToken,
        public_ref: account.value.credentials.publicRef,
        source_upstream_key: source.sourceUpstreamKey
      }, { signal });
      if (data?.success !== true) {
        return failedResult(account.value, mapCdnsError(data));
      }

      const code = normalizeCdnsCode(data.code);
      const message = normalizeCdnsMessage(data, account.value, code);
      const messages = message ? [message] : [];
      const codes = [...new Set([...(code ? [code] : []), ...messages.flatMap((entry) => entry.codes)])];
      return {
        ok: true,
        providerId: CDNS_PROVIDER_ID,
        address: account.value.address,
        messages,
        codes,
        fetchedAt: new Date().toISOString()
      };
    } catch (error) {
      return failedResult(account.value, toSafeError(error));
    }
  }

  async resolveSource(account, { signal } = {}) {
    try {
      const data = await this.postJson(CDNS_SOURCE_RESOLVE_PATH, {
        accounts: [{ email: account.address, public_ref: account.credentials.publicRef }]
      }, { signal });
      const items = Array.isArray(data?.items) ? data.items : [];
      const item = items.find((entry) => entry?.index === 0) ?? items[0];
      const sourceUpstreamKey = readText(item?.source_upstream_key);
      if (item?.matched !== true || !sourceUpstreamKey) {
        return { ok: false, error: mapCdnsError(item ?? { error: "account_source_not_found" }, "source") };
      }
      return { ok: true, sourceUpstreamKey };
    } catch (error) {
      return { ok: false, error: toSafeError(error) };
    }
  }

  async postJson(path, payload, { signal } = {}) {
    const controller = new AbortController();
    let timeout;
    const abortFromCaller = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", abortFromCaller, { once: true });
      }
    }

    timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response?.ok) {
        throw Object.assign(new Error("Mailbox provider HTTP request failed"), {
          name: "MailboxProviderHttpError",
          status: Number.isInteger(response?.status) ? response.status : 0
        });
      }
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Mailbox provider response was not an object");
      }
      return data;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function parseCdnsImport(input) {
  const lines = normalizeLines(input);
  const entries = [];
  const failed = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      entries.push(parseCdnsLine(lines[index]));
    } catch (error) {
      failed.push({ line: index + 1, message: safeMessage(error, "Invalid cdns provider row") });
    }
  }
  return { entries, failed };
}

function parseCdnsLine(line) {
  if (typeof line !== "string" || /[\r\n]/u.test(line)) {
    throw new TypeError("CDNS import row must be a single line");
  }
  const parts = line.trim().split(CDNS_DELIMITER).map((part) => part.trim());
  if (parts.length < 4) {
    throw new Error("CDNS row requires email, password, receive token and public_ref");
  }

  const address = normalizeMailboxAddress(parts[0]);
  const password = requireCdnsField(parts[1], "password");
  const receiveToken = requireCdnsField(parts[2], "receive token");
  const publicRef = requireCdnsField(parts.slice(3).join(CDNS_DELIMITER), "public_ref");
  return { address, credentials: { email: address, password, receiveToken, publicRef } };
}

function normalizeInput(input) {
  try {
    const account = typeof input === "string" ? parseCdnsLine(input) : normalizeMailboxAccount(input);
    const password = readCredential(account.credentials, ["password"]);
    const receiveToken = readCredential(account.credentials, ["receiveToken", "receive_token", "token"]);
    const publicRef = readCredential(account.credentials, ["publicRef", "public_ref"]);
    if (!password || !receiveToken || !publicRef) {
      throw new Error("CDNS password, receive token and public_ref are required");
    }
    return {
      ok: true,
      value: {
        address: normalizeMailboxAddress(account.address),
        credentials: { email: account.address, password, receiveToken, publicRef }
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        stage: "validation",
        code: "invalid_mailbox",
        message: error instanceof Error && /address/iu.test(error.message)
          ? error.message
          : "Invalid cdns mailbox credentials",
        retryable: false
      }
    };
  }
}

function normalizeCdnsMessage(data, account, code) {
  const subject = redactCdnsText(data?.subject, account)
    || (code ? "CDNS verification code" : "CDNS message");
  const body = redactCdnsText(data?.message ?? data?.body, account);
  const receivedAt = readText(data?.received_at ?? data?.receivedAt);
  if (!body && !code && subject === "CDNS message") {
    return undefined;
  }

  const rawId = readText(data?.id) || `${account.address}\u0000${receivedAt}\u0000${code || body}`;
  const normalized = normalizeMessage({
    id: rawId,
    subject,
    receivedDateTime: receivedAt,
    body: [body, code ? `验证码：${code}` : ""].filter(Boolean).join("\n")
  });
  if (code && !normalized.codes.includes(code)) {
    normalized.codes = [code, ...normalized.codes];
  }
  return normalized;
}

function mapCdnsError(value, fallbackStage = "provider") {
  const text = collectErrorText(value);
  if (/(account[_ -]?source[_ -]?not[_ -]?found|source.*not.*found|未匹配来源|来源.*不存在)/iu.test(text)) {
    return {
      stage: "source",
      code: "account_source_not_found",
      message: "CDNS 未找到匹配的账号来源",
      retryable: false
    };
  }
  if (/(invalid.*(credential|password|token|public)|credential.*invalid|password|receive[_ -]?token|public[_ -]?ref|凭据无效|令牌无效)/iu.test(text)) {
    return {
      stage: "auth",
      code: "invalid_credentials",
      message: "CDNS 邮箱凭据无效",
      retryable: false
    };
  }
  if (/(rate|too many|限流|频繁)/iu.test(text)) {
    return {
      stage: "provider",
      code: "rate_limited",
      message: "CDNS 邮件查询请求过于频繁",
      retryable: true
    };
  }
  return {
    stage: fallbackStage,
    code: "account_query_failed",
    message: "CDNS 邮件查询失败",
    retryable: true
  };
}

function collectErrorText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return [value.error, value.detail, value.message, value.reason, value.provider_code, value.code]
    .filter((entry) => typeof entry === "string")
    .join(" ");
}

function redactCdnsText(value, account) {
  let text = readText(value);
  for (const secret of [account.credentials.password, account.credentials.receiveToken, account.credentials.publicRef]) {
    if (secret) {
      text = text.split(secret).join("[redacted]");
    }
  }
  return text.replace(/[A-Za-z0-9_-]{40,}/gu, "[redacted]");
}

function normalizeCdnsCode(value) {
  const code = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return CDNS_CODE_PATTERN.test(code) ? code : undefined;
}

function readCredential(credentials, keys) {
  if (!credentials || typeof credentials !== "object") {
    return "";
  }
  for (const key of keys) {
    if (typeof credentials[key] === "string" && credentials[key].trim()) {
      return credentials[key].trim();
    }
  }
  return "";
}

function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requireCdnsField(value, name) {
  const field = readText(value);
  if (!field) {
    throw new Error(`CDNS ${name} is required`);
  }
  if (/[\r\n]/u.test(field)) {
    throw new Error(`CDNS ${name} has invalid characters`);
  }
  return field;
}

function failedResult(account, error) {
  return {
    ok: false,
    providerId: CDNS_PROVIDER_ID,
    address: account.address,
    messages: [],
    codes: [],
    error
  };
}

function invalidResult(error) {
  return { ok: false, providerId: CDNS_PROVIDER_ID, operation: "query", messages: [], codes: [], error };
}

function normalizeLines(input) {
  return String(input ?? "")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeMessage(error, fallback) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message || fallback).replace(/[\r\n\t]+/gu, " ").slice(0, 160);
}

function normalizeTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : CDNS_DEFAULT_TIMEOUT_MS;
}

module.exports = {
  CDNS_BASE_URL,
  CDNS_CODE_PATTERN,
  CDNS_DEFAULT_TIMEOUT_MS,
  CDNS_MAX_MESSAGES,
  CDNS_PROVIDER_ID,
  CDNS_PUBLIC_PROXY_PATH,
  CDNS_RECEIVE_PATH,
  CDNS_SOURCE_RESOLVE_PATH,
  CdnsProvider,
  parseCdnsImport,
  parseCdnsLine
};
