"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const SUB2API_GATEWAY_CONFIG_SCHEMA = "codex-accounts-sub2api-gateway/v1";
const DEFAULT_CONFIG_FILE = "sub2api-gateway.json";
const CREDENTIAL_REF_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function createSub2ApiGatewayConfigTemplate() {
  return {
    schema: SUB2API_GATEWAY_CONFIG_SCHEMA,
    displayName: "Sub2API Gateway",
    sub2api: {
      baseUrl: "https://gateway.example.invalid/v1",
      model: "gpt-5",
      credentialRef: "primary"
    },
    autoFallbackToChatGpt: false,
    profiles: [],
    inventoryObserver: {
      adminBaseUrl: "https://gateway.example.invalid",
      group: "default",
      credentialRef: "observer",
      refreshSeconds: 300
    }
  };
}

function resolveSub2ApiGatewayConfigPath(storageDirectory, fileName = DEFAULT_CONFIG_FILE) {
  if (typeof storageDirectory !== "string" || !path.isAbsolute(storageDirectory)) {
    throw new Error("Gateway storage is unavailable.");
  }
  if (typeof fileName !== "string" || !fileName.trim() || path.isAbsolute(fileName)) {
    throw new Error("Gateway configuration file name must be relative.");
  }
  const root = path.resolve(storageDirectory);
  const candidate = path.resolve(root, fileName);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Gateway configuration file must stay inside extension storage.");
  }
  return candidate;
}

async function ensureSub2ApiGatewayConfigFile(configPath) {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(configPath, `${JSON.stringify(createSub2ApiGatewayConfigTemplate(), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function readSub2ApiGatewayConfig(configPath) {
  return parseSub2ApiGatewayConfig(await readGatewayConfigRaw(configPath));
}

async function readSub2ApiGatewayConfigWithDiagnostics(configPath) {
  return parseSub2ApiGatewayConfigWithDiagnostics(await readGatewayConfigRaw(configPath));
}

async function readGatewayConfigRaw(configPath) {
  const info = await fs.lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) {
    throw new Error("Gateway configuration file is unsafe.");
  }
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    throw new Error("Gateway configuration must contain valid JSON.");
  }
}

function parseSub2ApiGatewayConfig(raw) {
  const { id, ...config } = parseGatewayProfiles(raw, false)[0];
  return config;
}

function parseSub2ApiGatewayConfigWithDiagnostics(raw) {
  const profiles = parseGatewayProfiles(raw, true);
  const config = profiles[0];
  return {
    config,
    profiles,
    ...(config.inventoryObserverError ? { inventoryObserverError: config.inventoryObserverError } : {})
  };
}

function parseGatewayProfiles(raw, allowObserverDiagnostics) {
  if (!isRecord(raw) || raw.schema !== SUB2API_GATEWAY_CONFIG_SCHEMA) {
    throw new Error("Gateway configuration schema is invalid.");
  }
  let entries;
  if (raw.profiles === undefined) {
    entries = [raw];
  } else {
    if (!Array.isArray(raw.profiles)) {
      throw new Error("Gateway profiles must be an array.");
    }
    entries = raw.sub2api ? [raw, ...raw.profiles] : raw.profiles;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Gateway configuration must contain at least one profile.");
  }
  const ids = new Set();
  return entries.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error("Gateway profile configuration is invalid.");
    }
    const id = normalizeProfileId(entry.id ?? (index === 0 ? "default" : `profile-${index + 1}`));
    if (ids.has(id)) {
      throw new Error("Gateway profile IDs must be unique.");
    }
    ids.add(id);
    const profile = parseGatewayProfile({ ...entry, schema: raw.schema }, allowObserverDiagnostics);
    return { ...profile, id };
  });
}

function parseGatewayProfile(raw, allowObserverDiagnostics) {
  const config = parseGatewayCoreConfig(raw);
  if (raw.inventoryObserver === undefined) {
    return config;
  }
  try {
    return {
      ...config,
      inventoryObserver: parseInventoryObserver(raw.inventoryObserver, config.sub2api.credentialRef)
    };
  } catch (error) {
    if (!allowObserverDiagnostics) {
      throw error;
    }
    return {
      ...config,
      inventoryObserverError: safeObserverConfigurationError(error)
    };
  }
}

function parseGatewayCoreConfig(raw) {
  if (!isRecord(raw) || raw.schema !== SUB2API_GATEWAY_CONFIG_SCHEMA || !isRecord(raw.sub2api)) {
    throw new Error("Gateway configuration schema is invalid.");
  }
  const displayName = requiredText(raw.displayName, "Gateway display name");
  const baseUrl = normalizeEndpointUrl(requiredText(raw.sub2api.baseUrl, "Gateway base URL"), true);
  const model = requiredText(raw.sub2api.model, "Gateway model");
  const credentialRef = normalizeCredentialRef(raw.sub2api.credentialRef);
  const autoFallbackToChatGpt = raw.autoFallbackToChatGpt === true;
  return {
    schema: SUB2API_GATEWAY_CONFIG_SCHEMA,
    displayName,
    sub2api: { baseUrl, model, credentialRef },
    autoFallbackToChatGpt
  };
}

function parseInventoryObserver(raw, downstreamCredentialRef) {
  if (!isRecord(raw)) {
    throw new Error("Gateway inventory observer configuration is invalid.");
  }
  const adminBaseUrl = normalizeEndpointUrl(requiredText(raw.adminBaseUrl, "Observer admin base URL"), false);
  const group = requiredText(raw.group, "Observer group");
  const credentialRef = normalizeCredentialRef(raw.credentialRef);
  if (credentialRef === downstreamCredentialRef) {
    throw new Error("Observer and downstream credential references must be different.");
  }
  const refreshSeconds = Number(raw.refreshSeconds);
  if (!Number.isInteger(refreshSeconds) || refreshSeconds < 30 || refreshSeconds > 3600) {
    throw new Error("Observer refreshSeconds must be an integer from 30 to 3600.");
  }
  return { adminBaseUrl, group, credentialRef, refreshSeconds };
}

function normalizeEndpointUrl(value, requiresV1) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Gateway endpoint URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Gateway endpoint URL is invalid.");
  }
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (requiresV1 ? pathname !== "/v1" : pathname !== "/") {
    throw new Error(requiresV1 ? "Gateway base URL must end in /v1." : "Observer admin base URL must not include a path.");
  }
  url.pathname = pathname === "/" ? "/" : pathname;
  return url.toString().replace(/\/$/u, "");
}

function normalizeCredentialRef(value) {
  const result = requiredText(value, "Credential reference").toLowerCase();
  if (!CREDENTIAL_REF_PATTERN.test(result)) {
    throw new Error("Credential reference is invalid.");
  }
  return result;
}

function normalizeProfileId(value) {
  const result = requiredText(value, "Gateway profile ID").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(result)) {
    throw new Error("Gateway profile ID is invalid.");
  }
  return result;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeObserverConfigurationError(error) {
  if (error instanceof Error && error.message && error.message.length <= 240) {
    return error.message;
  }
  return "Gateway inventory observer configuration is invalid.";
}

module.exports = {
  DEFAULT_CONFIG_FILE,
  SUB2API_GATEWAY_CONFIG_SCHEMA,
  createSub2ApiGatewayConfigTemplate,
  ensureSub2ApiGatewayConfigFile,
  parseSub2ApiGatewayConfig,
  parseSub2ApiGatewayConfigWithDiagnostics,
  readSub2ApiGatewayConfig,
  readSub2ApiGatewayConfigWithDiagnostics,
  resolveSub2ApiGatewayConfigPath
};
