import * as fs from "node:fs/promises";
import * as path from "node:path";

export const SUB2API_GATEWAY_CONFIG_SCHEMA = "codex-accounts-sub2api-gateway/v1";
export const DEFAULT_SUB2API_GATEWAY_CONFIG_FILE = "sub2api-gateway.json";

const MAX_CONFIG_BYTES = 64 * 1024;
const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const MODEL_PATTERN = /^[^\r\n]{1,160}$/u;
const DISPLAY_NAME_PATTERN = /^[^\r\n]{1,128}$/u;
const OBSERVER_GROUP_PATTERN = /^[^\r\n]{1,128}$/u;
const PLAINTEXT_SECRET_KEYS = new Set(["apikey", "token", "authorization", "secret", "password"]);
const MIN_OBSERVER_REFRESH_SECONDS = 60;
const MAX_OBSERVER_REFRESH_SECONDS = 60 * 60;

export type Sub2ApiGatewayConfig = {
  schema: typeof SUB2API_GATEWAY_CONFIG_SCHEMA;
  displayName: string;
  sub2api: {
    baseUrl: string;
    model: string;
    credentialRef: string;
  };
  /**
   * Optional because a downstream API key intentionally cannot read the
   * provider inventory.  The corresponding admin credential lives only in
   * SecretStorage under this separate reference.
   */
  inventoryObserver?: {
    adminBaseUrl: string;
    group: string;
    credentialRef: string;
    refreshSeconds: number;
  };
};

export type ResolvedSub2ApiGatewayConfig = Sub2ApiGatewayConfig & {
  configPath: string;
};

export function resolveSub2ApiGatewayConfigPath(globalStoragePath: string, configuredFile?: string): string {
  const trimmedFile = configuredFile?.trim();
  const file =
    trimmedFile === undefined || trimmedFile.length === 0 ? DEFAULT_SUB2API_GATEWAY_CONFIG_FILE : trimmedFile;
  if (path.isAbsolute(file)) {
    throw new Error("The Sub2API Gateway config file must be relative to VS Code global storage");
  }

  const normalized = path.normalize(file);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.length === 0 || normalized === ".") {
    throw new Error("The Sub2API Gateway config file must stay inside VS Code global storage");
  }

  const root = path.resolve(globalStoragePath);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("The Sub2API Gateway config file must stay inside VS Code global storage");
  }
  return resolved;
}

export async function ensureSub2ApiGatewayConfigFile(configPath: string): Promise<boolean> {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(configPath, `${JSON.stringify(createSub2ApiGatewayConfigTemplate(), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await fs.chmod(configPath, 0o600);
    return true;
  } catch (error) {
    if (isFileExistsError(error)) {
      return false;
    }
    throw error;
  }
}

export async function readSub2ApiGatewayConfig(configPath: string): Promise<ResolvedSub2ApiGatewayConfig> {
  const info = await fs.lstat(configPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
    throw new Error("The Sub2API Gateway config file is not a safe regular JSON file");
  }

  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    throw new Error("The Sub2API Gateway config file is not valid JSON");
  }

  return {
    ...parseSub2ApiGatewayConfig(value),
    configPath
  };
}

export function parseSub2ApiGatewayConfig(value: unknown): Sub2ApiGatewayConfig {
  if (!isRecord(value)) {
    throw new Error("The Sub2API Gateway config must be a JSON object");
  }
  if (containsPlaintextSecret(value)) {
    throw new Error("Put the Sub2API API key in VS Code SecretStorage, not in the Gateway config file");
  }
  if (value["schema"] !== SUB2API_GATEWAY_CONFIG_SCHEMA) {
    throw new Error(`Unsupported Sub2API Gateway config schema; expected ${SUB2API_GATEWAY_CONFIG_SCHEMA}`);
  }

  const displayName = readTrimmedString(value, "displayName");
  const sub2api = value["sub2api"];
  if (!displayName || !DISPLAY_NAME_PATTERN.test(displayName) || !isRecord(sub2api)) {
    throw new Error("The Sub2API Gateway displayName or sub2api block is invalid");
  }

  const baseUrl = normalizeBaseUrl(readTrimmedString(sub2api, "baseUrl"));
  const model = readTrimmedString(sub2api, "model");
  const credentialRef = readTrimmedString(sub2api, "credentialRef");
  if (!model || !MODEL_PATTERN.test(model)) {
    throw new Error("The Sub2API Gateway model is invalid");
  }
  if (!credentialRef || !CREDENTIAL_REF_PATTERN.test(credentialRef)) {
    throw new Error("The Sub2API Gateway credentialRef is invalid");
  }

  const inventoryObserver = parseInventoryObserver(value["inventoryObserver"]);
  if (inventoryObserver?.credentialRef === credentialRef) {
    throw new Error("The inventory observer credentialRef must be different from the downstream API key reference");
  }

  return {
    schema: SUB2API_GATEWAY_CONFIG_SCHEMA,
    displayName,
    sub2api: {
      baseUrl,
      model,
      credentialRef
    },
    ...(inventoryObserver ? { inventoryObserver } : {})
  };
}

export function createSub2ApiGatewayConfigTemplate(): Sub2ApiGatewayConfig {
  return {
    schema: SUB2API_GATEWAY_CONFIG_SCHEMA,
    displayName: "Sub2API Gateway",
    sub2api: {
      baseUrl: "http://127.0.0.1:65432/v1",
      model: "gpt-5.5",
      credentialRef: "primary"
    }
  };
}

function normalizeBaseUrl(value: string | undefined): string {
  if (!value) {
    throw new Error("The Sub2API Gateway baseUrl is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The Sub2API Gateway baseUrl must be an HTTP(S) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("The Sub2API Gateway baseUrl must be a plain HTTP(S) API URL");
  }

  const pathname = parsed.pathname.replace(/\/+$/u, "");
  if (pathname !== "/v1") {
    throw new Error("The Sub2API Gateway baseUrl must end with /v1");
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/u, "");
}

function parseInventoryObserver(value: unknown): Sub2ApiGatewayConfig["inventoryObserver"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("The Sub2API Gateway inventoryObserver block is invalid");
  }
  const adminBaseUrl = normalizeAdminBaseUrl(readTrimmedString(value, "adminBaseUrl"));
  const group = readTrimmedString(value, "group");
  const credentialRef = readTrimmedString(value, "credentialRef");
  const refreshSeconds = value["refreshSeconds"] === undefined ? 300 : value["refreshSeconds"];
  if (!group || !OBSERVER_GROUP_PATTERN.test(group)) {
    throw new Error("The Sub2API Gateway inventory observer group is invalid");
  }
  if (!credentialRef || !CREDENTIAL_REF_PATTERN.test(credentialRef)) {
    throw new Error("The Sub2API Gateway inventory observer credentialRef is invalid");
  }
  if (
    typeof refreshSeconds !== "number" ||
    !Number.isSafeInteger(refreshSeconds) ||
    refreshSeconds < MIN_OBSERVER_REFRESH_SECONDS ||
    refreshSeconds > MAX_OBSERVER_REFRESH_SECONDS
  ) {
    throw new Error(
      `The Sub2API Gateway inventory observer refreshSeconds must be ${MIN_OBSERVER_REFRESH_SECONDS}-${MAX_OBSERVER_REFRESH_SECONDS}`
    );
  }
  return { adminBaseUrl, group, credentialRef, refreshSeconds };
}

function normalizeAdminBaseUrl(value: string | undefined): string {
  if (!value) {
    throw new Error("The Sub2API Gateway inventory observer adminBaseUrl is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The Sub2API Gateway inventory observer adminBaseUrl must be an HTTP(S) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/+$/u, "") !== ""
  ) {
    throw new Error("The Sub2API Gateway inventory observer adminBaseUrl must be the Sub2API service root");
  }
  parsed.pathname = "/";
  return parsed.toString().replace(/\/$/u, "");
}

function containsPlaintextSecret(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsPlaintextSecret(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([key, entry]) => {
    const normalizedKey = key.toLowerCase().replace(/[-_]/gu, "");
    return isPlaintextSecretKey(normalizedKey) || containsPlaintextSecret(entry);
  });
}

function isPlaintextSecretKey(normalizedKey: string): boolean {
  return (
    PLAINTEXT_SECRET_KEYS.has(normalizedKey) ||
    normalizedKey.endsWith("apikey") ||
    normalizedKey.endsWith("token") ||
    normalizedKey.endsWith("authorization") ||
    normalizedKey.endsWith("secret") ||
    normalizedKey.endsWith("password")
  );
}

function readTrimmedString(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST";
}
