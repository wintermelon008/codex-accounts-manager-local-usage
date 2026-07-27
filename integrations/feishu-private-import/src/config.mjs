import * as path from "node:path";

export function loadConfiguration(env = process.env) {
  const appId = required(env, "FEISHU_APP_ID");
  const appSecret = required(env, "FEISHU_APP_SECRET");
  const verificationToken = required(env, "FEISHU_VERIFICATION_TOKEN");
  const adminOpenIds = new Set(
    required(env, "FEISHU_ADMIN_OPEN_IDS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (adminOpenIds.size === 0) {
    throw new Error("FEISHU_ADMIN_OPEN_IDS 至少需要一个管理员 Open ID。");
  }
  const port = parsePort(env.FEISHU_LISTEN_PORT ?? "3000");
  const host = optional(env.FEISHU_LISTEN_HOST) ?? "127.0.0.1";
  const endpointPath = normalizeEndpointPath(optional(env.FEISHU_ENDPOINT_PATH) ?? "/feishu/events");
  const managerImportQueueDirectory = optionalAbsolutePath(env.MANAGER_IMPORT_QUEUE_DIR, "MANAGER_IMPORT_QUEUE_DIR");
  const sub2ApiImportQueueDirectory = optionalAbsolutePath(env.SUB2API_IMPORT_QUEUE_DIR, "SUB2API_IMPORT_QUEUE_DIR");
  const ingressStateDirectory = optionalAbsolutePath(env.SESSION_INGRESS_STATE_DIR, "SESSION_INGRESS_STATE_DIR");

  return {
    appId,
    appSecret,
    verificationToken,
    adminOpenIds,
    host,
    port,
    endpointPath,
    queueOptions: {
      ...(managerImportQueueDirectory ? { managerImportQueueDirectory } : {}),
      ...(sub2ApiImportQueueDirectory ? { sub2ApiImportQueueDirectory } : {}),
      ...(ingressStateDirectory ? { ingressStateDirectory } : {})
    }
  };
}

export function resolveQueueOptions(configuration, baseEnv = process.env) {
  const queueOptions = configuration.queueOptions ?? {};
  const env = {
    ...(optional(baseEnv.XDG_STATE_HOME) ? { XDG_STATE_HOME: optional(baseEnv.XDG_STATE_HOME) } : {}),
    ...(optional(baseEnv.CODEX_IMPORT_QUEUE_DIR)
      ? { CODEX_IMPORT_QUEUE_DIR: optional(baseEnv.CODEX_IMPORT_QUEUE_DIR) }
      : {}),
    ...(queueOptions.managerImportQueueDirectory
      ? { MANAGER_IMPORT_QUEUE_DIR: queueOptions.managerImportQueueDirectory }
      : {}),
    ...(queueOptions.sub2ApiImportQueueDirectory
      ? { SUB2API_IMPORT_QUEUE_DIR: queueOptions.sub2ApiImportQueueDirectory }
      : {}),
    ...(queueOptions.ingressStateDirectory ? { SESSION_INGRESS_STATE_DIR: queueOptions.ingressStateDirectory } : {})
  };
  return { env };
}

function required(env, key) {
  const value = optional(env[key]);
  if (!value) {
    throw new Error(`${key} 是必填私有配置。`);
  }
  return value;
}

function optional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalAbsolutePath(value, key) {
  const candidate = optional(value);
  if (!candidate) {
    return undefined;
  }
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${key} 必须是绝对本地路径。`);
  }
  return path.normalize(candidate);
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("FEISHU_LISTEN_PORT 必须是 1 到 65535 的整数。");
  }
  return parsed;
}

function normalizeEndpointPath(value) {
  if (!value.startsWith("/") || value.includes("?")) {
    throw new Error("FEISHU_ENDPOINT_PATH 必须是不带查询参数的绝对 URL 路径。");
  }
  return value;
}
