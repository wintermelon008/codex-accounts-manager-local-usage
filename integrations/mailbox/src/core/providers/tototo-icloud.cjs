"use strict";

const { normalizeMailboxAccount, normalizeMailboxAddress } = require("../account.cjs");
const { toSafeError } = require("../errors.cjs");
const { normalizeMessage } = require("../messages.cjs");
const { createMailboxProvider } = require("../provider.cjs");

const TOTOTO_ICLOUD_PROVIDER_ID = "tototo-icloud";
const TOTOTO_ICLOUD_HOSTNAME = "ima4.52dfd.top";
const TOTOTO_ICLOUD_BASE_URL = "https://" + TOTOTO_ICLOUD_HOSTNAME;
const TOTOTO_ICLOUD_PATH_PREFIX = "/api/v1/mailboxes/";
const TOTOTO_ICLOUD_PATH_SUFFIX = "/code";
const TOTOTO_ICLOUD_MAX_MESSAGES = 1;
const TOTOTO_ICLOUD_DEFAULT_TIMEOUT_MS = 30_000;
const TOTOTO_ICLOUD_CODE_PATTERN = /^\d{6}$/u;
const TOTOTO_ICLOUD_DELIMITER = "----";

class TototoIcloudProvider {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = TOTOTO_ICLOUD_DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("A fetch implementation is required for the mailbox provider");
    }
    this.fetchImpl = fetchImpl;
    this.timeoutMs = normalizeTimeout(timeoutMs);
  }

  asProvider() {
    return createMailboxProvider({
      id: TOTOTO_ICLOUD_PROVIDER_ID,
      displayName: TOTOTO_ICLOUD_PROVIDER_ID,
      capabilities: { history: "latest", maxMessages: TOTOTO_ICLOUD_MAX_MESSAGES, manualRenewal: false },
      importSchema: {
        label: "邮箱----验证码查询 URL",
        description: "每行一个 iCloud 邮箱和对应的验证码查询 URL；URL 只保存在 Mailbox 私有存储中。",
        placeholder:
          "user@example.com----https://ima4.52dfd.top/api/v1/mailboxes/user@example.com/code?key=your_key"
      },
      parseImport: (input) => parseTototoIcloudImport(input),
      query: (account, options) => this.query(account, options)
    });
  }

  async query(input, { signal } = {}) {
    const account = normalizeInput(input);
    if (!account.ok) {
      return invalidResult(account.error);
    }

    try {
      const response = await this.getJson(account.value.credentials.codeUrl, { signal });
      return normalizeResponse(response, account.value);
    } catch (error) {
      return failedResult(account.value, toSafeError(error));
    }
  }

  async getJson(url, { signal } = {}) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", abortFromCaller, { once: true });
      }
    }

    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json, text/plain, */*" },
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

function parseTototoIcloudImport(input) {
  const lines = normalizeLines(input);
  const entries = [];
  const failed = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      entries.push(parseTototoIcloudLine(lines[index]));
    } catch (error) {
      failed.push({ line: index + 1, message: safeMessage(error, "Invalid tototo-icloud provider row") });
    }
  }
  return { entries, failed };
}

function parseTototoIcloudLine(line) {
  if (typeof line !== "string" || /[\r\n]/u.test(line)) {
    throw new TypeError("tototo-icloud import row must be a single line");
  }
  const value = line.trim();
  const delimiterIndex = value.indexOf(TOTOTO_ICLOUD_DELIMITER);
  if (delimiterIndex < 0) {
    throw new Error("tototo-icloud row requires email----code URL");
  }

  const address = normalizeMailboxAddress(value.slice(0, delimiterIndex));
  const codeUrl = normalizeCodeUrl(value.slice(delimiterIndex + TOTOTO_ICLOUD_DELIMITER.length), address);
  return { address, credentials: { codeUrl } };
}

function normalizeInput(input) {
  try {
    const account = typeof input === "string" ? parseTototoIcloudLine(input) : normalizeMailboxAccount(input);
    const codeUrl = readCredential(account.credentials, ["codeUrl", "code_url", "url"]);
    return {
      ok: true,
      value: {
        address: normalizeMailboxAddress(account.address),
        credentials: { codeUrl: normalizeCodeUrl(codeUrl, account.address) }
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
          : "Invalid tototo-icloud mailbox credentials",
        retryable: false
      }
    };
  }
}

function normalizeCodeUrl(value, address) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("tototo-icloud code URL is required");
  }
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" || parsed.hostname !== TOTOTO_ICLOUD_HOSTNAME) {
    throw new Error("tototo-icloud code URL must use the approved HTTPS endpoint");
  }
  if (parsed.hash) {
    throw new Error("tototo-icloud code URL must not contain a fragment");
  }
  if (!parsed.searchParams.get("key")?.trim()) {
    throw new Error("tototo-icloud code URL requires a key query parameter");
  }
  if (!parsed.pathname.startsWith(TOTOTO_ICLOUD_PATH_PREFIX) || !parsed.pathname.endsWith(TOTOTO_ICLOUD_PATH_SUFFIX)) {
    throw new Error("tototo-icloud code URL has an invalid mailbox path");
  }

  const encodedAddress = parsed.pathname.slice(
    TOTOTO_ICLOUD_PATH_PREFIX.length,
    -TOTOTO_ICLOUD_PATH_SUFFIX.length
  );
  let pathAddress;
  try {
    pathAddress = normalizeMailboxAddress(decodeURIComponent(encodedAddress));
  } catch {
    throw new Error("tototo-icloud code URL has an invalid mailbox path");
  }
  if (pathAddress.toLowerCase() !== normalizeMailboxAddress(address).toLowerCase()) {
    throw new Error("tototo-icloud code URL mailbox does not match the imported address");
  }
  return parsed.toString();
}

function normalizeResponse(data, account) {
  const rawCode = readText(data?.code);
  const code = TOTOTO_ICLOUD_CODE_PATTERN.test(rawCode) ? rawCode : undefined;
  const noCode = rawCode.toLowerCase() === "no_code";
  if (data?.success !== true && !noCode && !code) {
    return failedResult(account, mapResponseError(data));
  }

  const fetchedAt = normalizeDate(data?.fetchedAt ?? data?.fetched_at) || new Date().toISOString();
  if (!code) {
    return {
      ok: true,
      providerId: TOTOTO_ICLOUD_PROVIDER_ID,
      address: account.address,
      messages: [],
      codes: [],
      fetchedAt
    };
  }

  const receivedAt = normalizeDate(data?.receivedAt ?? data?.received_at ?? data?.createdAt) || fetchedAt;
  const messageText = sanitizeText(data?.message ?? data?.body, account.credentials.codeUrl);
  const subject =
    sanitizeText(data?.subject, account.credentials.codeUrl) || TOTOTO_ICLOUD_PROVIDER_ID + " verification code";
  const message = normalizeMessage({
    id: sanitizeText(data?.id, account.credentials.codeUrl) ||
      account.address + "\u0000" + receivedAt + "\u0000" + code,
    subject,
    receivedDateTime: receivedAt,
    body: [messageText, "验证码：" + code].filter(Boolean).join("\n")
  });
  if (!message.codes.includes(code)) {
    message.codes = [code, ...message.codes];
  }

  return {
    ok: true,
    providerId: TOTOTO_ICLOUD_PROVIDER_ID,
    address: account.address,
    messages: [message],
    codes: [code, ...message.codes.filter((value) => value !== code)],
    fetchedAt
  };
}

function mapResponseError(data) {
  const code = readText(data?.code).toLowerCase();
  const authFailure = ["invalid_key", "unauthorized", "forbidden", "invalid_credentials"].includes(code);
  return {
    stage: authFailure ? "auth" : "provider",
    code: authFailure ? "invalid_credentials" : "tototo_icloud_query_failed",
    message: authFailure ? "tototo-icloud 验证码查询 URL 无效" : "tototo-icloud 邮箱查询失败",
    retryable: authFailure ? false : data?.retryable !== false
  };
}

function sanitizeText(value, codeUrl) {
  let text = readText(value);
  if (!text) {
    return "";
  }
  text = text.split(codeUrl).join("[redacted]");
  try {
    const key = new URL(codeUrl).searchParams.get("key");
    if (key) {
      text = text.split(key).join("[redacted]");
    }
  } catch {
    // The URL was already validated before this function is called.
  }
  return text.replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]");
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
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function normalizeDate(value) {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function failedResult(account, error) {
  return {
    ok: false,
    providerId: TOTOTO_ICLOUD_PROVIDER_ID,
    address: account.address,
    messages: [],
    codes: [],
    error
  };
}

function invalidResult(error) {
  return {
    ok: false,
    providerId: TOTOTO_ICLOUD_PROVIDER_ID,
    operation: "query",
    messages: [],
    codes: [],
    error
  };
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
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : TOTOTO_ICLOUD_DEFAULT_TIMEOUT_MS;
}

module.exports = {
  TOTOTO_ICLOUD_BASE_URL,
  TOTOTO_ICLOUD_CODE_PATTERN,
  TOTOTO_ICLOUD_DEFAULT_TIMEOUT_MS,
  TOTOTO_ICLOUD_HOSTNAME,
  TOTOTO_ICLOUD_MAX_MESSAGES,
  TOTOTO_ICLOUD_PATH_PREFIX,
  TOTOTO_ICLOUD_PATH_SUFFIX,
  TOTOTO_ICLOUD_PROVIDER_ID,
  TototoIcloudProvider,
  parseTototoIcloudImport,
  parseTototoIcloudLine
};
