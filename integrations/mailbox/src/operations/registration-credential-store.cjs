"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * Shared persistence for registration credentials.
 *
 * Provider-specific adapters supply only validation and stable storage
 * identifiers. The payload and recovery behavior intentionally stay
 * compatible with the original provider stores.
 */
class RegistrationCredentialStore {
  constructor({
    secretStore,
    backupStore,
    storeKey,
    missingStoreMessage = "Credential store requires a secret store",
    emptyMessage = "请填写凭证",
    normalize = normalizeCredential,
    validate = () => {},
    mask = maskCredential
  } = {}) {
    if (!isStore(secretStore)) {
      throw new TypeError(missingStoreMessage);
    }
    this.secretStore = secretStore;
    this.backupStore = isStore(backupStore) ? backupStore : undefined;
    this.storeKey = storeKey;
    this.emptyMessage = emptyMessage;
    this.normalize = normalize;
    this.validate = validate;
    this.mask = mask;
    this.lock = Promise.resolve();
  }

  async get() {
    return this._exclusive(async () => {
      const primary = parseStoredCredential(
        await readStore(this.secretStore, this.storeKey),
        this.normalize
      );
      if (primary !== undefined) return primary;

      const backup = parseStoredCredential(
        await readStore(this.backupStore, this.storeKey),
        this.normalize
      );
      if (backup === undefined) return "";

      // Preserve the original recovery behavior: a backup value is returned
      // immediately, and promotion to the primary store is best effort.
      try {
        await this.secretStore.store(
          this.storeKey,
          JSON.stringify({ version: 1, token: backup })
        );
      } catch {
        // The backup already made the credential available; retry on a later save.
      }
      return backup;
    });
  }

  async snapshot() {
    const token = await this.get();
    return {
      configured: Boolean(token),
      masked: this.mask(token)
    };
  }

  async set(value) {
    const token = this.normalize(value);
    if (!token) throw new Error(this.emptyMessage);
    this.validate(token);

    return this._exclusive(async () => {
      await this._save(token);
      return { configured: true, masked: this.mask(token) };
    });
  }

  async clear() {
    return this._exclusive(async () => {
      await this._save("");
      return { configured: false, masked: "" };
    });
  }

  async _save(token) {
    const value = JSON.stringify({ version: 1, token });
    let saved = false;
    let firstError;
    for (const store of [this.secretStore, this.backupStore]) {
      if (!store) continue;
      try {
        await store.store(this.storeKey, value);
        saved = true;
      } catch (error) {
        firstError ||= error;
      }
    }
    if (!saved && firstError) throw firstError;
  }

  async _exclusive(task) {
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

function createLocalCredentialStore(storageUri, fileName) {
  const root = typeof storageUri?.fsPath === "string" ? storageUri.fsPath : "";
  if (!root) return undefined;
  const filePath = path.join(root, fileName);
  return {
    async get() {
      try {
        return await fs.readFile(filePath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async store(_key, value) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.writeFile(filePath, value, { encoding: "utf8", mode: 0o600 });
      try {
        await fs.chmod(filePath, 0o600);
      } catch {
        // SecretStorage remains the primary store on platforms without chmod.
      }
    }
  };
}

function parseStoredCredential(raw, normalize) {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return normalize(parsed);
    return parsed && typeof parsed === "object" ? normalize(parsed.token) : undefined;
  } catch {
    return undefined;
  }
}

function maskCredential(value) {
  const token = normalizeCredential(value);
  if (!token) return "";
  if (token.length <= 8) return `${token.slice(0, 2)}…${token.slice(-2)}`;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function normalizeCredential(value) {
  return String(value ?? "").trim();
}

function isStore(store) {
  return Boolean(store && typeof store.get === "function" && typeof store.store === "function");
}

async function readStore(store, key) {
  if (!store) return undefined;
  try {
    return await store.get(key);
  } catch {
    return undefined;
  }
}

module.exports = {
  RegistrationCredentialStore,
  createLocalCredentialStore,
  maskCredential,
  normalizeCredential
};
