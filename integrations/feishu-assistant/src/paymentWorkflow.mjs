import { randomUUID } from "node:crypto";
import {
  assertPaymentProvider,
  normalizeFulfillmentResult,
  normalizePaymentCreation,
  normalizePaymentStatus,
  PAYMENT_REMOTE_STATES,
  PaymentProviderError
} from "./paymentProvider.mjs";
import { PAYMENT_STATE_SCHEMA } from "./paymentStore.mjs";

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const ACTIVE_STATES = new Set([
  "creating",
  "awaiting_payment",
  "fulfilling",
  "fulfillment_pending",
  "fulfillment_failed"
]);

export function createPaymentWorkflow(options) {
  assertPaymentProvider(options.provider);
  const store = options.store;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const locks = new Map();
  let timer;
  let onUpdate = options.onUpdate;

  return {
    setOnUpdate(callback) {
      onUpdate = callback;
    },
    async begin(input) {
      const requesterId = requireString(input?.requesterId, "requesterId");
      const chatId = requireString(input?.chatId, "chatId");
      const productId = requireString(input?.productId, "productId");
      const quantity = Number.isInteger(input?.quantity) && input.quantity > 0 ? input.quantity : 1;
      return withLock(`requester:${requesterId}`, async () => {
        let record = await store.findActiveForRequester(requesterId);
        if (!record) {
          record = {
            schema: PAYMENT_STATE_SCHEMA,
            requesterId,
            chatId,
            productId,
            quantity,
            creationKey: `feishu-payment-${randomUUID()}`,
            state: "creating",
            fulfillmentState: "not_started",
            createdAt: now(),
            updatedAt: now()
          };
          record = await store.putIfAbsent(record);
        }
        if (record.state !== "creating") {
          return { created: false, order: publicPaymentOrder(record) };
        }
        try {
          let providerOrder;
          try {
            providerOrder = await options.provider.createOrder({
              requesterId: record.requesterId,
              chatId: record.chatId,
              productId: record.productId,
              quantity: record.quantity,
              idempotencyKey: record.creationKey
            });
          } catch {
            throw new PaymentProviderError("支付订单创建失败。", "payment_order_create");
          }
          const created = normalizePaymentCreation(providerOrder);
          record = {
            ...record,
            ...created,
            state: "awaiting_payment",
            updatedAt: now(),
            lastError: undefined
          };
          await store.put(record);
          return { created: true, order: publicPaymentOrder(record) };
        } catch (error) {
          record = { ...record, lastError: safeError(error), updatedAt: now() };
          await store.put(record);
          throw error;
        }
      });
    },
    async sync(orderId) {
      const normalizedOrderId = requireString(orderId, "orderId");
      return withLock(`order:${normalizedOrderId}`, async () => syncOne(normalizedOrderId));
    },
    async syncForRequester(requesterId, orderId) {
      const normalizedRequesterId = requireString(requesterId, "requesterId");
      const record = orderId
        ? await store.get(requireString(orderId, "orderId"))
        : await store.findActiveForRequester(normalizedRequesterId);
      if (!record || record.requesterId !== normalizedRequesterId) {
        return undefined;
      }
      if (!record.orderId) {
        return publicPaymentOrder(record);
      }
      return withLock(`order:${record.orderId}`, async () => syncOne(record.orderId));
    },
    async listActive(options = {}) {
      return (await store.list())
        .filter((record) => ACTIVE_STATES.has(record.state))
        .map((record) => publicPaymentOrder(record, options.includeDeliveryTarget === true));
    },
    async start() {
      if (timer) {
        return;
      }
      void syncAll();
      timer = setInterval(() => {
        void syncAll();
      }, pollIntervalMs);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  };

  async function syncAll() {
    const records = await store.list();
    for (const record of records.filter((item) => ACTIVE_STATES.has(item.state) && item.orderId)) {
      await withLock(`order:${record.orderId}`, () => syncOne(record.orderId)).catch((error) => {
        console.warn("[feishu-assistant] payment status sync failed:", safeError(error));
      });
    }
  }

  async function syncOne(orderId) {
    const record = await store.get(orderId);
    if (!record || !record.orderId || !ACTIVE_STATES.has(record.state)) {
      return record ? publicPaymentOrder(record) : undefined;
    }
    if (
      record.paymentState === PAYMENT_REMOTE_STATES.PAID ||
      record.state === "fulfilling" ||
      record.state.startsWith("fulfillment_")
    ) {
      return fulfill(record, {
        state: PAYMENT_REMOTE_STATES.PAID,
        paidAt: record.paidAt,
        reference: record.paymentReference
      });
    }
    let remoteStatus;
    try {
      remoteStatus = await options.provider.getOrderStatus(record.orderId);
    } catch {
      throw new PaymentProviderError("支付状态暂时无法查询。", "payment_status_query");
    }
    const remote = normalizePaymentStatus(remoteStatus);
    const checked = { ...record, lastCheckedAt: now(), updatedAt: now() };
    if (remote.state === PAYMENT_REMOTE_STATES.PENDING || remote.state === PAYMENT_REMOTE_STATES.UNKNOWN) {
      checked.state = "awaiting_payment";
      checked.lastError =
        remote.state === PAYMENT_REMOTE_STATES.UNKNOWN ? (remote.message ?? "支付状态暂无法确认。") : undefined;
      await saveAndNotify(checked, record);
      return publicPaymentOrder(checked);
    }
    if (remote.state === PAYMENT_REMOTE_STATES.FAILED || remote.state === PAYMENT_REMOTE_STATES.EXPIRED) {
      checked.state = remote.state === PAYMENT_REMOTE_STATES.EXPIRED ? "payment_expired" : "payment_failed";
      checked.paymentState = remote.state;
      checked.lastError = remote.message;
      await saveAndNotify(checked, record);
      return publicPaymentOrder(checked);
    }

    checked.state = "fulfilling";
    checked.paymentState = PAYMENT_REMOTE_STATES.PAID;
    checked.paidAt = remote.paidAt ?? checked.paidAt ?? new Date(now()).toISOString();
    checked.paymentReference = remote.reference;
    checked.lastError = undefined;
    await saveAndNotify(checked, record);
    return fulfill(checked, remote);
  }

  async function fulfill(record, payment) {
    if (record.fulfillmentState === "completed") {
      return publicPaymentOrder(record);
    }
    const running = {
      ...record,
      fulfillmentState: "running",
      fulfillmentAttempts: (record.fulfillmentAttempts ?? 0) + 1,
      updatedAt: now()
    };
    await store.put(running);
    try {
      const result = normalizeFulfillmentResult(
        await options.provider.fulfillPaidOrder({
          order: publicPaymentOrder(running),
          payment,
          idempotencyKey: running.creationKey,
          previousResult: running.fulfillmentResult
        })
      );
      const completed = {
        ...running,
        state:
          result.state === "completed"
            ? "fulfilled"
            : result.state === "pending"
              ? "fulfillment_pending"
              : "fulfillment_failed",
        fulfillmentState: result.state === "completed" ? "completed" : result.state,
        fulfillmentResult: result,
        lastError: result.state === "failed" ? (result.message ?? "支付后续流程失败。") : undefined,
        updatedAt: now()
      };
      await saveAndNotify(completed, running);
      return publicPaymentOrder(completed);
    } catch (error) {
      const failed = {
        ...running,
        state: "fulfillment_failed",
        fulfillmentState: "failed",
        lastError: error instanceof PaymentProviderError ? error.message : "支付后续流程失败。",
        updatedAt: now()
      };
      await saveAndNotify(failed, running);
      return publicPaymentOrder(failed);
    }
  }

  async function saveAndNotify(next, previous = undefined) {
    await store.put(next);
    if (!previous || hasVisibleChange(previous, next)) {
      await emitUpdate(publicPaymentOrder(next, true));
    }
  }

  async function emitUpdate(order) {
    if (typeof onUpdate !== "function") {
      return;
    }
    try {
      await onUpdate(order);
    } catch (error) {
      console.warn("[feishu-assistant] payment notification failed:", safeError(error));
    }
  }

  function withLock(key, task) {
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.then(task, task);
    locks.set(
      key,
      current.finally(() => {
        if (locks.get(key) === current) {
          locks.delete(key);
        }
      })
    );
    return current;
  }
}

export function publicPaymentOrder(record, options = {}) {
  const order = {
    orderId: record.orderId,
    state: record.state,
    productId: record.productId,
    quantity: record.quantity,
    amountFen: record.amountFen,
    currency: record.currency,
    qr: record.qr,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    paidAt: record.paidAt,
    fulfillmentState: record.fulfillmentState,
    fulfillmentAttempts: record.fulfillmentAttempts,
    fulfillmentResult: record.fulfillmentResult,
    lastError: record.lastError,
    managerImportJobId: record.fulfillmentResult?.managerImportJobId
  };
  if (options.includeDeliveryTarget === true) {
    order.chatId = record.chatId;
  }
  return order;
}

function hasVisibleChange(previous, next) {
  return (
    previous.state !== next.state ||
    previous.fulfillmentState !== next.fulfillmentState ||
    previous.lastError !== next.lastError ||
    previous.orderId !== next.orderId ||
    JSON.stringify(previous.fulfillmentResult) !== JSON.stringify(next.fulfillmentResult)
  );
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 240 ? message : "支付流程失败。";
}
