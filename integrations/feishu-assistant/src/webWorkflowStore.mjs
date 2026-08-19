import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeWebUrl } from "./webPage.mjs";
import { normalizeStoredWorkflow, publicWorkflowRecord, WEB_WORKFLOW_SCHEMA } from "./webWorkflowSchema.mjs";

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 100;

export function resolveWebWorkflowStatePath(env = process.env) {
  const configured = nonempty(env.FEISHU_ASSISTANT_WEB_WORKFLOW_STATE_PATH);
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("FEISHU_ASSISTANT_WEB_WORKFLOW_STATE_PATH 必须是绝对路径。");
    }
    return path.normalize(configured);
  }
  const stateHome = nonempty(env.XDG_STATE_HOME);
  const root = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), ".local", "state");
  return path.join(root, "codex-account-integrations", "feishu-assistant", "web-workflows.json");
}

export function createWebWorkflowStore(options = {}) {
  const statePath = options.statePath ?? resolveWebWorkflowStatePath(options.env);
  let writeChain = Promise.resolve();
  return {
    statePath,
    async list() {
      return readState();
    },
    async get(url) {
      const normalizedUrl = normalizeWebUrl(url);
      return (await readState()).find((record) => record.url === normalizedUrl);
    },
    put(record) {
      return mutateState((records) => {
        const normalized = normalizeStoredWorkflow(record);
        const index = records.findIndex((item) => item.url === normalized.url);
        if (index >= 0) records[index] = normalized;
        else records.unshift(normalized);
        return records.slice(0, MAX_RECORDS);
      });
    },
    async remove(url) {
      const normalizedUrl = normalizeWebUrl(url);
      await mutateState((records) => records.filter((record) => record.url !== normalizedUrl));
    },
    public(record) {
      return publicWorkflowRecord(record);
    }
  };

  async function readState() {
    await ensurePrivateDirectory(path.dirname(statePath));
    const info = await safeLstat(statePath);
    if (!info) return [];
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
      throw new Error("网页流程状态文件不安全。");
    }
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.schema !== WEB_WORKFLOW_SCHEMA ||
      !Array.isArray(parsed.records)
    ) {
      throw new Error("网页流程状态文件格式无效。");
    }
    return parsed.records.slice(0, MAX_RECORDS).map((record) => normalizeStoredWorkflow(record));
  }

  function mutateState(mutator) {
    const operation = writeChain.then(async () => {
      const records = await readState();
      const next = await mutator(records);
      await writeState(next);
    });
    writeChain = operation.catch(() => undefined);
    return operation;
  }

  async function writeState(records) {
    await ensurePrivateDirectory(path.dirname(statePath));
    const encoded = `${JSON.stringify({ schema: WEB_WORKFLOW_SCHEMA, records })}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_STATE_BYTES) {
      throw new Error("网页流程状态文件过大。");
    }
    const existing = await safeLstat(statePath);
    if (existing?.isSymbolicLink()) throw new Error("网页流程状态文件不能是符号链接。");
    const temporary = path.join(path.dirname(statePath), `.${path.basename(statePath)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, statePath);
      await fs.chmod(statePath, 0o600);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw new Error("网页流程状态目录不安全。");
  }
  await fs.chmod(directory, 0o700);
}

async function safeLstat(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function nonempty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
