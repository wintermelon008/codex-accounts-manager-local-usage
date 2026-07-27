"use strict";

const {
  Sub2ApiImportError,
  createSub2ApiAdminClient,
  validatePayload
} = require("./sub2apiClient.cjs");

const ACCOUNTS_PATH = "/api/v1/admin/accounts";
const GROUPS_ALL_PATH = "/api/v1/admin/groups/all";
const PROXIES_ALL_PATH = "/api/v1/admin/proxies/all";
const ACCOUNT_PAGE_SIZE = 100;
const MAX_ACCOUNT_PAGES = 100;
const ACCOUNT_IDENTITY_CREDENTIAL_FIELDS = [
  "email",
  "chatgpt_account_id",
  "chatgpt_user_id",
  "organization_id",
  "client_id",
  "project_id",
  "account_id",
  "user_id"
];

async function importAndConfigureSub2ApiPayload(configuration, payload, options = {}) {
  validatePayload(payload);
  const client = options.client ?? (await createSub2ApiAdminClient(configuration, options));
  const prepared = await prepareProvisioning(configuration, payload, client);
  const beforeAccounts = await listSub2ApiAccounts(client);
  const result = await client.importPayload(payload);
  if (result.accountCreated === 0) {
    return { ...result, accountConfigured: 0 };
  }
  try {
    const afterAccounts = await listSub2ApiAccounts(client);
    const accounts = findImportedAccounts({
      beforeAccounts,
      afterAccounts,
      sourceAccounts: prepared.sourceAccounts,
      expectedCount: result.accountCreated
    });
    await configureImportedAccounts({ accounts, prepared, client });
    return { ...result, accountConfigured: accounts.length };
  } catch {
    throw new Sub2ApiImportError("postImportConfigurationFailed");
  }
}

async function prepareProvisioning(configuration, payload, client) {
  const sourceAccounts = [];
  const sourceIdentityKeys = new Set();
  for (const sourceAccount of payload.accounts) {
    const key = accountIdentityKey(sourceAccount);
    if (!key || sourceIdentityKeys.has(key) || !isRecord(sourceAccount.credentials)) {
      throw new Sub2ApiImportError("configurationPreconditionFailed");
    }
    sourceIdentityKeys.add(key);
    sourceAccounts.push(sourceAccount);
  }
  const proxyName = normalizeLabel(configuration.importProxyName ?? "default");
  const groupName = normalizeLabel(configuration.importGroupName ?? "test");
  const concurrency = configuration.importConcurrency ?? 2;
  if (!proxyName || !groupName || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Sub2ApiImportError("configurationPreconditionFailed");
  }

  const [proxies, groups] = await Promise.all([client.getJson(PROXIES_ALL_PATH), client.getJson(GROUPS_ALL_PATH)]);
  const proxy = findOne(
    Array.isArray(proxies) ? proxies : [],
    (candidate) => hasNumericId(candidate) && candidate.status === "active" && normalizeLabel(candidate.name) === proxyName
  );
  if (!proxy || !Array.isArray(groups)) {
    throw new Sub2ApiImportError("configurationPreconditionFailed");
  }

  const platforms = [...new Set(payload.accounts.map((account) => normalizeLabel(account.platform)))];
  if (platforms.some((platform) => !platform)) {
    throw new Sub2ApiImportError("configurationPreconditionFailed");
  }
  const targets = new Map();
  for (const platform of platforms) {
    const group = findOne(
      groups,
      (candidate) =>
        hasNumericId(candidate) &&
        candidate.status === "active" &&
        normalizeLabel(candidate.name) === groupName &&
        normalizeLabel(candidate.platform) === platform
    );
    if (!group) {
      throw new Sub2ApiImportError("configurationPreconditionFailed");
    }
    const modelCandidates = await client.getJson(
      `/api/v1/admin/groups/${group.id}/models-list-candidates?platform=${encodeURIComponent(group.platform)}`
    );
    const modelWhitelist = normalizeModelCandidates(modelCandidates);
    if (modelWhitelist.length === 0) {
      throw new Sub2ApiImportError("configurationPreconditionFailed");
    }
    targets.set(platform, { proxyId: proxy.id, groupId: group.id, concurrency, modelWhitelist });
  }
  return { sourceAccounts, targets };
}

async function listSub2ApiAccounts(client) {
  const accounts = [];
  for (let page = 1; page <= MAX_ACCOUNT_PAGES; page += 1) {
    const data = await client.getJson(`${ACCOUNTS_PATH}?page=${page}&page_size=${ACCOUNT_PAGE_SIZE}`);
    if (!isRecord(data) || !Array.isArray(data.items)) {
      throw new Sub2ApiImportError("invalidResponse");
    }
    accounts.push(...data.items);
    const pages = Number.isInteger(data.pages) && data.pages > 0 ? data.pages : page;
    if (page >= pages) return accounts;
  }
  throw new Sub2ApiImportError("invalidResponse");
}

function findImportedAccounts({ beforeAccounts, afterAccounts, sourceAccounts, expectedCount }) {
  const beforeIds = new Set(beforeAccounts.filter(hasNumericId).map((account) => account.id));
  const candidates = afterAccounts.filter(
    (account) => hasNumericId(account) && !beforeIds.has(account.id) && sourceAccounts.some((source) => accountMatchesSource(account, source))
  );
  const pairs = candidates.map((account) => {
    const matches = sourceAccounts.filter((source) => accountMatchesSource(account, source));
    if (matches.length !== 1) {
      throw new Error("newly imported account could not be matched unambiguously");
    }
    return { account, sourceAccount: matches[0] };
  });
  const sourceKeys = pairs.map(({ sourceAccount }) => accountIdentityKey(sourceAccount));
  if (pairs.length !== expectedCount || sourceKeys.some((key) => !key) || new Set(sourceKeys).size !== pairs.length) {
    throw new Error("newly imported accounts could not be uniquely identified");
  }
  return pairs;
}

async function configureImportedAccounts({ accounts, prepared, client }) {
  for (const { account, sourceAccount } of accounts) {
    const target = prepared.targets.get(normalizeLabel(sourceAccount.platform));
    if (!target) {
      throw new Error("new account provisioning target is unavailable");
    }
    const credentials = buildAllModelsCredentials(sourceAccount.credentials, account.credentials, target.modelWhitelist);
    await client.putJson(`${ACCOUNTS_PATH}/${account.id}`, {
      proxy_id: target.proxyId,
      concurrency: target.concurrency,
      group_ids: [target.groupId],
      credentials
    });
    const configured = await client.getJson(`${ACCOUNTS_PATH}/${account.id}`);
    if (!hasExpectedSettings(configured, target)) {
      throw new Error("new account provisioning was not confirmed");
    }
  }
}

function accountIdentityKey(account) {
  if (!isRecord(account)) return undefined;
  const name = requiredString(account.name);
  const platform = normalizeLabel(account.platform);
  const type = normalizeLabel(account.type);
  const credentials = isRecord(account.credentials) ? account.credentials : {};
  const identityCredentials = {};
  for (const field of ACCOUNT_IDENTITY_CREDENTIAL_FIELDS) {
    const value = credentials[field];
    if (typeof value === "string" && value.trim()) identityCredentials[field] = value.trim();
    else if (typeof value === "number" && Number.isFinite(value)) identityCredentials[field] = value;
    else if (typeof value === "boolean") identityCredentials[field] = value;
  }
  if (!name || !platform || !type || Object.keys(identityCredentials).length === 0) return undefined;
  return JSON.stringify({ name, platform, type, credentials: identityCredentials });
}

function accountMatchesSource(account, sourceAccount) {
  const sourceKey = accountIdentityKey(sourceAccount);
  if (!sourceKey || !isRecord(account)) return false;
  if (
    requiredString(account.name) !== requiredString(sourceAccount.name) ||
    normalizeLabel(account.platform) !== normalizeLabel(sourceAccount.platform) ||
    normalizeLabel(account.type) !== normalizeLabel(sourceAccount.type)
  ) {
    return false;
  }
  const sourceCredentials = isRecord(sourceAccount.credentials) ? sourceAccount.credentials : {};
  const accountCredentials = isRecord(account.credentials) ? account.credentials : {};
  return ACCOUNT_IDENTITY_CREDENTIAL_FIELDS.every((field) => {
    if (!Object.prototype.hasOwnProperty.call(sourceCredentials, field)) return true;
    return sameIdentityValue(sourceCredentials[field], accountCredentials[field]);
  });
}

function buildAllModelsCredentials(sourceCredentials, observedCredentials, modelWhitelist) {
  if (!isRecord(sourceCredentials)) {
    throw new Error("source credentials are unavailable");
  }
  const observed = isRecord(observedCredentials) ? observedCredentials : {};
  const credentials = { ...sourceCredentials };
  for (const [key, value] of Object.entries(observed)) {
    if (value !== undefined && value !== null && key !== "model_mapping") credentials[key] = value;
  }
  const modelMapping = {
    ...(isRecord(sourceCredentials.model_mapping) ? sourceCredentials.model_mapping : {}),
    ...(isRecord(observed.model_mapping) ? observed.model_mapping : {})
  };
  for (const model of modelWhitelist) modelMapping[model] = model;
  return { ...credentials, model_mapping: modelMapping };
}

function sameIdentityValue(left, right) {
  if (typeof left === "string") return typeof right === "string" && left.trim() === right.trim();
  if (typeof left === "number") return typeof right === "number" && Number.isFinite(left) && left === right;
  if (typeof left === "boolean") return typeof right === "boolean" && left === right;
  return false;
}

function hasExpectedSettings(account, target) {
  return (
    isRecord(account) &&
    account.proxy_id === target.proxyId &&
    account.concurrency === target.concurrency &&
    Array.isArray(account.group_ids) &&
    account.group_ids.length === 1 &&
    account.group_ids[0] === target.groupId &&
    hasAllExactModelMappings(account.credentials?.model_mapping, target.modelWhitelist)
  );
}

function hasAllExactModelMappings(value, modelWhitelist) {
  return isRecord(value) && modelWhitelist.every((model) => value[model] === model);
}

function normalizeModelCandidates(value) {
  const candidates = Array.isArray(value) ? value : value?.models;
  if (!Array.isArray(candidates)) return [];
  const models = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const model = requiredString(candidate);
    if (!model || model.includes("*") || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function findOne(values, predicate) {
  const matches = values.filter((value) => predicate(value));
  return matches.length === 1 ? matches[0] : undefined;
}

function hasNumericId(value) {
  return isRecord(value) && Number.isSafeInteger(value.id) && value.id > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLabel(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function requiredString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  accountMatchesSource,
  accountIdentityKey,
  buildAllModelsCredentials,
  importAndConfigureSub2ApiPayload,
  normalizeModelCandidates
};
