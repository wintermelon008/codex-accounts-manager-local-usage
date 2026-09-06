"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_STORE_KEY = "codexAccounts.mailbox.registration.fivesimToken.v1";
const DEFAULT_FILE_NAME = "registration-fivesim-token.v1.json";

class FiveSimTokenStore {
  constructor({ secretStore, backupStore, storeKey = DEFAULT_STORE_KEY } = {}) {
    if (!isStore(secretStore)) {
      throw new TypeError("5SIM token store requires a secret store");
    }
    this.secretStore = secretStore;
    this.backupStore = isStore(backupStore) ? backupStore : undefined;
    this.storeKey = storeKey;
    this.lock = Promise.resolve();
  }

  async get() {
    return this._exclusive(async () => {
      const primary = parseStoredToken(await readStore(this.secretStore, this.storeKey));
      if (primary !== undefined) return primary;
      const backup = parseStoredToken(await readStore(this.backupStore, this.storeKey));
      if (backup === undefined) return "";
      try {
        await this.secretStore.store(this.storeKey, JSON.stringify({ version: 1, token: backup }));
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
      masked: maskFiveSimToken(token)
    };
  }

  async set(value) {
    const token = normalizeToken(value);
    if (!token) throw new Error("请填写 5SIM API Token");
    if (token.length > 2048) throw new Error("5SIM API Token 过长");
    return this._exclusive(async () => {
      await this._save(token);
      return { configured: true, masked: maskFiveSimToken(token) };
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

function createLocalFiveSimTokenStore(storageUri) {
  const root = typeof storageUri?.fsPath === "string" ? storageUri.fsPath : "";
  if (!root) return undefined;
  const filePath = path.join(root, DEFAULT_FILE_NAME);
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

function parseStoredToken(raw) {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return normalizeToken(parsed);
    return parsed && typeof parsed === "object" ? normalizeToken(parsed.token) : undefined;
  } catch {
    return undefined;
  }
}

function maskFiveSimToken(value) {
  const token = normalizeToken(value);
  if (!token) return "";
  if (token.length <= 8) return `${token.slice(0, 2)}…${token.slice(-2)}`;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function normalizeToken(value) {
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
  DEFAULT_FILE_NAME,
  DEFAULT_STORE_KEY,
  FiveSimTokenStore,
  createLocalFiveSimTokenStore,
  maskFiveSimToken,
  normalizeToken
};
