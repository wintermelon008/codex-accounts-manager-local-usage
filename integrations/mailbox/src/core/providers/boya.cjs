"use strict";

const { normalizeMailboxAccount, normalizeMailboxAddress } = require("../account.cjs");
const { toSafeError } = require("../errors.cjs");
const { normalizeMessage } = require("../messages.cjs");
const { createMailboxProvider } = require("../provider.cjs");

const BOYA_PROVIDER_ID = "boya";
const BOYA_BASE_URL = "http://freemail.boya.one";
const BOYA_CODES_PATH = "/api/user/codes";
const BOYA_DELIMITER = "----";
const BOYA_MAX_MESSAGES = 1;
const BOYA_DEFAULT_TIMEOUT_MS = 30_000;
const BOYA_CODE_PATTERN = /^\d{6}$/u;

class BoyaProvider {
  constructor({ baseUrl = BOYA_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = BOYA_DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("A fetch implementation is required for the mailbox provider");
    }
    this.baseUrl = new URL(baseUrl).toString().replace(/\/$/u, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = normalizeTimeout(timeoutMs);
  }

  asProvider() {
    return createMailboxProvider({
      id: BOYA_PROVIDER_ID,
      displayName: "boya",
      capabilities: { history: "latest", maxMessages: BOYA_MAX_MESSAGES, manualRenewal: false },
      importSchema: {
        label: "邮箱----private token",
        description: "每行一个邮箱和对应的 private token；凭据只保存在 Mailbox 私有存储中。",
        placeholder: "user@example.com----private_token"
      },
      parseImport: (input) => parseBoyaImport(input),
      query: (account, options) => this.query(account, options)
    });
  }

  async query(input, { signal } = {}) {
    const account = normalizeInput(input);
    if (!account.ok) {
      return invalidResult(account.error);
    }

    try {
      const data = await this.postJson(BOYA_CODES_PATH, {
        text: serializeBoyaAccount(account.value)
      }, { signal });
      if (data?.ok !== true) {
        return failedResult(account.value, {
          stage: "provider",
          code: "invalid_response",
          message: "Boya 邮箱服务返回了无效响应",
          retryable: true
        });
      }

      const item = pickBoyaItem(data, account.value.address);
      if (!item) {
        return failedResult(account.value, {
          stage: "provider",
          code: "mailbox_result_missing",
          message: "Boya 邮箱服务没有返回当前邮箱结果",
          retryable: true
        });
      }
      if (item.ok !== true) {
        return failedResult(account.value, mapBoyaItemError(item.error));
      }

      const code = normalizeBoyaCode(item.code);
      const message = normalizeBoyaMessage(item.message, code, account.value.address, account.value.credentials.privateToken);
      const messages = message ? [message] : [];
      const codes = [...new Set([...(code ? [code] : []), ...messages.flatMap((entry) => entry.codes)])];
      return {
        ok: true,
        providerId: BOYA_PROVIDER_ID,
        address: account.value.address,
        messages,
        codes,
        fetchedAt: new Date().toISOString()
      };
    } catch (error) {
      return failedResult(account.value, toSafeError(error));
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
      if (!data || typeof data !== "object") {
        throw new Error("Mailbox provider response was not an object");
      }
      return data;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function parseBoyaImport(input) {
  const lines = normalizeLines(input);
  const entries = [];
  const failed = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      entries.push(parseBoyaLine(lines[index]));
    } catch (error) {
      failed.push({ line: index + 1, message: safeMessage(error, "Invalid boya provider row") });
    }
  }
  return { entries, failed };
}

function parseBoyaLine(line) {
  if (typeof line !== "string" || /[\r\n]/u.test(line)) {
    throw new TypeError("Boya import row must be a single line");
  }
  const value = line.trim();
  const delimiterIndex = value.indexOf(BOYA_DELIMITER);
  if (delimiterIndex < 0) {
    throw new Error("Boya row requires email----private token");
  }

  const address = normalizeMailboxAddress(value.slice(0, delimiterIndex));
  const privateToken = value.slice(delimiterIndex + BOYA_DELIMITER.length).trim();
  if (!privateToken) {
    throw new Error("Boya private token is required");
  }
  if (/[\r\n]/u.test(privateToken)) {
    throw new Error("Boya private token has invalid characters");
  }
  return { address, credentials: { privateToken } };
}

function normalizeInput(input) {
  try {
    const account = typeof input === "string" ? parseBoyaLine(input) : normalizeMailboxAccount(input);
    const privateToken = readPrivateToken(account.credentials);
    if (!privateToken) {
      throw new Error("Boya private token is required");
    }
    if (/[\r\n]/u.test(privateToken)) {
      throw new Error("Boya private token has invalid characters");
    }
    return { ok: true, value: { address: account.address, credentials: { privateToken } } };
  } catch (error) {
    return {
      ok: false,
      error: {
        stage: "validation",
        code: "invalid_mailbox",
        message: error instanceof Error && /address/iu.test(error.message) ? error.message : "Invalid boya mailbox credentials",
        retryable: false
      }
    };
  }
}

function readPrivateToken(credentials) {
  if (!credentials || typeof credentials !== "object") {
    return "";
  }
  for (const key of ["privateToken", "private_token"]) {
    if (typeof credentials[key] === "string" && credentials[key].trim()) {
      return credentials[key].trim();
    }
  }
  return "";
}

function serializeBoyaAccount(account) {
  const normalized = normalizeInput(account);
  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }
  return [normalized.value.address, normalized.value.credentials.privateToken].join(BOYA_DELIMITER);
}

function pickBoyaItem(data, address) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const exact = items.find((item) => {
    const candidate = typeof item?.userEmail === "string" ? item.userEmail : "";
    return candidate.toLowerCase() === address.toLowerCase();
  });
  if (exact) {
    return exact;
  }
  return items.length === 1 && !items[0]?.userEmail ? items[0] : undefined;
}

function normalizeBoyaMessage(message, code, address, privateToken) {
  const source = message && typeof message === "object" ? message : undefined;
  const body = redactBoyaText(readBoyaBody(source), privateToken);
  const receivedAt = readBoyaText(source?.receivedDateTime ?? source?.receivedAt);
  const subject = redactBoyaText(readBoyaText(source?.subject ?? source?.title), privateToken)
    || (code ? "Boya verification code" : "Boya message");
  if (!source && !code) {
    return undefined;
  }
  const rawId = readBoyaText(source?.id ?? source?.internetMessageId ?? source?.messageId)
    || `${address}\u0000${receivedAt}\u0000${code || body}`;
  const normalized = normalizeMessage({
    id: rawId,
    subject,
    from: sanitizeBoyaSender(source?.from ?? source?.sender, privateToken),
    receivedDateTime: receivedAt,
    body: [body, code ? `验证码：${code}` : ""].filter(Boolean).join("\n")
  });
  if (code && !normalized.codes.includes(code)) {
    normalized.codes = [code, ...normalized.codes];
  }
  return normalized;
}

function redactBoyaText(value, privateToken) {
  const text = typeof value === "string" ? value : "";
  return privateToken && text.includes(privateToken) ? text.split(privateToken).join("[redacted]") : text;
}

function sanitizeBoyaSender(sender, privateToken) {
  if (!sender || typeof sender !== "object") {
    return redactBoyaText(sender, privateToken);
  }
  return {
    emailAddress: {
      address: redactBoyaText(sender.emailAddress?.address ?? sender.address ?? sender.email, privateToken),
      name: redactBoyaText(sender.emailAddress?.name ?? sender.name, privateToken)
    }
  };
}

function readBoyaBody(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  const candidates = [message.body, message.bodyPreview, message.bodyText, message.bodyHtml, message.preview];
  for (const candidate of candidates) {
    const text = readBoyaText(candidate?.content ?? candidate?.text ?? candidate);
    if (text) {
      return text;
    }
  }
  return "";
}

function readBoyaText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBoyaCode(value) {
  const code = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return BOYA_CODE_PATTERN.test(code) ? code : undefined;
}

function mapBoyaItemError(value) {
  const text = typeof value === "string" ? value : "";
  if (/(token|令牌|邮箱|不正确|invalid)/iu.test(text)) {
    return {
      stage: "auth",
      code: "invalid_credentials",
      message: "Boya 邮箱或 private token 无效",
      retryable: false
    };
  }
  return {
    stage: "provider",
    code: "account_query_failed",
    message: "Boya 邮箱查询失败",
    retryable: true
  };
}

function failedResult(account, error) {
  return {
    ok: false,
    providerId: BOYA_PROVIDER_ID,
    address: account.address,
    messages: [],
    codes: [],
    error
  };
}

function invalidResult(error) {
  return { ok: false, providerId: BOYA_PROVIDER_ID, operation: "query", messages: [], codes: [], error };
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
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : BOYA_DEFAULT_TIMEOUT_MS;
}

module.exports = {
  BOYA_BASE_URL,
  BOYA_CODES_PATH,
  BOYA_DEFAULT_TIMEOUT_MS,
  BOYA_MAX_MESSAGES,
  BOYA_PROVIDER_ID,
  BoyaProvider,
  parseBoyaImport,
  parseBoyaLine
};
