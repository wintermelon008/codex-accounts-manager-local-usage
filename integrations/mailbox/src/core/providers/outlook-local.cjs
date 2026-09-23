"use strict";

const crypto = require("node:crypto");
const tls = require("node:tls");
const { normalizeMailboxAccount, normalizeMailboxAddress } = require("../account.cjs");
const { htmlToText, normalizeMessages } = require("../messages.cjs");
const { createMailboxProvider } = require("../provider.cjs");

const OUTLOOK_LOCAL_PROVIDER_ID = "outlook-local";
const OUTLOOK_LOCAL_DISPLAY_NAME = "Outlook（本地 OAuth）";
const OUTLOOK_TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const OUTLOOK_IMAP_HOST = "outlook.office365.com";
const OUTLOOK_IMAP_PORT = 993;
const OUTLOOK_IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access";
const OUTLOOK_LOCAL_DELIMITER = "----";
const OUTLOOK_LOCAL_MAX_MESSAGES = 3;
const OUTLOOK_LOCAL_SEARCH_DAYS = 30;
const OUTLOOK_LOCAL_DEFAULT_TIMEOUT_MS = 30_000;
const OUTLOOK_LOCAL_MAX_FETCH_BYTES = 256 * 1024;
const OUTLOOK_LOCAL_ACCESS_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1000;
const OUTLOOK_LOCAL_ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

class OutlookLocalProvider {
  constructor({
    fetchImpl = globalThis.fetch,
    tlsConnect = tls.connect,
    tokenEndpoint = OUTLOOK_TOKEN_ENDPOINT,
    imapHost = OUTLOOK_IMAP_HOST,
    imapPort = OUTLOOK_IMAP_PORT,
    timeoutMs = OUTLOOK_LOCAL_DEFAULT_TIMEOUT_MS,
    now = () => Date.now()
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("A fetch implementation is required for the mailbox provider");
    }
    if (typeof tlsConnect !== "function") {
      throw new Error("A TLS connector is required for the mailbox provider");
    }
    this.fetchImpl = fetchImpl;
    this.tlsConnect = tlsConnect;
    this.tokenEndpoint = new URL(tokenEndpoint).toString();
    this.imapHost = imapHost;
    this.imapPort = Number(imapPort);
    this.timeoutMs = normalizeTimeout(timeoutMs);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.accessTokenCache = new Map();
    this.accessTokenInflight = new Map();
  }

  asProvider() {
    return createMailboxProvider({
      id: OUTLOOK_LOCAL_PROVIDER_ID,
      displayName: OUTLOOK_LOCAL_DISPLAY_NAME,
      capabilities: {
        history: "recent",
        maxMessages: OUTLOOK_LOCAL_MAX_MESSAGES,
        manualRenewal: true
      },
      importSchema: {
        label: "Outlook 本地 OAuth 来源",
        description: "本机使用 client id + refresh token 向微软换取 IMAP access token，再通过 Outlook IMAP 只读查询；凭据只保存在 Mailbox 私有存储中。支持 email----client-id----refresh-token，也兼容四段旧格式（第二段会忽略）。",
        placeholder: "email@example.com----client-id----refresh-token"
      },
      parseImport: (input) => parseOutlookLocalImport(input),
      query: (account, options) => this.query(account, options),
      renew: (account, options) => this.renew(account, options)
    });
  }

  async query(input, {
    maxMessages = OUTLOOK_LOCAL_MAX_MESSAGES,
    searchDays = OUTLOOK_LOCAL_SEARCH_DAYS,
    signal,
    onCredentialRefresh
  } = {}) {
    const account = normalizeInput(input);
    if (!account.ok) {
      return invalidResult(account.error);
    }

    let token;
    try {
      token = await this.getAccessToken(account.value, { signal });
      if (token.credentialRefreshPending && typeof onCredentialRefresh === "function") {
        await onCredentialRefresh({
          address: account.value.address,
          credentials: {
            email: account.value.address,
            clientId: account.value.credentials.clientId,
            refreshToken: token.refreshToken
          }
        });
        token.credentialRefreshPending = false;
      }

      const rawMessages = await this.queryImap(account.value.address, token.accessToken, {
        maxMessages,
        searchDays,
        signal
      });
      const messages = normalizeMessages(rawMessages);
      return {
        ok: true,
        providerId: OUTLOOK_LOCAL_PROVIDER_ID,
        address: account.value.address,
        messages,
        codes: [...new Set(messages.flatMap((message) => message.codes))],
        fetchedAt: new Date().toISOString()
      };
    } catch (error) {
      if (error?.providerCode === "imap_auth_failed" && token?.accessToken) {
        const cacheKey = accessTokenCacheKey(account.value);
        const cached = this.accessTokenCache.get(cacheKey);
        if (cached?.accessToken === token.accessToken) {
          this.accessTokenCache.delete(cacheKey);
        }
      }
      return failedResult(account.value, toProviderError(error));
    }
  }

  async renew(input, { signal } = {}) {
    const account = normalizeInput(input);
    if (!account.ok) {
      return invalidResult(account.error, "renewal");
    }

    try {
      // Manual renewal deliberately performs a fresh exchange even when the
      // query cache still contains a usable access token.
      const token = await this.exchangeRefreshToken(account.value, { signal });
      this.cacheAccessToken(account.value, token, { credentialRefreshPending: false });
      const rotated = token.refreshToken && token.refreshToken !== account.value.credentials.refreshToken;
      return {
        ok: true,
        providerId: OUTLOOK_LOCAL_PROVIDER_ID,
        operation: "renewal",
        status: rotated ? "updated" : "unchanged",
        address: account.value.address,
        messages: [],
        codes: [],
        ...(rotated
          ? {
              account: {
                address: account.value.address,
                credentials: {
                  email: account.value.address,
                  clientId: account.value.credentials.clientId,
                  refreshToken: token.refreshToken
                }
              }
            }
          : {})
      };
    } catch (error) {
      return failedResult(account.value, toProviderError(error, "renewal"));
    }
  }

  async getAccessToken(account, { signal, forceRefresh = false } = {}) {
    const cacheKey = accessTokenCacheKey(account);
    const cached = this.accessTokenCache.get(cacheKey);
    if (
      !forceRefresh &&
      cached &&
      cached.expiresAt - this.now() > OUTLOOK_LOCAL_ACCESS_TOKEN_REFRESH_SKEW_MS
    ) {
      return cached;
    }

    const inflight = this.accessTokenInflight.get(cacheKey);
    if (inflight) return inflight;

    const pending = this.exchangeRefreshToken(account, { signal })
      .then((token) => this.cacheAccessToken(account, token, {
        credentialRefreshPending: token.refreshToken !== account.credentials.refreshToken
      }))
      .finally(() => {
        if (this.accessTokenInflight.get(cacheKey) === pending) {
          this.accessTokenInflight.delete(cacheKey);
        }
      });
    this.accessTokenInflight.set(cacheKey, pending);
    return pending;
  }

  cacheAccessToken(account, token, { credentialRefreshPending = false } = {}) {
    const cacheKey = accessTokenCacheKey(account);
    const entry = {
      cacheKey,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: this.now() + normalizeTokenLifetimeMs(token.expiresInMs),
      credentialRefreshPending: credentialRefreshPending === true
    };
    this.accessTokenCache.set(cacheKey, entry);
    return entry;
  }

  async exchangeRefreshToken(account, { signal } = {}) {
    const linked = createLinkedAbortController(signal, this.timeoutMs);
    try {
      const body = new URLSearchParams({
        client_id: account.credentials.clientId,
        grant_type: "refresh_token",
        refresh_token: account.credentials.refreshToken,
        scope: OUTLOOK_IMAP_SCOPE
      });
      const response = await this.fetchImpl(this.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json"
        },
        body: body.toString(),
        signal: linked.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response?.ok || typeof data?.access_token !== "string" || !data.access_token) {
        const status = Number.isInteger(response?.status) ? response.status : 0;
        const providerCode = typeof data?.error === "string" ? data.error : "token_exchange_failed";
        const error = new Error(providerCode);
        error.providerCode = providerCode;
        error.status = status;
        throw error;
      }
      return {
        accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === "string" && data.refresh_token
          ? data.refresh_token
          : account.credentials.refreshToken,
        expiresInMs: normalizeTokenLifetimeSeconds(data.expires_in)
      };
    } finally {
      linked.dispose();
    }
  }

  async queryImap(username, accessToken, {
    maxMessages = OUTLOOK_LOCAL_MAX_MESSAGES,
    searchDays = OUTLOOK_LOCAL_SEARCH_DAYS,
    signal
  } = {}) {
    const client = new ImapClient({
      host: this.imapHost,
      port: this.imapPort,
      timeoutMs: this.timeoutMs,
      tlsConnect: this.tlsConnect,
      signal
    });
    try {
      await client.connect();
      await client.authenticateXoauth2(username, accessToken);
      await client.command("SELECT INBOX");
      const search = await client.command(`UID SEARCH SINCE ${formatImapDate(this.now() - normalizeSearchDays(searchDays) * 24 * 60 * 60 * 1000)}`);
      const searchLine = search.lines.find((line) => /^\* SEARCH(?: |$)/u.test(line));
      const ids = searchLine
        ? searchLine.replace(/^\* SEARCH\s*/u, "").trim().split(/\s+/u).filter((id) => /^\d+$/u.test(id))
        : [];
      const selectedIds = ids.slice(-normalizeMaxMessages(maxMessages)).reverse();
      if (selectedIds.length === 0) return [];

      // Fetch the recent messages in one IMAP round trip. Issuing one command
      // per message multiplied the latency of every local mailbox query by the
      // number of messages requested.
      const fetchIds = [...selectedIds].sort((left, right) => Number(left) - Number(right));
      const fetched = await client.command(
        `UID FETCH ${fetchIds.join(",")} (UID BODY.PEEK[]<0.${OUTLOOK_LOCAL_MAX_FETCH_BYTES}>)`
      );
      const byUid = new Map();
      for (let index = 0; index < fetched.literals.length; index += 1) {
        const raw = fetched.literals[index];
        if (!raw?.length) continue;
        const uid = fetched.literalUids?.[index] || fetchIds[index];
        byUid.set(String(uid), parseRawEmail(raw, uid));
      }
      return selectedIds.map((id) => byUid.get(String(id))).filter(Boolean);
    } finally {
      await client.close();
    }
  }
}

class ImapClient {
  constructor({ host, port, timeoutMs, tlsConnect, signal }) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.tlsConnect = tlsConnect;
    this.signal = signal;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.tagNumber = 0;
    this.closed = false;
    this.abortHandler = undefined;
  }

  async connect() {
    if (this.signal?.aborted) throw abortError();
    this.socket = this.tlsConnect({
      host: this.host,
      port: this.port,
      family: 4,
      servername: this.host,
      rejectUnauthorized: true
    });
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      this.pumpWaiters();
    });
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => {
      if (!this.closed) this.fail(new Error("IMAP connection closed"));
    });
    if (typeof this.socket.setTimeout === "function") {
      this.socket.setTimeout(this.timeoutMs, () => this.fail(timeoutError()));
    }
    if (this.signal) {
      this.abortHandler = () => this.fail(abortError());
      this.signal.addEventListener("abort", this.abortHandler, { once: true });
    }
    if (typeof this.socket.once === "function") {
      await onceEvent(this.socket, "secureConnect", this.signal, this.timeoutMs);
    }
    const greeting = await this.readLine();
    if (!/^\* (?:OK|PREAUTH)(?:\s|$)/iu.test(greeting)) {
      throw imapError("IMAP greeting was not accepted", "imap_connection_failed");
    }
  }

  async authenticateXoauth2(username, accessToken) {
    const tag = this.nextTag();
    const response = Buffer.from(`user=${username}\x01auth=Bearer ${accessToken}\x01\x01`).toString("base64");
    let responseSent = false;
    let diagnostic;
    this.write(`${tag} AUTHENTICATE XOAUTH2`);
    while (true) {
      const line = await this.readLine();
      if (line.startsWith("+")) {
        diagnostic = parseXoauth2Diagnostic(line) || diagnostic;
        if (responseSent) {
          // XOAUTH2 servers send an error continuation after rejecting the
          // bearer token. A blank response completes SASL and lets the server
          // return its tagged NO response; never resend the bearer token.
          this.writeRaw("\r\n");
        } else {
          this.writeRaw(`${response}\r\n`);
          responseSent = true;
        }
        continue;
      }
      if (!line.startsWith(`${tag} `)) continue;
      if (!/\sOK(?:\s|$)/iu.test(line)) {
        const error = imapError("Outlook IMAP OAuth authentication failed", "imap_auth_failed");
        error.imapDiagnostic = diagnostic;
        throw error;
      }
      return;
    }
  }

  async command(command) {
    const tag = this.nextTag();
    this.write(`${tag} ${command}`);
    const lines = [];
    const literals = [];
    const literalUids = [];
    while (true) {
      const line = await this.readLine();
      const literalMatch = line.match(/\{(\d+)\}$/u);
      lines.push(line);
      if (literalMatch) {
        literals.push(await this.readBytes(Number(literalMatch[1])));
        literalUids.push(line.match(/\bUID\s+(\d+)/iu)?.[1]);
      }
      if (!line.startsWith(`${tag} `)) continue;
      if (!/\sOK(?:\s|$)/iu.test(line)) {
        throw imapError(`IMAP command failed: ${command.split(" ", 1)[0]}`, "imap_command_failed");
      }
      return { lines, literals, literalUids };
    }
  }

  async readLine() {
    const end = await this.waitFor(() => this.buffer.indexOf(Buffer.from("\r\n")) >= 0);
    const line = this.buffer.subarray(0, end).toString("utf8");
    this.buffer = this.buffer.subarray(end + 2);
    return line;
  }

  async readBytes(length) {
    await this.waitFor(() => this.buffer.length >= length);
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }

  waitFor(predicate) {
    if (predicate()) return Promise.resolve(this.buffer.indexOf(Buffer.from("\r\n")));
    return new Promise((resolve, reject) => {
      this.waiters.push({ predicate, resolve, reject });
    });
  }

  pumpWaiters() {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (!waiter.predicate()) continue;
      this.waiters.splice(index, 1);
      waiter.resolve(this.buffer.indexOf(Buffer.from("\r\n")));
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
    this.socket?.destroy?.();
  }

  write(command) {
    this.writeRaw(`${command}\r\n`);
  }

  writeRaw(value) {
    if (!this.socket || this.closed) throw new Error("IMAP connection is closed");
    this.socket.write(value);
  }

  nextTag() {
    this.tagNumber += 1;
    return `A${String(this.tagNumber).padStart(4, "0")}`;
  }

  async close() {
    this.closed = true;
    if (this.signal && this.abortHandler) {
      this.signal.removeEventListener("abort", this.abortHandler);
    }
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write("ZZZZ LOGOUT\r\n");
      } catch {
        // The connection may already be broken.
      }
      this.socket.end?.();
      this.socket.destroy?.();
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("IMAP connection closed"));
    }
  }
}

function parseOutlookLocalImport(input) {
  const entries = [];
  const failed = [];
  const lines = normalizeLines(input);
  for (let index = 0; index < lines.length; index += 1) {
    try {
      entries.push(parseOutlookLocalLine(lines[index]));
    } catch (error) {
      failed.push({ line: index + 1, message: safeMessage(error, "Invalid Outlook local OAuth row") });
    }
  }
  return { entries, failed };
}

function parseOutlookLocalLine(line) {
  if (typeof line !== "string" || /[\r\n]/u.test(line)) {
    throw new TypeError("Outlook local OAuth row must be a single line");
  }
  const parts = line.trim().split(OUTLOOK_LOCAL_DELIMITER).map((part) => part.trim());
  if (parts.length < 3) {
    throw new Error("Outlook local OAuth row requires email, client id and refresh token");
  }
  const address = normalizeMailboxAddress(parts[0]);
  const clientId = requireField(parts.length === 3 ? parts[1] : parts[2], "client id");
  const refreshToken = requireField(
    parts.length === 3 ? parts[2] : parts.slice(3).join(OUTLOOK_LOCAL_DELIMITER),
    "refresh token"
  );
  if ([clientId, refreshToken].some((value) => /[\r\n]/u.test(value))) {
    throw new Error("Outlook local OAuth fields must not contain line breaks");
  }
  return {
    address,
    credentials: { email: address, clientId, refreshToken }
  };
}

function normalizeInput(input) {
  try {
    const account = typeof input === "string" ? parseOutlookLocalLine(input) : normalizeMailboxAccount(input);
    const clientId = readCredential(account.credentials, ["clientId", "client_id"]);
    const refreshToken = readCredential(account.credentials, ["refreshToken", "refresh_token"]);
    if (!clientId || !refreshToken) {
      throw new Error("Outlook local OAuth requires client id and refresh token");
    }
    return {
      ok: true,
      value: {
        address: normalizeMailboxAddress(account.address),
        credentials: { email: account.address, clientId, refreshToken }
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        stage: "validation",
        code: "invalid_mailbox",
        message: safeMessage(error, "Invalid Outlook local OAuth credentials"),
        retryable: false
      }
    };
  }
}

function parseRawEmail(raw, uid) {
  const separator = raw.indexOf(Buffer.from("\r\n\r\n"));
  const headerBytes = separator >= 0 ? raw.subarray(0, separator) : raw;
  const bodyBytes = separator >= 0 ? raw.subarray(separator + 4) : Buffer.alloc(0);
  const headers = parseHeaders(headerBytes.toString("latin1"));
  const body = extractMimeBody(headers, bodyBytes);
  const messageId = decodeMimeHeader(headers["message-id"]) || `outlook-local:${uid}:${digest(raw)}`;
  return {
    id: messageId,
    subject: decodeMimeHeader(headers.subject),
    from: parseFromHeader(headers.from),
    receivedDateTime: headers.date || undefined,
    body: body.text,
    ...(body.html ? { bodyHtml: body.html } : {})
  };
}

function parseFromHeader(value) {
  const decoded = decodeMimeHeader(value);
  const address = decoded.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
  if (!address) return decoded;
  const name = decoded
    .replace(address, "")
    .replace(/[<>]/gu, "")
    .replace(/^\s*["']|["']\s*$/gu, "")
    .trim();
  return { emailAddress: { address, ...(name ? { name } : {}) } };
}

function parseHeaders(value) {
  const headers = {};
  let currentName = "";
  for (const line of value.split(/\r?\n/u)) {
    if (/^[ \t]/u.test(line) && currentName) {
      headers[currentName] += ` ${line.trim()}`;
      continue;
    }
    const match = line.match(/^([^:]+):\s*(.*)$/u);
    if (!match) continue;
    currentName = match[1].trim().toLowerCase();
    headers[currentName] = match[2].trim();
  }
  return headers;
}

function extractMimeBody(headers, body) {
  const contentType = String(headers["content-type"] || "text/plain");
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const boundary = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu)?.[1]
    || contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu)?.[2];
  if (boundary) {
    const parts = body.toString("latin1").split(`--${boundary}`);
    let html;
    let plain;
    for (const section of parts.slice(1)) {
      if (section.startsWith("--")) break;
      const cleaned = section.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
      const separator = cleaned.indexOf("\r\n\r\n");
      if (separator < 0) continue;
      const partHeaders = parseHeaders(cleaned.slice(0, separator));
      const partBody = Buffer.from(cleaned.slice(separator + 4), "latin1");
      const partBodyValue = extractMimeBody(partHeaders, partBody);
      if (!partBodyValue.text && !partBodyValue.html) continue;
      if (/^text\/plain\b/iu.test(String(partHeaders["content-type"] || ""))) {
        plain ||= partBodyValue.text;
      } else {
        html ||= partBodyValue.html || partBodyValue.text;
      }
    }
    if (html) return { text: plain || htmlToText(html), html };
    if (plain) return { text: plain, html: "" };
    return { text: "", html: "" };
  }

  const decoded = decodeTransferEncoding(body, headers["content-transfer-encoding"]);
  const text = decodeText(decoded, contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/iu)?.[1]);
  return mediaType === "text/html" ? { text: htmlToText(text), html: text } : { text, html: "" };
}

function decodeTransferEncoding(value, encoding) {
  const normalized = String(encoding || "").trim().toLowerCase();
  if (normalized === "base64") {
    return Buffer.from(value.toString("ascii").replace(/\s+/gu, ""), "base64");
  }
  if (normalized === "quoted-printable") {
    const text = value.toString("latin1").replace(/=\r?\n/gu, "");
    const bytes = [];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "=" && /^[0-9A-F]{2}$/iu.test(text.slice(index + 1, index + 3))) {
        bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        bytes.push(text.charCodeAt(index));
      }
    }
    return Buffer.from(bytes);
  }
  return value;
}

function decodeText(value, charset) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""), "utf8");
  const normalized = String(charset || "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(normalized).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function decodeMimeHeader(value) {
  const text = String(value || "");
  return text.replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/giu, (_match, charset, encoding, payload) => {
    const bytes = encoding.toLowerCase() === "b"
      ? Buffer.from(payload, "base64")
      : Buffer.from(payload.replace(/_/gu, " ").replace(/=([0-9A-F]{2})/giu, (_item, hex) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
    return decodeText(bytes, charset);
  });
}

function createLinkedAbortController(signal, timeoutMs) {
  const controller = new AbortController();
  if (signal?.aborted) {
    controller.abort();
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

function onceEvent(emitter, eventName, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      emitter.removeListener?.(eventName, onEvent);
      emitter.removeListener?.("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    emitter.once(eventName, onEvent);
    emitter.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(timeoutError());
    }, timeoutMs);
  });
}

function imapError(message, code) {
  const error = new Error(message);
  error.providerCode = code;
  return error;
}

function timeoutError() {
  const error = new Error("Outlook IMAP request timed out");
  error.code = "ETIMEDOUT";
  return error;
}

function abortError() {
  const error = new Error("Request cancelled");
  error.name = "AbortError";
  return error;
}

function parseXoauth2Diagnostic(line) {
  const encoded = String(line ?? "").replace(/^\+\s*/u, "").trim();
  if (!encoded || encoded.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    return undefined;
  }

  let value;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (decoded.length > 512) return undefined;
    value = JSON.parse(decoded);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const fields = [];
  const status = String(value.status ?? "");
  if (/^\d{3}$/u.test(status)) fields.push(`status=${status}`);
  const schemes = typeof value.schemes === "string" ? value.schemes.trim() : "";
  if (schemes && /^[A-Za-z0-9 ,._-]{1,48}$/u.test(schemes)) fields.push(`schemes=${schemes}`);
  const code = typeof value.error === "string" ? value.error.trim() : "";
  if (code && /^[A-Za-z0-9_.:-]{1,64}$/u.test(code)) fields.push(`error=${code}`);
  return fields.length > 0 ? fields.join(", ") : undefined;
}

function toProviderError(error, fallbackStage = "network") {
  if (error?.name === "AbortError") {
    return { stage: "cancelled", code: "request_aborted", message: "Request cancelled", retryable: false };
  }
  if (error?.providerCode === "invalid_grant" || error?.providerCode === "invalid_client") {
    return { stage: "token", code: "invalid_refresh_token", message: "Outlook refresh token 无效、过期或已撤销", retryable: false };
  }
  if (error?.providerCode === "imap_auth_failed") {
    const detail = typeof error.imapDiagnostic === "string" && error.imapDiagnostic
      ? `（${error.imapDiagnostic}）`
      : "";
    return { stage: "auth", code: "imap_auth_failed", message: `Outlook IMAP OAuth 认证失败${detail}`, retryable: false };
  }
  if (error?.code === "ETIMEDOUT") {
    return { stage: "network", code: "timeout", message: "Outlook 邮箱连接超时", retryable: true };
  }
  if (Number.isInteger(error?.status) && error.status >= 500) {
    return { stage: "token", code: "token_server_error", message: "微软 token 服务暂时不可用", retryable: true };
  }
  return {
    stage: fallbackStage,
    code: "outlook_local_failed",
    message: "本地 Outlook 邮箱查询失败",
    retryable: true
  };
}

function failedResult(account, error) {
  return {
    ok: false,
    providerId: OUTLOOK_LOCAL_PROVIDER_ID,
    address: account.address,
    messages: [],
    codes: [],
    error
  };
}

function invalidResult(error, operation = "query") {
  return {
    ok: false,
    providerId: OUTLOOK_LOCAL_PROVIDER_ID,
    operation,
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

function readCredential(credentials, keys) {
  if (!credentials || typeof credentials !== "object") return "";
  for (const key of keys) {
    if (typeof credentials[key] === "string" && credentials[key].trim()) {
      return credentials[key].trim();
    }
  }
  return "";
}

function requireField(value, name) {
  const field = String(value || "").trim();
  if (!field) throw new Error(`Outlook local OAuth ${name} is required`);
  return field;
}

function safeMessage(error, fallback) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message || fallback).replace(/[\r\n\t]+/gu, " ").slice(0, 160);
}

function normalizeMaxMessages(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(1, Math.min(50, Math.floor(number)))
    : OUTLOOK_LOCAL_MAX_MESSAGES;
}

function normalizeSearchDays(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(365, Math.floor(number))) : OUTLOOK_LOCAL_SEARCH_DAYS;
}

function formatImapDate(value) {
  const date = new Date(value);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(date.getUTCDate()).padStart(2, "0")}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function normalizeTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : OUTLOOK_LOCAL_DEFAULT_TIMEOUT_MS;
}

function accessTokenCacheKey(account) {
  return `${String(account.address || "").trim().toLowerCase()}\u0000${String(account.credentials.clientId || "").trim()}`;
}

function normalizeTokenLifetimeSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return OUTLOOK_LOCAL_ACCESS_TOKEN_DEFAULT_TTL_MS;
  }
  return Math.floor(number * 1000);
}

function normalizeTokenLifetimeMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : OUTLOOK_LOCAL_ACCESS_TOKEN_DEFAULT_TTL_MS;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = {
  OUTLOOK_IMAP_HOST,
  OUTLOOK_IMAP_PORT,
  OUTLOOK_IMAP_SCOPE,
  OUTLOOK_LOCAL_DEFAULT_TIMEOUT_MS,
  OUTLOOK_LOCAL_DISPLAY_NAME,
  OUTLOOK_LOCAL_MAX_MESSAGES,
  OUTLOOK_LOCAL_SEARCH_DAYS,
  OUTLOOK_LOCAL_ACCESS_TOKEN_DEFAULT_TTL_MS,
  OUTLOOK_LOCAL_ACCESS_TOKEN_REFRESH_SKEW_MS,
  OUTLOOK_LOCAL_PROVIDER_ID,
  OUTLOOK_TOKEN_ENDPOINT,
  ImapClient,
  OutlookLocalProvider,
  parseOutlookLocalImport,
  parseOutlookLocalLine,
  parseRawEmail,
  formatImapDate
};
