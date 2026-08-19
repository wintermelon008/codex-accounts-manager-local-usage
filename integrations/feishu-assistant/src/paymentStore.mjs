import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const PAYMENT_STATE_SCHEMA = "feishu-assistant-payment/v1";
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_ORDERS = 100;
const ACTIVE_STATES = new Set([
  "creating",
  "awaiting_payment",
  "fulfilling",
  "fulfillment_pending",
  "fulfillment_failed"
]);

export function resolvePaymentStatePath(env = process.env) {
  const configured = nonempty(env.FEISHU_ASSISTANT_PAYMENT_STATE_PATH);
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("FEISHU_ASSISTANT_PAYMENT_STATE_PATH 必须是绝对路径。");
    }
    return path.normalize(configured);
  }
  const configuredStateHome = nonempty(env.XDG_STATE_HOME);
  const stateHome =
    configuredStateHome && path.isAbsolute(configuredStateHome)
      ? configuredStateHome
      : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "codex-account-integrations", "feishu-assistant", "payments.json");
}

export function createPaymentStore(options = {}) {
  const statePath = options.statePath ?? resolvePaymentStatePath(options.env);
  let writeChain = Promise.resolve();

  return {
    statePath,
    list: () => readState(),
    get: async (orderId) => (await readState()).find((record) => record.orderId === orderId),
    findActiveForRequester: async (requesterId) =>
      (await readState()).find((record) => record.requesterId === requesterId && ACTIVE_STATES.has(record.state)),
    put: (record) =>
      mutateState((records) => {
        const index = records.findIndex(
          (item) => item.orderId === record.orderId || item.creationKey === record.creationKey
        );
        if (index >= 0) {
          records[index] = clone(record);
        } else {
          records.unshift(clone(record));
        }
        return records;
      }),
    putIfAbsent: (record) =>
      mutateState((records) => {
        const existing = records.find(
          (item) => item.requesterId === record.requesterId && ACTIVE_STATES.has(item.state)
        );
        if (existing) {
          return { records, result: clone(existing) };
        }
        records.unshift(clone(record));
        return { records, result: clone(record) };
      })
  };

  async function readState() {
    await ensurePrivateDirectory(path.dirname(statePath));
    const info = await safeLstat(statePath);
    if (!info) {
      return [];
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
      throw new Error("支付状态文件不安全。");
    }
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.schema !== PAYMENT_STATE_SCHEMA ||
      !Array.isArray(parsed.orders) ||
      parsed.orders.length > MAX_ORDERS
    ) {
      throw new Error("支付状态文件格式无效。");
    }
    return parsed.orders.filter(isPaymentRecord).map(clone);
  }

  function mutateState(mutator) {
    const operation = writeChain.then(async () => {
      const records = await readState();
      const result = await mutator(records);
      const nextRecords = Array.isArray(result) ? result : result.records;
      await writeState(nextRecords.slice(0, MAX_ORDERS));
      return Array.isArray(result) ? undefined : result.result;
    });
    writeChain = operation.catch(() => undefined);
    return operation;
  }

  async function writeState(records) {
    await ensurePrivateDirectory(path.dirname(statePath));
    const encoded = `${JSON.stringify({ schema: PAYMENT_STATE_SCHEMA, orders: records })}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_STATE_BYTES) {
      throw new Error("支付状态文件过大。");
    }
    const existing = await safeLstat(statePath);
    if (existing?.isSymbolicLink()) {
      throw new Error("支付状态文件不能是符号链接。");
    }
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

function isPaymentRecord(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schema === PAYMENT_STATE_SCHEMA &&
    typeof value.requesterId === "string" &&
    (typeof value.orderId === "string" || typeof value.creationKey === "string") &&
    typeof value.state === "string"
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || info.isSymbolicLink() || (currentUid !== undefined && info.uid !== currentUid)) {
    throw new Error("支付状态目录不安全。");
  }
  await fs.chmod(directory, 0o700);
}

async function safeLstat(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function nonempty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
