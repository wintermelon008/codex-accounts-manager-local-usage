"use strict";

const crypto = require("node:crypto");
const { normalizeMailboxAccount, normalizeMailboxAddress } = require("../core/account.cjs");
const { isOpenAiAccountDeactivatedMessage, isOpenAiMessage } = require("../core/messages.cjs");

// This is intentionally a new namespace. The redesign is a clean install and
// must not accidentally read provider-specific data from the old extension.
const METADATA_KEY = "codexAccounts.mailbox.pool.v2";
const DETAIL_KEY_PREFIX = "codexAccounts.mailbox.detail.";
const SECRET_KEY_PREFIX = "codexAccounts.mailbox.credential.";
const POOL_SCHEMA_VERSION = 2;
const MAX_STORED_MESSAGES = 20;

class MailboxPool {
  constructor({ metadataStore, secretStore, now = () => Date.now() }) {
    if (!metadataStore || typeof metadataStore.get !== "function" || typeof metadataStore.update !== "function") {
      throw new TypeError("Mailbox metadata store must provide get and update");
    }
    if (
      !secretStore ||
      typeof secretStore.get !== "function" ||
      typeof secretStore.store !== "function" ||
      typeof secretStore.delete !== "function"
    ) {
      throw new TypeError("Mailbox secret store must provide get, store and delete");
    }
    this.metadataStore = metadataStore;
    this.secretStore = secretStore;
    this.now = now;
    this.metadata = emptyMetadata();
    this.loaded = false;
    this.deactivationBackfillDone = false;
    // Metadata changes are read-modify-write operations on one shared index.
    this.metadataOperationQueue = Promise.resolve();
  }

  async load() {
    return this.enqueueMetadataOperation(() => this.loadFromStore());
  }

  async loadFromStore() {
    const raw = await this.metadataStore.get(METADATA_KEY);
    this.metadata = parseMetadata(raw);
    this.loaded = true;
    if (!this.deactivationBackfillDone) {
      await this.backfillOpenAiAccountDeactivationFlags();
      this.deactivationBackfillDone = true;
    }
    return this.getMetadata();
  }

  async reload() {
    return this.load();
  }

  isLoaded() {
    return this.loaded;
  }

  async backfillOpenAiAccountDeactivationFlags() {
    this.assertLoaded();
    let changed = false;
    for (const metadata of this.metadata.accounts) {
      const detail = await this.metadataStore.get(detailKey(metadata.id));
      const messages = normalizeStoredMessages(detail?.messages);
      const hasDeactivationNotice = messages.some(isOpenAiAccountDeactivatedMessage);
      const firstOpenAiEmailAt = mergeFirstOpenAiEmailAt(metadata.firstOpenAiEmailAt, findFirstOpenAiEmailAt(messages));
      if (metadata.openaiAccountDeactivated !== hasDeactivationNotice || metadata.firstOpenAiEmailAt !== firstOpenAiEmailAt) {
        metadata.openaiAccountDeactivated = hasDeactivationNotice;
        metadata.firstOpenAiEmailAt = firstOpenAiEmailAt;
        changed = true;
      }
    }
    if (changed) {
      await this.persistMetadata();
    }
    return changed;
  }

  getMetadata() {
    return {
      version: this.metadata.version,
      accounts: this.metadata.accounts.map((account) => sanitizeMetadata(account))
    };
  }

  listMetadata({ includeDisabled = true } = {}) {
    this.assertLoaded();
    const accounts = includeDisabled
      ? this.metadata.accounts
      : this.metadata.accounts.filter((account) => account.enabled !== false);
    return accounts.map((account) => sanitizeMetadata(account));
  }

  async listAccounts({ includeDisabled = true } = {}) {
    await this.load();
    this.assertLoaded();
    const accounts = includeDisabled
      ? this.metadata.accounts
      : this.metadata.accounts.filter((account) => account.enabled !== false);
    const result = [];
    for (const metadata of accounts) {
      const account = await this.readAccount(metadata.id);
      if (account) {
        result.push(account);
      }
    }
    return result;
  }

  async getAccount(id) {
    await this.load();
    this.assertLoaded();
    return this.metadata.accounts.some((account) => account.id === id) ? this.readAccount(id) : undefined;
  }

  async getDetail(id) {
    await this.load();
    this.assertLoaded();
    if (!this.metadata.accounts.some((account) => account.id === id)) {
      return undefined;
    }
    const raw = await this.metadataStore.get(detailKey(id));
    return sanitizeDetail(raw, id);
  }

  async importProvider({ provider, input, displayName } = {}) {
    return this.enqueueMetadataOperation(async () => {
      await this.loadFromStore();
      this.assertLoaded();
      if (!provider || typeof provider.parseImport !== "function") {
        throw new TypeError("A mailbox provider is required for import");
      }

      const parsed = provider.parseImport(input);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const imported = [];
      const failed = Array.isArray(parsed?.failed) ? parsed.failed.map(sanitizeImportFailure) : [];

      for (const entry of entries) {
        try {
          const normalized = normalizeImportedEntry(entry);
          const id = makeMailboxId(provider.id, normalized.address);
          const previous = this.metadata.accounts.find((account) => account.id === id);
          const timestamp = this.now();
          await this.secretStore.store(
            secretKey(id),
            JSON.stringify({ providerId: provider.id, address: normalized.address, credentials: normalized.credentials })
          );
          const next = {
            id,
            providerId: provider.id,
            address: normalized.address,
            displayName: normalizeDisplayName(displayName, normalized.address),
            enabled: previous?.enabled !== false,
            createdAt: previous?.createdAt ?? timestamp,
            updatedAt: timestamp,
            lastQueryAt: previous?.lastQueryAt,
            lastRenewalAt: previous?.lastRenewalAt,
            lastStatus: previous?.lastStatus,
            lastError: previous?.lastError,
            latestCode: previous?.latestCode,
            latestMessage: previous?.latestMessage,
            messageCount: previous?.messageCount ?? 0,
            openaiAccountDeactivated: previous?.openaiAccountDeactivated === true,
            firstOpenAiEmailAt: previous?.firstOpenAiEmailAt,
            gptRegistered: previous?.gptRegistered === true,
            gptRegisteredAt: numberOrUndefined(previous?.gptRegisteredAt),
            historyMode: provider.capabilities?.history === "latest" ? "latest" : "recent"
          };
          replaceMetadataAccount(this.metadata.accounts, next);
          imported.push(sanitizeMetadata(next));
        } catch (error) {
          failed.push({ line: undefined, message: safeMessage(error, "Invalid mailbox entry") });
        }
      }

      if (imported.length > 0) {
        await this.persistMetadata();
      }
      return { imported, failed };
    });
  }

  async recordQueryResult(id, result, { historyMode } = {}) {
    return this.enqueueMetadataOperation(async () => {
      await this.loadFromStore();
      this.assertLoaded();
      const metadata = this.requireMetadata(id);
      const timestamp = this.now();
      metadata.lastQueryAt = timestamp;
      metadata.updatedAt = timestamp;
      metadata.lastStatus = result?.ok ? (result.codes?.length ? "code_found" : "ready") : "error";
      metadata.lastError = result?.ok ? undefined : sanitizeError(result?.error);
      if (result?.ok) {
        const messages = normalizeStoredMessages(result.messages);
        metadata.openaiAccountDeactivated = messages.some(isOpenAiAccountDeactivatedMessage);
        metadata.firstOpenAiEmailAt = mergeFirstOpenAiEmailAt(metadata.firstOpenAiEmailAt, findFirstOpenAiEmailAt(messages));
        metadata.latestCode = firstCode(result.codes, messages);
        metadata.latestMessage = messages[0] ? summarizeMessage(messages[0]) : undefined;
        metadata.messageCount = messages.length;
        if (historyMode === "latest" || historyMode === "recent") {
          metadata.historyMode = historyMode;
        }
        await this.metadataStore.update(detailKey(id), {
          mailboxId: id,
          providerId: metadata.providerId,
          fetchedAt: result.fetchedAt ?? new Date(timestamp).toISOString(),
          codes: normalizeCodes(result.codes),
          messages
        });
      }
      await this.persistMetadata();
      return sanitizeMetadata(metadata);
    });
  }

  async recordRenewalResult(id, result) {
    return this.enqueueMetadataOperation(async () => {
      await this.loadFromStore();
      this.assertLoaded();
      const metadata = this.requireMetadata(id);
      const timestamp = this.now();
      metadata.updatedAt = timestamp;

      if (result?.ok && result.status === "updated" && result.account) {
        const current = await this.readAccount(id);
        if (!current) {
          throw new Error("Mailbox credentials are unavailable");
        }
        const updated = normalizeImportedEntry(result.account);
        if (updated.address.toLowerCase() !== metadata.address.toLowerCase()) {
          throw new Error("Provider renewal changed the mailbox address");
        }
        await this.secretStore.store(
          secretKey(id),
          JSON.stringify({ providerId: metadata.providerId, address: metadata.address, credentials: updated.credentials })
        );
        metadata.lastRenewalAt = timestamp;
        metadata.lastStatus = "renewed";
        metadata.lastError = undefined;
      } else if (result?.ok && result.status === "unchanged") {
        metadata.lastStatus = "unchanged";
        metadata.lastError = undefined;
      } else {
        metadata.lastStatus = "error";
        metadata.lastError = sanitizeError(result?.error);
      }

      await this.persistMetadata();
      return sanitizeMetadata(metadata);
    });
  }

  async setDisplayName(id, displayName) {
    return this.enqueueMetadataOperation(async () => {
      await this.loadFromStore();
      this.assertLoaded();
      const metadata = this.requireMetadata(id);
      metadata.displayName = normalizeDisplayName(displayName, metadata.address);
      metadata.updatedAt = this.now();
      await this.persistMetadata();
      return sanitizeMetadata(metadata);
    });
  }

  async markGptRegistered(id) {
    return this.enqueueMetadataOperation(async () => {
      await this.loadFromStore();
      this.assertLoaded();
      const metadata = this.requireMetadata(id);
      if (metadata.gptRegistered !== true) {
        metadata.gptRegistered = true;
        metadata.gptRegisteredAt = numberOrUndefined(metadata.gptRegisteredAt) ?? this.now();
        metadata.updatedAt = this.now();
        await this.persistMetadata();
      }
      return sanitizeMetadata(metadata);
    });
  }

  async updateAccount(id, { provider, providerId, input, displayName } = {}) {
    return this.enqueueMetadataOperation(async () => {
      await this.loadFromStore();
      this.assertLoaded();
      const metadata = this.requireMetadata(id);
      const replacement = typeof input === "string" && input.trim() ? input.trim() : undefined;
      const nextProviderId = typeof providerId === "string" && providerId ? providerId : metadata.providerId;
      const providerChanged = nextProviderId !== metadata.providerId;

      if (providerChanged || replacement) {
        if (!provider || provider.id !== nextProviderId || typeof provider.parseImport !== "function") {
          throw new Error("Mailbox provider is unavailable for credential editing");
        }
        if (!replacement) {
          throw new Error("切换邮箱来源 / 格式时必须填写凭据");
        }
        const parsed = provider.parseImport(replacement);
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
        const failed = Array.isArray(parsed?.failed) ? parsed.failed : [];
        if (failed.length > 0 || entries.length !== 1) {
          throw new Error("替换凭据时必须提供一行有效的邮箱来源格式");
        }
        const normalized = normalizeImportedEntry(entries[0]);
        if (normalized.address.toLowerCase() !== metadata.address.toLowerCase()) {
          throw new Error("编辑凭据不能更改邮箱地址；如需新增地址，请重新导入");
        }
        await this.secretStore.store(
          secretKey(id),
          JSON.stringify({ providerId: nextProviderId, address: metadata.address, credentials: normalized.credentials })
        );
        if (providerChanged) {
          await this.metadataStore.update(detailKey(id), undefined);
          metadata.latestCode = undefined;
          metadata.latestMessage = undefined;
          metadata.messageCount = 0;
          metadata.openaiAccountDeactivated = false;
          metadata.firstOpenAiEmailAt = undefined;
          metadata.lastStatus = undefined;
          metadata.lastError = undefined;
          metadata.lastQueryAt = undefined;
          metadata.lastRenewalAt = undefined;
        }
        metadata.providerId = nextProviderId;
        metadata.historyMode = provider.capabilities?.history === "latest" ? "latest" : "recent";
      }

      metadata.displayName = normalizeDisplayName(displayName, metadata.address);
      metadata.updatedAt = this.now();
      await this.persistMetadata();
      return sanitizeMetadata(metadata);
    });
  }

  async deleteAccount(id) {
    return this.enqueueMetadataOperation(async () => {
      await this.loadFromStore();
      this.assertLoaded();
      const index = this.metadata.accounts.findIndex((account) => account.id === id);
      if (index === -1) {
        throw new Error("Mailbox is not in the provider-neutral pool");
      }

      // Remove private material before removing the public index entry. If a
      // storage operation fails, the account remains visible for recovery.
      await this.secretStore.delete(secretKey(id));
      await this.metadataStore.update(detailKey(id), undefined);
      this.metadata.accounts.splice(index, 1);
      await this.persistMetadata();
    });
  }

  async setEnabled(id, enabled) {
    return this.enqueueMetadataOperation(async () => {
      await this.loadFromStore();
      this.assertLoaded();
      const metadata = this.requireMetadata(id);
      metadata.enabled = enabled === true;
      metadata.updatedAt = this.now();
      await this.persistMetadata();
      return sanitizeMetadata(metadata);
    });
  }

  async readAccount(id) {
    const metadata = this.metadata.accounts.find((account) => account.id === id);
    if (!metadata) {
      return undefined;
    }
    const raw = await this.secretStore.get(secretKey(id));
    if (typeof raw !== "string") {
      return undefined;
    }
    try {
      const stored = JSON.parse(raw);
      const credentials = stored?.credentials && typeof stored.credentials === "object"
        ? stored.credentials
        : stored;
      return {
        id,
        providerId: metadata.providerId,
        enabled: metadata.enabled !== false,
        address: metadata.address,
        displayName: metadata.displayName,
        credentials: { ...credentials }
      };
    } catch {
      return undefined;
    }
  }

  async persistMetadata() {
    await this.metadataStore.update(METADATA_KEY, this.metadata);
  }

  enqueueMetadataOperation(operation) {
    // Provider calls may run in parallel; their shared metadata read-modify-write needs ordering.
    const next = this.metadataOperationQueue.then(operation, operation);
    this.metadataOperationQueue = next.catch(() => undefined);
    return next;
  }

  assertLoaded() {
    if (!this.loaded) {
      throw new Error("Mailbox pool has not been loaded");
    }
  }

  requireMetadata(id) {
    const metadata = this.metadata.accounts.find((account) => account.id === id);
    if (!metadata) {
      throw new Error("Mailbox is not in the provider-neutral pool");
    }
    return metadata;
  }
}

function normalizeImportedEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("Mailbox import entry must be an object");
  }
  const normalized = normalizeMailboxAccount({ address: entry.address ?? entry.email, credentials: entry.credentials });
  return normalized;
}

function emptyMetadata() {
  return { version: POOL_SCHEMA_VERSION, accounts: [] };
}

function parseMetadata(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== POOL_SCHEMA_VERSION || !Array.isArray(raw.accounts)) {
    return emptyMetadata();
  }
  return {
    version: POOL_SCHEMA_VERSION,
    accounts: raw.accounts.filter(isMetadataEntry).map(sanitizeMetadata)
  };
}

function isMetadataEntry(entry) {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      typeof entry.id === "string" &&
      typeof entry.providerId === "string" &&
      typeof entry.address === "string" &&
      entry.address.length > 0
  );
}

function sanitizeMetadata(entry) {
  return {
    id: entry.id,
    providerId: entry.providerId,
    address: entry.address,
    displayName: normalizeDisplayName(entry.displayName, entry.address),
    enabled: entry.enabled !== false,
    createdAt: numberOrUndefined(entry.createdAt),
    updatedAt: numberOrUndefined(entry.updatedAt),
    lastQueryAt: numberOrUndefined(entry.lastQueryAt),
    lastRenewalAt: numberOrUndefined(entry.lastRenewalAt),
    lastStatus: typeof entry.lastStatus === "string" ? entry.lastStatus : undefined,
    lastError: sanitizeError(entry.lastError),
    latestCode: typeof entry.latestCode === "string" ? entry.latestCode : undefined,
    latestMessage: entry.latestMessage ? summarizeMessage(entry.latestMessage) : undefined,
    messageCount: Number.isFinite(entry.messageCount) ? Math.max(0, Math.floor(entry.messageCount)) : 0,
    openaiAccountDeactivated: entry.openaiAccountDeactivated === true,
    firstOpenAiEmailAt: stringOrUndefined(entry.firstOpenAiEmailAt),
    gptRegistered: entry.gptRegistered === true,
    gptRegisteredAt: numberOrUndefined(entry.gptRegisteredAt),
    historyMode: entry.historyMode === "latest" ? "latest" : "recent"
  };
}

function sanitizeDetail(value, id) {
  if (!value || typeof value !== "object") {
    return { mailboxId: id, fetchedAt: undefined, codes: [], messages: [] };
  }
  return {
    mailboxId: id,
    providerId: typeof value.providerId === "string" ? value.providerId : undefined,
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : undefined,
    codes: normalizeCodes(value.codes),
    messages: normalizeStoredMessages(value.messages)
  };
}

function normalizeStoredMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.slice(0, MAX_STORED_MESSAGES).filter((message) => message && typeof message === "object").map((message) => ({
    id: stringOrUndefined(message.id ?? message.fingerprint),
    fingerprint: stringOrUndefined(message.fingerprint ?? message.id),
    subject: safeText(message.subject, "Untitled message"),
    from: safeText(message.from),
    senderName: safeText(message.senderName),
    receivedAt: stringOrUndefined(message.receivedAt),
    preview: safeText(message.preview),
    body: safeText(message.body),
    codes: normalizeCodes(message.codes)
  }));
}

function findFirstOpenAiEmailAt(messages) {
  const timestamps = messages
    .filter(isOpenAiMessage)
    .map((message) => Date.parse(message.receivedAt || ""))
    .filter(Number.isFinite);
  if (timestamps.length === 0) return undefined;
  return new Date(Math.min(...timestamps)).toISOString();
}

function mergeFirstOpenAiEmailAt(current, candidate) {
  if (!candidate) return stringOrUndefined(current);
  const candidateTimestamp = Date.parse(candidate);
  if (!Number.isFinite(candidateTimestamp)) return stringOrUndefined(current);
  const currentTimestamp = Date.parse(String(current || ""));
  return !Number.isFinite(currentTimestamp) || candidateTimestamp < currentTimestamp
    ? new Date(candidateTimestamp).toISOString()
    : stringOrUndefined(current);
}

function summarizeMessage(message) {
  const normalized = normalizeStoredMessages([message])[0];
  if (!normalized) {
    return undefined;
  }
  const { body: _body, ...summary } = normalized;
  return summary;
}

function firstCode(codes, messages) {
  return normalizeCodes(codes)[0] ?? messages.flatMap((message) => message.codes).find(Boolean);
}

function normalizeCodes(codes) {
  return Array.isArray(codes) ? [...new Set(codes.filter((code) => typeof code === "string" && /^\d{6}$/u.test(code)))] : [];
}

function normalizeDisplayName(value, fallback) {
  const candidate = typeof value === "string" ? value.trim().replace(/[\r\n\t]+/gu, " ") : "";
  return (candidate || fallback).slice(0, 160);
}

function safeText(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, 8_000) : fallback;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value ? value : undefined;
}

function numberOrUndefined(value) {
  return Number.isFinite(value) ? value : undefined;
}

function sanitizeImportFailure(value) {
  return {
    line: Number.isInteger(value?.line) ? value.line : undefined,
    message: safeMessage(value?.message, "Invalid provider row")
  };
}

function sanitizeError(error) {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return {
    stage: typeof error.stage === "string" ? error.stage.slice(0, 32) : "provider",
    code: typeof error.code === "string" ? error.code.slice(0, 64) : "request_failed",
    message: safeMessage(error.message, "Mailbox operation failed"),
    retryable: error.retryable === true
  };
}

function safeMessage(value, fallback) {
  const message = typeof value === "string" ? value.replace(/[\r\n\t]+/gu, " ").trim() : "";
  return (message || fallback).slice(0, 160);
}

function replaceMetadataAccount(accounts, next) {
  const index = accounts.findIndex((entry) => entry.id === next.id);
  if (index === -1) {
    accounts.push(next);
  } else {
    accounts[index] = next;
  }
}

function makeMailboxId(providerId, address) {
  const digest = crypto.createHash("sha256").update(`${providerId}\u0000${address.trim().toLowerCase()}`).digest("hex").slice(0, 24);
  return `mailbox:${digest}`;
}

function detailKey(id) {
  return `${DETAIL_KEY_PREFIX}${id}`;
}

function secretKey(id) {
  return `${SECRET_KEY_PREFIX}${id}`;
}

module.exports = {
  DETAIL_KEY_PREFIX,
  METADATA_KEY,
  POOL_SCHEMA_VERSION,
  SECRET_KEY_PREFIX,
  MailboxPool,
  detailKey,
  makeMailboxId,
  sanitizeMetadata,
  secretKey
};
