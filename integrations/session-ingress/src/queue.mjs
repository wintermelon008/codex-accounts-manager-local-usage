import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeManagerSharedEntries, normalizeSub2ApiPayload, SessionNormalizationError } from "./normalizer.mjs";

export const MANAGER_IMPORT_JOB_SCHEMA = "codex-account-import/v1";
export const MANAGER_IMPORT_RESULT_SCHEMA = "codex-account-import-result/v1";
export const SUB2API_IMPORT_JOB_SCHEMA = "sub2api-import/v1";
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_STATUS_BYTES = 64 * 1024;

export class SessionIngressError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionIngressError";
  }
}

/**
 * Locate the Manager's opt-in inbox without embedding a device path. If the
 * Manager uses a non-default target, set MANAGER_IMPORT_QUEUE_DIR explicitly
 * in both processes.
 */
export function resolveManagerImportQueueDirectory(env = process.env) {
  const configured = nonempty(env.MANAGER_IMPORT_QUEUE_DIR) ?? nonempty(env.CODEX_IMPORT_QUEUE_DIR);
  if (configured) {
    return requireAbsoluteDirectory(configured, "MANAGER_IMPORT_QUEUE_DIR");
  }
  return path.join(resolveStateHome(env), "codex-account-import", "inbox");
}

/** Locate the standalone S+ handoff outbox. */
export function resolveSub2ApiImportQueueDirectory(env = process.env) {
  const configured = nonempty(env.SUB2API_IMPORT_QUEUE_DIR);
  if (configured) {
    return requireAbsoluteDirectory(configured, "SUB2API_IMPORT_QUEUE_DIR");
  }
  return path.join(resolveIngressStateDirectory(env), "sub2api-import", "outbox");
}

export function resolveIngressStateDirectory(env = process.env) {
  const configured = nonempty(env.SESSION_INGRESS_STATE_DIR);
  if (configured) {
    return requireAbsoluteDirectory(configured, "SESSION_INGRESS_STATE_DIR");
  }
  return path.join(resolveStateHome(env), "codex-account-integrations");
}

export async function enqueueManagerImport(rawText, options = {}) {
  const entries = normalizeManagerSharedEntries(rawText);
  const queueDirectory = options.queueDirectory ?? resolveManagerImportQueueDirectory(options.env);
  await ensurePrivateDirectory(queueDirectory);
  const id = randomUUID();
  await atomicWriteJson(path.join(queueDirectory, `${id}.json`), {
    schema: MANAGER_IMPORT_JOB_SCHEMA,
    id,
    created_at: new Date().toISOString(),
    accounts: entries
  });
  return { id, accountCount: entries.length };
}

export async function enqueueSub2ApiImport(rawText, options = {}) {
  const payload = normalizeSub2ApiPayload(rawText, { now: options.now });
  const queueDirectory = options.queueDirectory ?? resolveSub2ApiImportQueueDirectory(options.env);
  await ensurePrivateDirectory(queueDirectory);
  const id = randomUUID();
  await atomicWriteJson(path.join(queueDirectory, `${id}.json`), {
    schema: SUB2API_IMPORT_JOB_SCHEMA,
    id,
    created_at: new Date().toISOString(),
    payload
  });
  return { id, accountCount: payload.accounts.length, proxyCount: payload.proxies.length };
}

/** Read only counters and state; credential material is never returned. */
export async function readManagerImportStatus(jobId, options = {}) {
  const id = normalizeJobId(jobId);
  const queueDirectory = options.queueDirectory ?? resolveManagerImportQueueDirectory(options.env);
  const resultPath = path.join(path.dirname(queueDirectory), "results", `${id}.json`);
  const result = await readPrivateJson(resultPath, MAX_STATUS_BYTES).catch(() => undefined);
  if (isRecord(result) && result.schema === MANAGER_IMPORT_RESULT_SCHEMA && result.id === id) {
    return {
      id,
      state: normalizeState(result.status),
      total: nonNegativeInteger(result.total),
      imported: nonNegativeInteger(result.imported),
      poolEnabled: nonNegativeInteger(result.pool_enabled),
      refreshFailed: nonNegativeInteger(result.refresh_failed),
      notEligible: nonNegativeInteger(result.not_eligible)
    };
  }
  if (await safeRegularFile(path.join(queueDirectory, `${id}.processing`))) {
    return { id, state: "processing" };
  }
  if (await safeRegularFile(path.join(queueDirectory, `${id}.json`))) {
    return { id, state: "queued" };
  }
  return { id, state: "unknown" };
}

export function formatManagerImportStatus(status) {
  if (status.state === "queued") {
    return `Codex 账号导入\n任务 ${status.id} 正在等待本机 Codex Accounts Manager 处理。`;
  }
  if (status.state === "processing") {
    return `Codex 账号导入\n任务 ${status.id} 正在导入、测活并刷新额度。`;
  }
  if (["completed", "partial", "failed"].includes(status.state)) {
    const label = { completed: "已完成", partial: "部分完成", failed: "失败" }[status.state];
    return (
      "Codex 账号导入\n" +
      `任务 ${status.id} ${label}：共 ${status.total ?? 0} 个，已导入 ${status.imported ?? 0} 个，` +
      `已加入无感池 ${status.poolEnabled ?? 0} 个，额度刷新失败 ${status.refreshFailed ?? 0} 个，资格未通过 ${status.notEligible ?? 0} 个。`
    );
  }
  return `Codex 账号导入\n未找到任务 ${status.id} 的状态记录。`;
}

export function toSafeIngressError(error) {
  if (error instanceof SessionNormalizationError || error instanceof SessionIngressError) {
    return error;
  }
  return new SessionIngressError("本地导入任务无法安全处理。");
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (currentUid !== undefined && info.uid !== currentUid)) {
    throw new SessionIngressError("本地导入队列路径不安全。");
  }
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function atomicWriteJson(target, value) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw new SessionIngressError("无法写入本地导入队列。", { cause: error });
  }
}

async function readPrivateJson(target, maxBytes) {
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new SessionIngressError("本地状态文件不安全。");
  }
  return JSON.parse(await fs.readFile(target, "utf8"));
}

async function safeRegularFile(target) {
  try {
    const info = await fs.lstat(target);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveStateHome(env) {
  const configured = nonempty(env.XDG_STATE_HOME);
  if (configured && path.isAbsolute(configured)) {
    return configured;
  }
  return path.join(os.homedir(), ".local", "state");
}

function requireAbsoluteDirectory(value, variableName) {
  if (!path.isAbsolute(value)) {
    throw new SessionIngressError(`${variableName} 必须是绝对本地路径。`);
  }
  return path.normalize(value);
}

function normalizeJobId(value) {
  const id = nonempty(value)?.toLocaleLowerCase();
  if (!id || !JOB_ID_PATTERN.test(id)) {
    throw new SessionIngressError("任务编号格式无效。");
  }
  return id;
}

function normalizeState(value) {
  return ["completed", "partial", "failed"].includes(value) ? value : "unknown";
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonempty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
