"use strict";

const { normalizeMailboxAccount, normalizeMailboxAddress } = require("../account.cjs");
const { toRemoteError, toSafeError } = require("../errors.cjs");
const { normalizeMessages } = require("../messages.cjs");
const { createMailboxProvider } = require("../provider.cjs");

const EIGHT92_PROVIDER_ID = "8t92";
const EIGHT92_BASE_URL = "https://email.nloop.cc";
const EIGHT92_QUERY_PATH = "/api/outlook/query";
const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const EIGHT92_DELIMITER = "----";

class Eight92Provider {
  constructor({ baseUrl = EIGHT92_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("A fetch implementation is required for the mailbox provider");
    }
    this.baseUrl = new URL(baseUrl).toString().replace(/\/$/u, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = normalizeTimeout(timeoutMs);
  }

  asProvider() {
    return createMailboxProvider({
      id: EIGHT92_PROVIDER_ID,
      displayName: "tototo-outlook",
      capabilities: { history: "recent", maxMessages: DEFAULT_MAX_MESSAGES, manualRenewal: false },
      importSchema: {
        label: "Outlook 来源凭据",
        description: "每行一个 Outlook 邮箱；凭据仅保存在 Mailbox 私有存储中。"
      },
      parseImport: (input) => parseEight92Import(input),
      query: (account, options) => this.query(account, options)
    });
  }

  async query(input, { maxMessages = DEFAULT_MAX_MESSAGES, signal } = {}) {
    const account = normalizeInput(input);
    if (!account.ok) {
      return invalidResult(EIGHT92_PROVIDER_ID, account.error);
    }

    try {
      const data = await this.postJson(EIGHT92_QUERY_PATH, {
        email: account.value.address,
        password: account.value.credentials.password,
        client_id: account.value.credentials.clientId,
        refresh_token: account.value.credentials.refreshToken,
        mailbox: "INBOX",
        mode: "all",
        top: normalizeMaxMessages(maxMessages)
      }, { signal });
      if (data?.ok !== true || !Array.isArray(data?.mails)) {
        return failedResult(account.value, mapNloopError(data));
      }

      const messages = normalizeMessages(data.mails);
      return {
        ok: true,
        providerId: EIGHT92_PROVIDER_ID,
        address: account.value.address,
        messages,
        codes: [...new Set(messages.flatMap((message) => message.codes))],
        fetchedAt: typeof data.fetchedAt === "string" ? data.fetchedAt : new Date().toISOString()
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

function parseEight92Import(input) {
  const lines = normalizeLines(input);
  const entries = [];
  const failed = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      entries.push(parseEight92Line(lines[index]));
    } catch (error) {
      failed.push({ line: index + 1, message: safeMessage(error, "Invalid provider row") });
    }
  }
  return { entries, failed };
}

function parseEight92Line(line) {
  if (typeof line !== "string") {
    throw new TypeError("Provider import row must be text");
  }
  const parts = line.split(EIGHT92_DELIMITER);
  if (parts.length < 4) {
    throw new Error("Provider row requires address, password, clientId and refresh token");
  }
  const address = normalizeMailboxAddress(parts[0]);
  const password = requireProviderField(parts[1], "password");
  const clientId = requireProviderField(parts[2], "clientId");
  const refreshToken = requireProviderField(parts.slice(3).join(EIGHT92_DELIMITER), "refreshToken");
  if ([address, password, clientId].some((value) => /[\r\n]/u.test(value))) {
    throw new Error("Provider fields must not contain line breaks");
  }
  if ([address, password, clientId].some((value) => value.includes(EIGHT92_DELIMITER))) {
    throw new Error("Provider fields must not contain the row delimiter");
  }
  return { address, credentials: { email: address, password, clientId, refreshToken } };
}

function normalizeInput(input) {
  try {
    if (typeof input === "string") {
      return { ok: true, value: parseEight92Line(input) };
    }
    const account = normalizeMailboxAccount(input);
    return { ok: true, value: { address: account.address, credentials: account.credentials } };
  } catch (error) {
    return {
      ok: false,
      error: {
        stage: "validation",
        code: "invalid_mailbox",
        message: error instanceof Error ? error.message : "Invalid mailbox credentials",
        retryable: false
      }
    };
  }
}

function mapNloopError(data) {
  const message = typeof data?.error === "string" ? data.error : "tototo-outlook 邮箱服务返回了无效响应";
  return toRemoteError([{ stage: "provider", code: "nloop_query_failed", message }], "provider");
}

function failedResult(account, error) {
  return {
    ok: false,
    providerId: EIGHT92_PROVIDER_ID,
    address: account.address,
    messages: [],
    codes: [],
    error
  };
}

function invalidResult(providerId, error, operation = "query") {
  return { ok: false, providerId, operation, messages: [], codes: [], error };
}

function normalizeLines(input) {
  return String(input ?? "")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
}

function requireProviderField(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Provider ${name} is required`);
  }
  return value;
}

function safeMessage(error, fallback) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message || fallback).replace(/[\r\n\t]+/gu, " ").slice(0, 160);
}

function normalizeMaxMessages(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(50, Math.floor(number))) : DEFAULT_MAX_MESSAGES;
}

function normalizeTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_TIMEOUT_MS;
}

module.exports = {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_TIMEOUT_MS,
  EIGHT92_BASE_URL,
  EIGHT92_PROVIDER_ID,
  Eight92Provider,
  parseEight92Import,
  parseEight92Line
};
