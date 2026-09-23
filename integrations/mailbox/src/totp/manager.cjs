"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TwoFAuthClient } = require("./twofauth-client.cjs");

const TOTP_CONFIG_KEY = "codexAccounts.mailbox.totp.config.v1";
const TOTP_LINKS_KEY = "codexAccounts.mailbox.totp.links.v1";
const TOTP_SCHEMA_VERSION = 1;
const TOTP_CONFIG_FILE_VERSION = 1;
const TOTP_CONFIG_FILE_NAME = "mailbox-2fauth.json";
const TOTP_CONFIG_FILE_ENV = "CODEX_ACCOUNTS_MAILBOX_TOTP_CONFIG_FILE";

class TwoFactorManager {
  constructor({ metadataStore, secretStore, clientFactory = (options) => new TwoFAuthClient(options), fetchImpl, now = () => Date.now(), configFilePath } = {}) {
    if (!metadataStore || typeof metadataStore.get !== "function" || typeof metadataStore.update !== "function") {
      throw new TypeError("TOTP metadata store must provide get and update");
    }
    if (!secretStore || typeof secretStore.get !== "function" || typeof secretStore.store !== "function" || typeof secretStore.delete !== "function") {
      throw new TypeError("TOTP secret store must provide get, store and delete");
    }
    this.metadataStore = metadataStore;
    this.secretStore = secretStore;
    this.clientFactory = clientFactory;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.configFilePath = normalizeConfigFilePath(configFilePath);
    this.config = undefined;
    this.links = [];
    this.loaded = false;
    this.operationQueue = Promise.resolve();
  }

  async load() {
    return this.enqueue(async () => {
      await this.loadConfig();
      this.links = parseLinks(await this.metadataStore.get(TOTP_LINKS_KEY));
      this.loaded = true;
      return this.getSummary();
    });
  }

  async getSummary() {
    await this.ensureLoaded();
    return {
      configured: Boolean(this.config),
      baseUrl: this.config?.baseUrl || "",
      links: this.listLinkSummaries()
    };
  }

  listLinkSummaries() {
    return Object.fromEntries(this.links.map((link) => [link.mailboxId, sanitizeLink(link)]));
  }

  async getLink(mailboxId) {
    await this.ensureLoaded();
    const link = this.findLink(mailboxId);
    return link ? sanitizeLink(link) : undefined;
  }

  async deleteRemoteAccount(accountId) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.config) throw new Error("请先在配置文件中配置 2FAuth");
      const id = String(accountId ?? "").trim();
      if (!id) throw new Error("2FAuth 条目 ID 无效");
      await this.createClient().deleteAccount(id);
      return { accountId: id, deleted: true };
    });
  }

  async autoBindLatestMailboxes(mailboxes) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.config) return [];
      const accounts = await this.createClient().listAccounts();
      const results = [];
      let changed = false;
      for (const mailbox of Array.isArray(mailboxes) ? mailboxes : []) {
        const mailboxId = typeof mailbox?.id === "string" ? mailbox.id.trim() : "";
        const address = typeof mailbox?.address === "string" ? mailbox.address.trim() : "";
        if (!mailboxId || !address) continue;
        const matches = accounts.filter((account) => account.id && normalizeEmail(account.account) === normalizeEmail(address));
        const account = selectLatestAccount(matches);
        if (!account) continue;
        const current = this.findLink(mailboxId);
        if (current?.accountId === account.id) {
          results.push({ mailboxId, accountId: account.id, existing: true });
          continue;
        }
        const hiddenAccountIds = new Set(current?.hiddenAccountIds || []);
        if (current) hiddenAccountIds.add(current.accountId);
        hiddenAccountIds.delete(account.id);
        const next = {
          mailboxId,
          address,
          accountId: account.id,
          service: account.service,
          account: account.account,
          hiddenAccountIds: [...hiddenAccountIds],
          linkedAt: current?.linkedAt ?? this.now(),
          updatedAt: this.now()
        };
        replaceLink(this.links, next);
        changed = true;
        results.push({ mailboxId, accountId: account.id, existing: false });
      }
      if (changed) await this.persistLinks();
      return results;
    });
  }

  async getMailboxState(mailboxId, { address = "", signal } = {}) {
    await this.ensureLoaded();
    const link = this.findLink(mailboxId);
    const base = {
      mailboxId,
      address,
      configured: Boolean(this.config),
      baseUrl: this.config?.baseUrl || "",
      link: link ? sanitizeLink(link) : undefined,
      account: undefined,
      accounts: [],
      otp: undefined,
      error: ""
    };
    if (!this.config) return base;

    try {
      const accounts = await this.createClient().listAccounts({ signal });
      const hiddenAccountIds = new Set(link?.hiddenAccountIds || []);
      base.accounts = accounts.filter((account) => !hiddenAccountIds.has(account.id) || account.id === link?.accountId);
      if (link) {
        base.account = accounts.find((account) => account.id === link.accountId);
        if (!base.account) base.error = "已绑定的 2FAuth 条目不存在，可重新绑定";
      }
    } catch (error) {
      if (error?.message === "2FAuth 请求已取消") throw error;
      base.error = safeError(error, "2FAuth 连接失败");
    }
    return base;
  }

  async queryMailbox(mailboxId, options = {}) {
    await this.ensureLoaded();
    const link = this.requireLink(mailboxId);
    if (!this.config) throw new Error("请先在配置文件中配置 2FAuth");
    const { signal, ...stateOptions } = options || {};
    const otp = await this.createClient().getOtp(link.accountId, { signal });
    const state = await this.getMailboxState(mailboxId, { ...stateOptions, signal });
    state.otp = otp;
    if (!state.account) {
      state.account = { id: link.accountId, service: link.service, account: link.account, otpType: "totp" };
    }
    return state;
  }

  async linkMailbox(mailboxId, accountId, { address = "" } = {}) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.config) throw new Error("请先在配置文件中配置 2FAuth");
      const id = String(accountId ?? "").trim();
      if (!id) throw new Error("请选择要绑定的 2FAuth 条目");
      const accounts = await this.createClient().listAccounts();
      const account = accounts.find((item) => item.id === id);
      if (!account) throw new Error("2FAuth 条目不存在或当前账号无权访问");
      const link = this.findLink(mailboxId);
      const hiddenAccountIds = new Set(link?.hiddenAccountIds || []);
      if (link && link.accountId !== id) hiddenAccountIds.add(link.accountId);
      hiddenAccountIds.delete(id);
      const next = {
        mailboxId,
        address: String(address || "").trim(),
        accountId: id,
        service: account.service,
        account: account.account,
        hiddenAccountIds: [...hiddenAccountIds],
        linkedAt: this.now(),
        updatedAt: this.now()
      };
      replaceLink(this.links, next);
      await this.persistLinks();
      return sanitizeLink(next);
    });
  }

  async createAndLink(mailboxId, { uri, secret, label, address = "" } = {}) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.config) throw new Error("请先在配置文件中配置 2FAuth");
      const account = await this.createClient().createAccount({ uri, secret, label, account: address });
      if (!account.id) throw new Error("2FAuth 创建条目成功但没有返回条目 ID");
      const current = this.findLink(mailboxId);
      const hiddenAccountIds = new Set(current?.hiddenAccountIds || []);
      if (current && current.accountId !== account.id) hiddenAccountIds.add(current.accountId);
      hiddenAccountIds.delete(account.id);
      const next = {
        mailboxId,
        address: String(address || "").trim(),
        accountId: account.id,
        service: account.service,
        account: account.account,
        hiddenAccountIds: [...hiddenAccountIds],
        linkedAt: current?.linkedAt ?? this.now(),
        updatedAt: this.now()
      };
      replaceLink(this.links, next);
      await this.persistLinks();
      return sanitizeLink(next);
    });
  }

  async unlinkMailbox(mailboxId) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const next = this.links.filter((link) => link.mailboxId !== mailboxId);
      if (next.length !== this.links.length) {
        this.links = next;
        await this.persistLinks();
      }
      return true;
    });
  }

  createClient() {
    if (!this.config) throw new Error("请先在配置文件中配置 2FAuth");
    return this.clientFactory({
      baseUrl: this.config.baseUrl,
      token: this.config.token,
      fetchImpl: this.fetchImpl
    });
  }

  findLink(mailboxId) {
    return this.links.find((link) => link.mailboxId === mailboxId);
  }

  requireLink(mailboxId) {
    const link = this.findLink(mailboxId);
    if (!link) throw new Error("该邮箱尚未绑定 2FAuth 条目");
    return link;
  }

  async persistLinks() {
    await this.metadataStore.update(TOTP_LINKS_KEY, {
      version: TOTP_SCHEMA_VERSION,
      links: this.links
    });
  }

  async ensureLoaded() {
    if (this.loaded) return;
    await this.loadConfig();
    this.links = parseLinks(await this.metadataStore.get(TOTP_LINKS_KEY));
    this.loaded = true;
  }

  async loadConfig() {
    if (this.configFilePath) {
      const file = await readConfigFile(this.configFilePath);
      if (file.exists) {
        this.config = parseConfig(file.value);
        if (!this.config) {
          throw new Error(`2FAuth 配置文件无效：${this.configFilePath}`);
        }
        return;
      }
    }

    const legacy = parseConfig(await this.secretStore.get(TOTP_CONFIG_KEY));
    this.config = legacy;
    if (!legacy || !this.configFilePath) return;

    // Migrate the old panel-managed secret once. The dedicated file becomes
    // the only configuration source after a successful write.
    await writeConfigFile(this.configFilePath, legacy);
    await this.secretStore.delete(TOTP_CONFIG_KEY).catch(() => undefined);
  }

  enqueue(operation) {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.catch(() => undefined);
    return next;
  }
}

function parseConfig(value) {
  if (typeof value === "string" && !value.trim()) return undefined;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.version !== undefined && parsed.version !== TOTP_CONFIG_FILE_VERSION) return undefined;
    if (typeof parsed.baseUrl !== "string" || typeof parsed.token !== "string" || !parsed.baseUrl.trim() || !parsed.token.trim()) {
      return undefined;
    }
    return { baseUrl: parsed.baseUrl.trim(), token: parsed.token.trim() };
  } catch {
    return undefined;
  }
}

function parseLinks(value) {
  if (!value || typeof value !== "object" || value.version !== TOTP_SCHEMA_VERSION || !Array.isArray(value.links)) {
    return [];
  }
  return value.links.map(normalizeLink).filter(Boolean);
}

function normalizeLink(value) {
  if (!value || typeof value !== "object") return undefined;
  const mailboxId = typeof value.mailboxId === "string" ? value.mailboxId.trim() : "";
  const accountId = typeof value.accountId === "string" || typeof value.accountId === "number" ? String(value.accountId).trim() : "";
  if (!mailboxId || !accountId) return undefined;
  return {
    mailboxId,
    address: safeText(value.address),
    accountId,
    service: safeText(value.service),
    account: safeText(value.account),
    hiddenAccountIds: normalizeAccountIds(value.hiddenAccountIds, accountId),
    linkedAt: finiteNumber(value.linkedAt),
    updatedAt: finiteNumber(value.updatedAt)
  };
}

function sanitizeLink(value) {
  return {
    mailboxId: value.mailboxId,
    address: value.address,
    accountId: value.accountId,
    service: value.service,
    account: value.account,
    linkedAt: value.linkedAt,
    updatedAt: value.updatedAt
  };
}

function replaceLink(links, next) {
  const index = links.findIndex((link) => link.mailboxId === next.mailboxId);
  if (index === -1) links.push(next);
  else links[index] = next;
}

function finiteNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function safeText(value) {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 160) : "";
}

function safeError(error, fallback) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message || fallback).replace(/[\r\n\t]+/gu, " ").slice(0, 160);
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function selectLatestAccount(accounts) {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((left, right) => compareAccountFreshness(right.account, right.index, left.account, left.index))[0]?.account;
}

function compareAccountFreshness(left, leftIndex, right, rightIndex) {
  const leftTimestamp = Math.max(Number(left?.updatedAt || 0), Number(left?.createdAt || 0));
  const rightTimestamp = Math.max(Number(right?.updatedAt || 0), Number(right?.createdAt || 0));
  if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
  const leftId = Number(left?.id);
  const rightId = Number(right?.id);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
  return leftIndex - rightIndex;
}

function normalizeAccountIds(value, currentId) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item && item !== currentId))];
}

function normalizeConfigFilePath(value) {
  const explicit = typeof value === "string" ? value.trim() : "";
  if (!explicit) return undefined;
  return path.resolve(explicit);
}

function resolveTotpConfigFilePath({ env = process.env, homeDir = os.homedir(), privateRoot } = {}) {
  const configured = typeof env?.[TOTP_CONFIG_FILE_ENV] === "string" ? env[TOTP_CONFIG_FILE_ENV].trim() : "";
  return path.resolve(
    configured ||
      (privateRoot && path.isAbsolute(privateRoot)
        ? path.join(privateRoot, TOTP_CONFIG_FILE_NAME)
        : path.join(homeDir, ".config", "codex-accounts-manager", TOTP_CONFIG_FILE_NAME))
  );
}

async function readConfigFile(filePath) {
  try {
    return { exists: true, value: await fs.readFile(filePath, "utf8") };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, value: undefined };
    throw error;
  }
}

async function writeConfigFile(filePath, config) {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporaryPath, JSON.stringify({ version: TOTP_CONFIG_FILE_VERSION, ...config }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.chmod(temporaryPath, 0o600).catch(() => undefined);
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

module.exports = {
  TOTP_CONFIG_KEY,
  TOTP_CONFIG_FILE_ENV,
  TOTP_CONFIG_FILE_NAME,
  TOTP_LINKS_KEY,
  TOTP_SCHEMA_VERSION,
  TwoFactorManager,
  parseConfig,
  parseLinks,
  sanitizeLink,
  resolveTotpConfigFilePath
};
