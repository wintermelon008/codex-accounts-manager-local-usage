import { createHash } from "node:crypto";

export const MAX_SESSION_TEXT_BYTES = 1_000_000;
export const MAX_SESSION_RECORDS = 50;

const MAX_JSON_DEPTH = 32;
const TOKEN_CONTAINER_KEYS = ["tokens", "token", "credentials", "session", "auth"];
const ACCESS_TOKEN_KEYS = ["access_token", "accessToken"];
const ID_TOKEN_KEYS = ["id_token", "idToken"];
const REFRESH_TOKEN_KEYS = ["refresh_token", "refreshToken"];
const ACCOUNT_ID_KEYS = ["chatgpt_account_id", "chatgptAccountId", "account_id", "accountId"];
const USER_ID_KEYS = ["chatgpt_user_id", "chatgptUserId", "user_id", "userId"];
const EMAIL_KEYS = ["email", "user_email", "userEmail"];
const PLAN_TYPE_KEYS = ["plan_type", "planType", "chatgpt_plan_type", "chatgptPlanType"];
const WORKSPACE_ID_KEYS = ["workspace_id", "workspaceId"];
const EXPIRES_AT_KEYS = ["expires_at", "expiresAt"];
const EXPIRES_IN_KEYS = ["expires_in", "expiresIn"];
const LABEL_KEYS = ["name", "label", "account_note", "accountNote"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const partialFieldAliases = new Map(
  [
    [ACCESS_TOKEN_KEYS, "access_token"],
    [ID_TOKEN_KEYS, "id_token"],
    [REFRESH_TOKEN_KEYS, "refresh_token"],
    [ACCOUNT_ID_KEYS, "account_id"],
    [USER_ID_KEYS, "user_id"],
    [EMAIL_KEYS, "email"],
    [PLAN_TYPE_KEYS, "plan_type"],
    [WORKSPACE_ID_KEYS, "workspace_id"],
    [EXPIRES_AT_KEYS, "expires_at"],
    [EXPIRES_IN_KEYS, "expires_in"],
    [LABEL_KEYS, "label"]
  ].flatMap(([keys, field]) => keys.map((key) => [key.toLocaleLowerCase(), field]))
);
const partialKeysPattern = [...partialFieldAliases.keys()]
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join("|");
const PARTIAL_FIELD_PATTERN = new RegExp(
  `(["']?(?:${partialKeysPattern})["']?)\\s*[:=]\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^,}\\]\\s\\r\\n]+)`,
  "giu"
);

/** A user-facing parse error which intentionally never includes credential text. */
export class SessionNormalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionNormalizationError";
  }
}

export function stripJsonFence(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text);
  return (match?.[1] ?? text).trim();
}

/** Parse complete JSON documents/fragments without evaluating arbitrary text. */
export function parseJsonDocuments(rawText) {
  const text = stripJsonFence(rawText);
  validateTextSize(text);
  if (!text) {
    return [];
  }
  try {
    return [JSON.parse(text)];
  } catch {
    // Truncated copy/paste is handled by the constrained recovery path below.
  }

  const values = [];
  const seen = new Set();
  for (const fragment of balancedJsonFragments(text)) {
    if (seen.has(fragment)) {
      continue;
    }
    seen.add(fragment);
    try {
      values.push(JSON.parse(fragment));
    } catch {
      // Only complete valid JSON fragments are considered here.
    }
  }
  return values;
}

/**
 * Recognize supported Codex, CPA, Cockpit/Cookpit, Manager, and Sub2API-style
 * credential containers. Complete JSON wins; partial text can recover only
 * the explicit known key/value fields.
 */
export function parseSessionRecords(rawText) {
  const text = stripJsonFence(rawText);
  validateTextSize(text);
  if (!text) {
    throw new SessionNormalizationError("未收到账号 JSON 或会话字段。");
  }

  const records = [];
  for (const document of parseJsonDocuments(text)) {
    records.push(...recordsFromJson(document));
  }
  if (records.length === 0) {
    records.push(...recordsFromPartialText(text));
  }

  const unique = deduplicateRecords(records);
  if (unique.length === 0) {
    throw new SessionNormalizationError("未识别到 access_token；请发送包含 OpenAI OAuth 会话字段的内容。");
  }
  if (unique.length > MAX_SESSION_RECORDS) {
    throw new SessionNormalizationError(`单次最多识别 ${MAX_SESSION_RECORDS} 个账号。`);
  }
  return unique;
}

/** Convert a supported session to the Manager Shared JSON account shape. */
export function normalizeManagerSharedEntries(rawText) {
  return parseSessionRecords(rawText).map((record, index) => {
    if (!record.idToken) {
      throw new SessionNormalizationError(`第 ${index + 1} 个账号缺少真实 id_token，无法导入 Manager。`);
    }
    let idClaims;
    let accessClaims;
    try {
      idClaims = decodeSignedJwt(record.idToken);
      accessClaims = decodeSignedJwt(record.accessToken);
    } catch {
      throw new SessionNormalizationError(
        `第 ${index + 1} 个账号的 OAuth JWT 不可用于 Manager；包含不安全或不受支持的账号令牌。`
      );
    }
    const email = claimEmail(idClaims, accessClaims);
    if (!email) {
      throw new SessionNormalizationError(`第 ${index + 1} 个账号的令牌中缺少可识别邮箱，无法导入 Manager。`);
    }
    const accountId = record.accountId ?? claimValue([idClaims, accessClaims], ACCOUNT_ID_KEYS);
    const userId = record.userId ?? claimValue([idClaims, accessClaims], USER_ID_KEYS);
    const planType = record.planType ?? claimValue([idClaims, accessClaims], PLAN_TYPE_KEYS);
    const tokens = {
      id_token: record.idToken,
      access_token: record.accessToken,
      ...(record.refreshToken ? { refresh_token: record.refreshToken } : {}),
      ...(accountId ? { account_id: accountId } : {})
    };
    return {
      email,
      tokens,
      ...(accountId ? { account_id: accountId } : {}),
      ...(userId ? { user_id: userId } : {}),
      ...(planType ? { plan_type: planType } : {})
    };
  });
}

/** Convert any recognized session to the canonical Sub2API export envelope. */
export function normalizeSub2ApiPayload(rawText, options = {}) {
  const nativePayload = findNativeSub2ApiPayload(parseJsonDocuments(rawText));
  if (nativePayload) {
    return nativePayload;
  }

  const seenIdentities = new Set();
  const accounts = [];
  for (const [index, record] of parseSessionRecords(rawText).entries()) {
    const idClaims = maybeDecodeSignedJwt(record.idToken);
    const accessClaims = maybeDecodeSignedJwt(record.accessToken);
    const email = validEmail(record.email) ?? claimEmail(idClaims, accessClaims);
    const accountId = record.accountId ?? claimValue([idClaims, accessClaims], ACCOUNT_ID_KEYS);
    const userId = record.userId ?? claimValue([idClaims, accessClaims], USER_ID_KEYS);
    const planType = record.planType ?? claimValue([idClaims, accessClaims], PLAN_TYPE_KEYS);
    if (!email && !accountId && !userId) {
      throw new SessionNormalizationError(
        `第 ${index + 1} 个账号缺少邮箱、ChatGPT account_id 或 user_id，无法安全导入 Sub2API。`
      );
    }
    const identity = `${email ?? ""}\u0000${accountId ?? ""}\u0000${userId ?? ""}\u0000${record.accessToken}`;
    if (seenIdentities.has(identity)) {
      continue;
    }
    seenIdentities.add(identity);

    const credentials = {
      access_token: record.accessToken,
      ...(record.idToken && idClaims ? { id_token: record.idToken } : {}),
      ...(record.refreshToken ? { refresh_token: record.refreshToken } : {}),
      ...(email ? { email } : {}),
      ...(accountId ? { chatgpt_account_id: accountId } : {}),
      ...(userId ? { chatgpt_user_id: userId } : {}),
      ...(planType ? { plan_type: planType } : {}),
      ...(record.expiresAt ? { expires_at: record.expiresAt } : {}),
      ...(record.expiresIn ? { expires_in: record.expiresIn } : {})
    };
    accounts.push({
      name: safeLabel(record.label) ?? email ?? accountId ?? userId ?? `openai-account-${index + 1}`,
      platform: "openai",
      type: "oauth",
      credentials
    });
  }
  if (accounts.length === 0) {
    throw new SessionNormalizationError("未找到可导入 Sub2API 的 OpenAI OAuth 账号。");
  }
  const now = options.now instanceof Date ? options.now : new Date();
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: now.toISOString(),
    proxies: [],
    accounts
  };
}

/** Structural JWT validation only; remote verification remains the target's responsibility. */
export function decodeSignedJwt(token) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new SessionNormalizationError("令牌不是受支持的 JWT 格式。");
  }
  let header;
  let payload;
  try {
    header = decodeJwtSegment(parts[0]);
    payload = decodeJwtSegment(parts[1]);
  } catch {
    throw new SessionNormalizationError("令牌 JWT 内容无效。");
  }
  if (!isRecord(header) || !isRecord(payload)) {
    throw new SessionNormalizationError("令牌 JWT 内容无效。");
  }
  const algorithm = nonempty(header.alg);
  if (!algorithm || algorithm.toLocaleLowerCase() === "none") {
    throw new SessionNormalizationError("不接受未签名或伪造的 OAuth Token。");
  }
  return payload;
}

function validateTextSize(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_SESSION_TEXT_BYTES) {
    throw new SessionNormalizationError(`账号导入内容不能超过 ${MAX_SESSION_TEXT_BYTES} 字节。`);
  }
}

function* balancedJsonFragments(text) {
  let start;
  let stack = [];
  let quote;
  let escaped = false;
  let yielded = 0;
  const matching = { "{": "}", "[": "]" };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (start === undefined) {
      if (character === "{" || character === "[") {
        start = index;
        stack = [matching[character]];
      }
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(matching[character]);
      continue;
    }
    if (character === "}" || character === "]") {
      if (stack.length === 0 || character !== stack.at(-1)) {
        start = undefined;
        stack = [];
        continue;
      }
      stack.pop();
      if (stack.length === 0 && start !== undefined) {
        yield text.slice(start, index + 1);
        yielded += 1;
        if (yielded >= 64) {
          return;
        }
        start = undefined;
      }
    }
  }
}

function recordsFromJson(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) {
    throw new SessionNormalizationError("JSON 嵌套层级过深。");
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => recordsFromJson(item, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }
  const records = [];
  const candidate = recordFromMapping(value);
  if (candidate) {
    records.push(candidate);
  }
  for (const [key, nested] of Object.entries(value)) {
    if ([...ACCESS_TOKEN_KEYS, ...ID_TOKEN_KEYS, ...REFRESH_TOKEN_KEYS].includes(key)) {
      continue;
    }
    if (isRecord(nested) || Array.isArray(nested)) {
      records.push(...recordsFromJson(nested, depth + 1));
    }
  }
  return records;
}

function recordFromMapping(value) {
  const tokenSources = [value];
  for (const key of TOKEN_CONTAINER_KEYS) {
    if (isRecord(value[key])) {
      tokenSources.push(value[key]);
    }
  }
  const accessToken = readFirst(tokenSources, ACCESS_TOKEN_KEYS);
  if (!accessToken) {
    return undefined;
  }
  const informationSources = [...tokenSources];
  for (const key of ["user", "profile", "account", "meta"]) {
    if (isRecord(value[key])) {
      informationSources.push(value[key]);
    }
  }
  return makeRecord(
    {
      accessToken,
      idToken: readFirst(tokenSources, ID_TOKEN_KEYS),
      refreshToken: readFirst(tokenSources, REFRESH_TOKEN_KEYS),
      accountId: readFirst(informationSources, ACCOUNT_ID_KEYS),
      userId: readFirst(informationSources, USER_ID_KEYS),
      email: readFirst(informationSources, EMAIL_KEYS),
      planType: readFirst(informationSources, PLAN_TYPE_KEYS),
      workspaceId: readFirst(informationSources, WORKSPACE_ID_KEYS),
      expiresAt: readFirst(informationSources, EXPIRES_AT_KEYS),
      expiresIn: readFirst(informationSources, EXPIRES_IN_KEYS),
      label: readFirst(informationSources, LABEL_KEYS)
    },
    detectFormat(value)
  );
}

function recordsFromPartialText(text) {
  const matches = [];
  for (const match of text.matchAll(PARTIAL_FIELD_PATTERN)) {
    const rawKey = match[1]?.trim().replace(/^["']|["']$/gu, "").toLocaleLowerCase();
    const field = partialFieldAliases.get(rawKey);
    const value = recoverScalar(match[2] ?? "");
    if (field && value) {
      matches.push({ position: match.index ?? 0, field, value });
    }
  }
  const accessPositions = matches.filter((match) => match.field === "access_token").map((match) => match.position);
  if (accessPositions.length === 0) {
    return [];
  }
  const fieldsByRecord = accessPositions.map(() => ({ accessToken: "" }));
  for (const match of matches) {
    let nearest = 0;
    for (let index = 1; index < accessPositions.length; index += 1) {
      if (Math.abs(accessPositions[index] - match.position) < Math.abs(accessPositions[nearest] - match.position)) {
        nearest = index;
      }
    }
    const target = fieldsByRecord[nearest];
    const property = partialFieldToProperty(match.field);
    if (match.field === "access_token" || target[property] === undefined) {
      target[property] = match.value;
    }
  }
  return fieldsByRecord.map((fields) => makeRecord(fields, detectFormatFromText(text))).filter(Boolean);
}

function partialFieldToProperty(field) {
  return {
    access_token: "accessToken",
    id_token: "idToken",
    refresh_token: "refreshToken",
    account_id: "accountId",
    user_id: "userId",
    email: "email",
    plan_type: "planType",
    workspace_id: "workspaceId",
    expires_at: "expiresAt",
    expires_in: "expiresIn",
    label: "label"
  }[field];
}

function makeRecord(fields, sourceFormat) {
  const accessToken = nonempty(fields.accessToken);
  if (!accessToken) {
    return undefined;
  }
  return {
    accessToken,
    idToken: nonempty(fields.idToken),
    refreshToken: nonempty(fields.refreshToken),
    accountId: nonempty(fields.accountId),
    userId: nonempty(fields.userId),
    email: nonempty(fields.email),
    planType: nonempty(fields.planType),
    workspaceId: nonempty(fields.workspaceId),
    expiresAt: nonempty(fields.expiresAt),
    expiresIn: nonempty(fields.expiresIn),
    label: nonempty(fields.label),
    sourceFormat
  };
}

function deduplicateRecords(records) {
  const positions = new Map();
  const result = [];
  for (const record of records) {
    const fingerprint = createHash("sha256")
      .update(`${record.idToken ?? ""}\u0000${record.accessToken}`, "utf8")
      .digest("hex");
    const existing = positions.get(fingerprint);
    if (existing === undefined) {
      positions.set(fingerprint, result.length);
      result.push(record);
      continue;
    }
    if (recordScore(record) > recordScore(result[existing])) {
      result[existing] = record;
    }
  }
  return result;
}

function recordScore(record) {
  return [
    record.idToken,
    record.refreshToken,
    record.accountId,
    record.userId,
    record.email,
    record.planType,
    record.workspaceId,
    record.expiresAt,
    record.expiresIn,
    record.label
  ].filter(Boolean).length;
}

function readFirst(sources, keys) {
  for (const source of [...sources].reverse()) {
    for (const key of keys) {
      const value = nonempty(source[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function recoverScalar(value) {
  const normalized = value.trim();
  if (!normalized || ["null", "none", "undefined"].includes(normalized.toLocaleLowerCase())) {
    return undefined;
  }
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    try {
      return nonempty(JSON.parse(normalized));
    } catch {
      return nonempty(normalized.slice(1, -1));
    }
  }
  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    return nonempty(normalized.slice(1, -1).replaceAll("\\'", "'").replaceAll("\\\\", "\\"));
  }
  return nonempty(normalized);
}

function decodeJwtSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function maybeDecodeSignedJwt(token) {
  if (!token) {
    return undefined;
  }
  try {
    return decodeSignedJwt(token);
  } catch {
    return undefined;
  }
}

function claimEmail(...payloads) {
  for (const payload of payloads) {
    if (!isRecord(payload)) {
      continue;
    }
    const profile = isRecord(payload["https://api.openai.com/profile"])
      ? payload["https://api.openai.com/profile"]
      : {};
    for (const source of [payload, profile]) {
      for (const key of ["email", "preferred_username", "upn"]) {
        const email = validEmail(nonempty(source[key]));
        if (email) {
          return email;
        }
      }
    }
  }
  return undefined;
}

function claimValue(payloads, keys) {
  for (const payload of payloads) {
    if (!isRecord(payload)) {
      continue;
    }
    const auth = isRecord(payload["https://api.openai.com/auth"]) ? payload["https://api.openai.com/auth"] : {};
    const profile = isRecord(payload["https://api.openai.com/profile"])
      ? payload["https://api.openai.com/profile"]
      : {};
    for (const source of [auth, payload, profile]) {
      for (const key of keys) {
        const value = nonempty(source[key]);
        if (value) {
          return value;
        }
      }
    }
  }
  return undefined;
}

function findNativeSub2ApiPayload(documents) {
  for (const document of documents) {
    if (
      isRecord(document) &&
      ["sub2api-data", "sub2api-bundle"].includes(document.type) &&
      Array.isArray(document.accounts) &&
      Array.isArray(document.proxies) &&
      document.accounts.length > 0 &&
      document.accounts.length <= MAX_SESSION_RECORDS
    ) {
      return structuredClone(document);
    }
  }
  return undefined;
}

function detectFormat(value) {
  const payloadType = nonempty(value.type);
  if (
    ["sub2api-data", "sub2api-bundle"].includes(payloadType) ||
    (isRecord(value.credentials) && nonempty(value.platform))
  ) {
    return "sub2api";
  }
  if ("session_token" in value || "chatgpt_plan_type" in value) {
    return "cpa";
  }
  if (["cockpit", "cookpit"].includes(payloadType) || "account_note" in value || "accountNote" in value) {
    return "cockpit";
  }
  if (isRecord(value.meta) && isRecord(value.tokens)) {
    return "manager";
  }
  if ("auth_mode" in value || "OPENAI_API_KEY" in value || isRecord(value.tokens)) {
    return "codex";
  }
  return "session";
}

function detectFormatFromText(text) {
  const lowered = text.toLocaleLowerCase();
  if (lowered.includes("sub2api") || lowered.includes('"proxies"')) {
    return "sub2api";
  }
  if (lowered.includes("session_token") || lowered.includes("chatgpt_plan_type")) {
    return "cpa";
  }
  if (lowered.includes("cockpit") || lowered.includes("cookpit") || lowered.includes("account_note")) {
    return "cockpit";
  }
  if (lowered.includes("auth_mode") || lowered.includes("openai_api_key")) {
    return "codex";
  }
  return "session";
}

function validEmail(value) {
  return value && EMAIL_PATTERN.test(value) ? value : undefined;
}

function safeLabel(value) {
  return nonempty(value)?.slice(0, 160);
}

function nonempty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
