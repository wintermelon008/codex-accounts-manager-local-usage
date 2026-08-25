"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { METADATA_KEY, POOL_SCHEMA_VERSION, detailKey, secretKey } = require("./storage.cjs");

const SERVER_STATE_FILE = "mailbox-shared-state.v1.json";
const SERVER_SECRET_FILE = "mailbox-shared-secrets.v1.json";
const REGISTRATION_SESSION_FILE = "registration-sessions.v1.json";
const REGISTRATION_SESSIONS_KEY = "codexAccounts.mailbox.registrationSessions.v1";
const LEGACY_MIGRATION_KEY = "codexAccounts.mailbox.serverStorageMigration.v1";

/**
 * Mailbox data belongs to the extension host, not to a VS Code client.
 *
 * VS Code globalState/SecretStorage can be scoped differently by local and
 * remote extension hosts. The shared files below live under globalStorageUri,
 * which is the server-side extension directory for a workspace extension.
 * Credentials and mail details are kept in owner-only files; they are never
 * put into the public metadata object.
 */
function createServerMailboxStores({ storageUri, legacyMetadataStore, legacySecretStore, sourceId } = {}) {
  const root = typeof storageUri?.fsPath === "string" ? storageUri.fsPath : "";
  if (!root) {
    return {
      shared: false,
      metadataStore: legacyMetadataStore,
      secretStore: legacySecretStore,
      migrateLegacy: async () => false
    };
  }

  const metadataStore = new JsonFileKeyValueStore(path.join(root, SERVER_STATE_FILE), {
    fallback: legacyMetadataStore
  });
  const secretStore = new JsonFileKeyValueStore(path.join(root, SERVER_SECRET_FILE), {
    fallback: legacySecretStore
  });

  return {
    shared: true,
    metadataStore,
    secretStore,
    migrateLegacy: () => migrateLegacyMailboxState({
      metadataStore,
      secretStore,
      legacyMetadataStore,
      legacySecretStore,
      sourceId
    })
  };
}

function createServerRegistrationSessionStore({ storageUri, legacyStore } = {}) {
  const root = typeof storageUri?.fsPath === "string" ? storageUri.fsPath : "";
  const store = root
    ? new JsonFileKeyValueStore(path.join(root, REGISTRATION_SESSION_FILE), { fallback: legacyStore })
    : legacyStore;

  return {
    shared: Boolean(root),
    async load() {
      const raw = await store?.get?.(REGISTRATION_SESSIONS_KEY);
      return normalizeRegistrationSessions(raw);
    },
    async save(records) {
      const value = normalizeRegistrationSessions(records);
      if (typeof store?.update === "function") {
        await store.update(REGISTRATION_SESSIONS_KEY, value);
      } else if (typeof store?.store === "function") {
        await store.store(REGISTRATION_SESSIONS_KEY, value);
      }
    }
  };
}

class JsonFileKeyValueStore {
  constructor(filePath, { fallback } = {}) {
    this.filePath = filePath;
    this.fallback = isStore(fallback) ? fallback : undefined;
    this.lock = Promise.resolve();
  }

  async get(key) {
    const state = await this.readLocalState();
    if (Object.prototype.hasOwnProperty.call(state.values, key)) {
      return cloneValue(state.values[key]);
    }
    if (state.exists || !this.fallback) {
      return undefined;
    }

    const legacyValue = await this.fallback.get(key);
    if (legacyValue === undefined) {
      return undefined;
    }
    await this.update(key, legacyValue);
    return cloneValue(legacyValue);
  }

  async update(key, value) {
    const normalizedKey = String(key || "");
    if (!normalizedKey) {
      throw new Error("Shared mailbox storage key is required");
    }
    return this.exclusive(async () => {
      const state = await this.readLocalState();
      if (value === undefined) {
        delete state.values[normalizedKey];
      } else {
        state.values[normalizedKey] = cloneValue(value);
      }
      await writeJsonAtomically(this.filePath, { version: 1, values: state.values });
    });
  }

  async store(key, value) {
    return this.update(key, value);
  }

  async delete(key) {
    return this.update(key, undefined);
  }

  async hasLocal(key) {
    const state = await this.readLocalState();
    return Object.prototype.hasOwnProperty.call(state.values, key);
  }

  async readLocal(key) {
    const state = await this.readLocalState();
    return Object.prototype.hasOwnProperty.call(state.values, key)
      ? cloneValue(state.values[key])
      : undefined;
  }

  async readLocalState() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.values || typeof parsed.values !== "object") {
        throw new Error(`Invalid shared mailbox storage: ${this.filePath}`);
      }
      return { exists: true, values: { ...parsed.values } };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, values: {} };
      }
      throw error;
    }
  }

  async exclusive(task) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

async function migrateLegacyMailboxState({
  metadataStore,
  secretStore,
  legacyMetadataStore,
  legacySecretStore,
  sourceId
} = {}) {
  if (!isStore(legacyMetadataStore) || !isStore(legacySecretStore)) {
    return false;
  }

  const migrationSource = typeof sourceId === "string" && sourceId.trim() ? sourceId.trim() : "default";
  const markers = normalizeMigrationMarkers(await legacyMetadataStore.get(LEGACY_MIGRATION_KEY));
  if (markers[migrationSource]) {
    return false;
  }

  const legacyMetadata = await legacyMetadataStore.get(METADATA_KEY);
  const legacyAccounts = Array.isArray(legacyMetadata?.accounts) ? legacyMetadata.accounts : [];
  const currentMetadata = normalizePoolMetadata(await metadataStore.readLocal(METADATA_KEY));
  const known = new Set(currentMetadata.accounts.map((account) => account.id));
  let changed = false;

  for (const account of legacyAccounts) {
    if (!account || typeof account.id !== "string" || !account.id || known.has(account.id)) {
      continue;
    }
    currentMetadata.accounts.push(cloneValue(account));
    known.add(account.id);
    changed = true;
  }

  if (changed) {
    await metadataStore.update(METADATA_KEY, currentMetadata);
  }

  for (const account of legacyAccounts) {
    const id = typeof account?.id === "string" ? account.id : "";
    if (!id) continue;

    if (!(await secretStore.hasLocal(secretKey(id)))) {
      const rawSecret = await legacySecretStore.get(secretKey(id));
      if (rawSecret !== undefined) {
        await secretStore.update(secretKey(id), rawSecret);
      }
    }

    const key = detailKey(id);
    if (!(await metadataStore.hasLocal(key))) {
      const detail = await legacyMetadataStore.get(key);
      if (detail !== undefined) {
        await metadataStore.update(key, detail);
      }
    }
  }

  markers[migrationSource] = Date.now();
  await legacyMetadataStore.update(LEGACY_MIGRATION_KEY, markers);
  return changed;
}

function normalizePoolMetadata(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.accounts)) {
    return { version: POOL_SCHEMA_VERSION, accounts: [] };
  }
  return {
    version: POOL_SCHEMA_VERSION,
    accounts: value.accounts.filter((account) => account && typeof account === "object")
  };
}

function normalizeMigrationMarkers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key, timestamp]) => typeof key === "string" && Number.isFinite(timestamp))
  );
}

function normalizeRegistrationSessions(value) {
  const records = Array.isArray(value) ? value : value?.sessions;
  if (!Array.isArray(records)) {
    return [];
  }
  return records
    .filter((record) => record && typeof record === "object" && typeof record.id === "string" && record.id)
    .map((record) => ({
      id: record.id,
      email: typeof record.email === "string" ? record.email : "",
      mode: record.mode === "oauth" ? "oauth" : "playwright",
      state: typeof record.state === "string" ? record.state : "idle",
      phoneInputCount: Number.isFinite(record.phoneInputCount) ? Math.max(0, Math.floor(record.phoneInputCount)) : 0,
      name: typeof record.name === "string" ? record.name : "jdd",
      age: Number.isFinite(record.age) ? record.age : 24,
      result: sanitizeRegistrationResult(record.result),
      error: typeof record.error === "string" ? record.error.slice(0, 160) : "",
      feedback: typeof record.feedback === "string" ? record.feedback.slice(0, 240) : "",
      feedbackLevel: typeof record.feedbackLevel === "string" ? record.feedbackLevel : "info",
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : undefined,
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : undefined
    }));
}

function sanitizeRegistrationResult(result) {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  return {
    email: typeof result.email === "string" ? result.email : undefined,
    accountId: typeof result.accountId === "string" ? result.accountId : undefined,
    quotaRefreshed: typeof result.quotaRefreshed === "boolean" ? result.quotaRefreshed : undefined,
    quotaError: typeof result.quotaError === "string" ? result.quotaError.slice(0, 160) : undefined
  };
}

function isStore(store) {
  return Boolean(
    store &&
      typeof store.get === "function" &&
      (typeof store.update === "function" || typeof store.store === "function")
  );
}

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600).catch(() => undefined);
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

module.exports = {
  LEGACY_MIGRATION_KEY,
  REGISTRATION_SESSION_FILE,
  REGISTRATION_SESSIONS_KEY,
  SERVER_SECRET_FILE,
  SERVER_STATE_FILE,
  JsonFileKeyValueStore,
  createServerRegistrationSessionStore,
  createServerMailboxStores,
  migrateLegacyMailboxState
};
