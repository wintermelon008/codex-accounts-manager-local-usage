"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_STORE_KEY = "codexAccounts.mailbox.registrationKeys.v1";
const DEFAULT_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Stores registration SMS keys in the configured private extension-host store.
 *
 * The webview only receives masked values and stable ids. A key is marked as
 * in_use while an order is running, released on failure/cancel, and removed
 * only after a real SMS code has been received.
 */
class RegistrationKeyPool {
  constructor({
    secretStore,
    backupStore,
    storeKey = DEFAULT_STORE_KEY,
    now = () => Date.now(),
    leaseTtlMs = DEFAULT_LEASE_TTL_MS
  } = {}) {
    if (!secretStore || typeof secretStore.get !== "function" || typeof secretStore.store !== "function") {
      throw new TypeError("Registration key pool requires VS Code SecretStorage");
    }
    this.secretStore = secretStore;
    this.backupStore = isStore(backupStore) ? backupStore : undefined;
    this.storeKey = storeKey;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.leaseTtlMs = normalizePositive(leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    this.lock = Promise.resolve();
  }

  async snapshot() {
    return this._exclusive(async () => {
      const keys = await this._load();
      if (this._recoverStale(keys)) await this._save(keys);
      keys.sort(compareKeys);
      return publicSnapshot(keys);
    });
  }

  async add(input) {
    const parsed = parseKeyInput(input);
    return this._exclusive(async () => {
      const keys = await this._load();
      const known = new Set(keys.map((key) => key.code));
      const now = this.now();
      let added = 0;
      for (const code of parsed.values) {
        if (known.has(code)) continue;
        keys.push({
          id: crypto.randomUUID(),
          code,
          status: "available",
          createdAt: now + added,
          claimedAt: 0,
          owner: ""
        });
        known.add(code);
        added += 1;
      }
      const recovered = this._recoverStale(keys);
      if (added || recovered) await this._save(keys);
      keys.sort(compareKeys);
      return { added, invalid: parsed.invalid, ...publicSnapshot(keys) };
    });
  }

  async claim(keyId, owner) {
    const id = text(keyId);
    const claimOwner = text(owner);
    if (!id) throw new Error("请选择接码平台 Key");
    if (!claimOwner) throw new Error("取号任务缺少 Key 使用标识");
    return this._exclusive(async () => {
      const keys = await this._load();
      let changed = this._recoverStale(keys);
      const key = keys.find((item) => item.id === id);
      if (!key) throw new Error("所选接码平台 Key 不存在");
      if (key.status === "in_use" && key.owner !== claimOwner) {
        throw new Error("所选接码平台 Key 正在使用，请选择其他 Key");
      }
      if (key.status !== "in_use") {
        key.status = "in_use";
        key.claimedAt = this.now();
        key.owner = claimOwner;
        changed = true;
      }
      if (changed) await this._save(keys);
      return publicKey(key, true);
    });
  }

  async release(keyId, owner) {
    const id = text(keyId);
    const claimOwner = text(owner);
    if (!id || !claimOwner) return false;
    return this._exclusive(async () => {
      const keys = await this._load();
      const key = keys.find((item) => item.id === id);
      if (!key || key.status !== "in_use" || key.owner !== claimOwner) return false;
      key.status = "available";
      key.claimedAt = 0;
      key.owner = "";
      await this._save(keys);
      return true;
    });
  }

  async consume(keyId, owner) {
    const id = text(keyId);
    const claimOwner = text(owner);
    if (!id || !claimOwner) return false;
    return this._exclusive(async () => {
      const keys = await this._load();
      const index = keys.findIndex((item) => item.id === id);
      if (index < 0) return false;
      const key = keys[index];
      if (key.status !== "in_use" || key.owner !== claimOwner) {
        throw new Error("接码平台 Key 不在当前取号任务中");
      }
      keys.splice(index, 1);
      await this._save(keys);
      return true;
    });
  }

  async remove(keyId) {
    const id = text(keyId);
    if (!id) throw new Error("请选择要删除的接码平台 Key");
    return this._exclusive(async () => {
      const keys = await this._load();
      const key = keys.find((item) => item.id === id);
      if (!key) throw new Error("接码平台 Key 不存在");
      if (key.status === "in_use") throw new Error("当前任务正在使用该 Key，不能删除");
      const kept = keys.filter((item) => item.id !== id);
      await this._save(kept);
      return { removed: 1, ...publicSnapshot(kept.sort(compareKeys)) };
    });
  }

  async _load() {
    const primaryKeys = parseStoredKeys(await readStore(this.secretStore, this.storeKey));
    if (primaryKeys) return primaryKeys;

    const backupKeys = parseStoredKeys(await readStore(this.backupStore, this.storeKey));
    if (!backupKeys) return [];

    // Rehydrate the primary store after a temporary backend failure or an
    // extension-host restart. The backup remains the recovery source.
    try {
      await this.secretStore.store(this.storeKey, JSON.stringify({ version: 1, keys: backupKeys }));
    } catch {
      // The backup already made the key pool available; retry on a later save.
    }
    return backupKeys;
  }

  async _save(keys) {
    const value = JSON.stringify({ version: 1, keys });
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

  _recoverStale(keys) {
    const now = this.now();
    let changed = false;
    for (const key of keys) {
      if (key.status !== "in_use" || !key.claimedAt || now - key.claimedAt < this.leaseTtlMs) continue;
      key.status = "available";
      key.claimedAt = 0;
      key.owner = "";
      changed = true;
    }
    return changed;
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

function createLocalRegistrationKeyStore(storageUri) {
  const root = typeof storageUri?.fsPath === "string" ? storageUri.fsPath : "";
  if (!root) return undefined;
  const filePath = path.join(root, "registration-keys.v1.json");
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

function parseStoredKeys(raw) {
  if (typeof raw !== "string" || !raw) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const rawKeys = Array.isArray(parsed) ? parsed : parsed?.keys;
  if (!Array.isArray(rawKeys)) return undefined;
  const seen = new Set();
  return rawKeys.map((rawKey) => normalizeKey(rawKey)).filter((key) => {
    if (!key || seen.has(key.code)) return false;
    seen.add(key.code);
    return true;
  });
}

function parseKeyInput(input) {
  const values = [];
  let invalid = 0;
  for (const line of String(input ?? "").split(/\r?\n/u)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    if (value.length > 512 || /\s/u.test(value)) {
      invalid += 1;
      continue;
    }
    values.push(value);
  }
  return { values, invalid };
}

function normalizeKey(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = text(raw.code);
  if (!code) return null;
  const status = raw.status === "in_use" ? "in_use" : "available";
  return {
    id: text(raw.id) || crypto.randomUUID(),
    code,
    status,
    createdAt: number(raw.createdAt, Date.now()),
    claimedAt: number(raw.claimedAt, 0),
    owner: status === "in_use" ? text(raw.owner) : ""
  };
}

function publicSnapshot(keys) {
  return {
    count: keys.length,
    available: keys.filter((key) => key.status === "available").length,
    inUse: keys.filter((key) => key.status === "in_use").length,
    keys: keys.map((key) => publicKey(key))
  };
}

function publicKey(key, includeCode = false) {
  const result = {
    id: key.id,
    masked: maskKey(key.code),
    status: key.status,
    createdAt: key.createdAt,
    claimedAt: key.claimedAt
  };
  if (includeCode) result.code = key.code;
  return result;
}

function maskKey(value) {
  const key = text(value);
  if (!key) return "";
  if (key.length <= 6) return "*".repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-3)}`;
}

function compareKeys(left, right) {
  return Number(left.createdAt || 0) - Number(right.createdAt || 0) || String(left.id).localeCompare(String(right.id));
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function normalizePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}

module.exports = {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_STORE_KEY,
  createLocalRegistrationKeyStore,
  RegistrationKeyPool,
  maskKey,
  parseKeyInput
};
