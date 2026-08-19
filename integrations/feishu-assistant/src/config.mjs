const DEFAULT_MANAGER_CONTROL_URL = "http://127.0.0.1:43117";
const DEFAULT_MANAGER_TIMEOUT_MS = 10_000;
const DEFAULT_PAYMENT_POLL_INTERVAL_MS = 10_000;

export function loadConfig(env = process.env) {
  const appId = required(env.FEISHU_APP_ID, "FEISHU_APP_ID");
  const appSecret = required(env.FEISHU_APP_SECRET, "FEISHU_APP_SECRET");
  const managerControlToken = required(env.MANAGER_CONTROL_TOKEN, "MANAGER_CONTROL_TOKEN");
  const adminOpenIds = parseList(env.FEISHU_ADMIN_OPEN_IDS);
  if (adminOpenIds.length === 0) {
    throw new Error("FEISHU_ADMIN_OPEN_IDS 必须至少包含一个管理员 open_id。 ");
  }

  return {
    feishu: { appId, appSecret, adminOpenIds: new Set(adminOpenIds) },
    manager: {
      baseUrl: normalizeBaseUrl(env.MANAGER_CONTROL_URL ?? DEFAULT_MANAGER_CONTROL_URL),
      token: managerControlToken,
      timeoutMs: parseTimeout(env.MANAGER_CONTROL_TIMEOUT_MS)
    },
    payment: {
      providerModule: optional(env.FEISHU_ASSISTANT_PAYMENT_PROVIDER_MODULE),
      statePath: optional(env.FEISHU_ASSISTANT_PAYMENT_STATE_PATH),
      pollIntervalMs: parsePollInterval(env.FEISHU_ASSISTANT_PAYMENT_POLL_INTERVAL_MS)
    },
    web: {
      workflowStatePath: optional(env.FEISHU_ASSISTANT_WEB_WORKFLOW_STATE_PATH),
      executorModule: optional(env.FEISHU_ASSISTANT_WEB_EXECUTOR_MODULE),
      openAiApiKey: optional(env.FEISHU_ASSISTANT_OPENAI_API_KEY) ?? optional(env.OPENAI_API_KEY),
      openAiBaseUrl: optional(env.FEISHU_ASSISTANT_OPENAI_BASE_URL),
      model: optional(env.FEISHU_ASSISTANT_WEB_MODEL)
    }
  };
}

export function parseList(value) {
  if (typeof value !== "string") {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} 未配置。`);
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_MANAGER_CONTROL_URL;
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("MANAGER_CONTROL_URL 必须是有效的 http(s) URL。 ");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("MANAGER_CONTROL_URL 只支持不带账号密码的 http(s) URL。 ");
  }
  return url.toString().replace(/\/+$/u, "");
}

function parseTimeout(value) {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_MANAGER_TIMEOUT_MS;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 120_000 ? parsed : DEFAULT_MANAGER_TIMEOUT_MS;
}

function parsePollInterval(value) {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_PAYMENT_POLL_INTERVAL_MS;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 3_000 && parsed <= 300_000 ? parsed : DEFAULT_PAYMENT_POLL_INTERVAL_MS;
}

function optional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
