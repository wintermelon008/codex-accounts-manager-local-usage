import * as Lark from "@larksuiteoapi/node-sdk";
import { formatJob, formatPaymentStatus, handleAssistantEvent } from "./handler.mjs";

const MESSAGE_EVENT = "im.message.receive_v1";
const DEDUPE_TTL_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 60 * 1_000;
const MAX_QR_BYTES = 4 * 1024 * 1024;
const QR_FETCH_TIMEOUT_MS = 10_000;

export function createFeishuAssistant(options) {
  const client = options.client ?? new Lark.Client({ appId: options.appId, appSecret: options.appSecret });
  const wsClient =
    options.wsClient ??
    new Lark.WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      loggerLevel: options.loggerLevel ?? Lark.LoggerLevel?.info
    });
  const seenMessages = new Map();
  const paymentTargets = new Map();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let started = false;

  if (options.paymentWorkflow && typeof options.paymentWorkflow.setOnUpdate === "function") {
    options.paymentWorkflow.setOnUpdate((order) => notifyPaymentUpdate(order));
  }

  const eventDispatcher =
    options.eventDispatcher ??
    new Lark.EventDispatcher({}).register({
      [MESSAGE_EVENT]: (event) => {
        void processMessage(event).catch((error) => {
          console.warn("[feishu-assistant] message handling failed:", safeError(error));
        });
      }
    });

  return {
    async start() {
      if (started) {
        throw new Error("飞书操纵助手已经启动。 ");
      }
      started = true;
      let socketStarted = false;
      try {
        if (options.paymentWorkflow && typeof options.paymentWorkflow.listActive === "function") {
          const activeOrders = await options.paymentWorkflow.listActive({ includeDeliveryTarget: true });
          for (const order of activeOrders) {
            rememberPaymentTarget(order);
          }
        }
        await wsClient.start({ eventDispatcher });
        socketStarted = true;
        if (options.paymentWorkflow && typeof options.paymentWorkflow.start === "function") {
          await options.paymentWorkflow.start();
        }
      } catch (error) {
        started = false;
        if (socketStarted) {
          await closeWebSocket(wsClient).catch(() => undefined);
        }
        throw error;
      }
    },
    async stop() {
      if (!started) {
        return;
      }
      started = false;
      try {
        if (options.paymentWorkflow && typeof options.paymentWorkflow.stop === "function") {
          await options.paymentWorkflow.stop();
        }
      } finally {
        await closeWebSocket(wsClient);
      }
    },
    async processMessage(event) {
      return processMessage(event);
    },
    client,
    wsClient
  };

  async function processMessage(event) {
    const messageId = extractMessageId(event);
    if (messageId && isDuplicate(messageId)) {
      return { handled: false, duplicate: true };
    }
    const result = await handleAssistantEvent(event, {
      adminOpenIds: options.adminOpenIds,
      manager: options.manager,
      paymentWorkflow: options.paymentWorkflow,
      webWorkflow: options.webWorkflow
    });
    if (!result.handled || !result.reply) {
      return result;
    }
    const chatId = event?.message?.chat_id;
    if (typeof chatId !== "string" || !chatId) {
      return { ...result, sent: false };
    }
    rememberPaymentTarget(result.paymentOrder, chatId);
    await sendText(client, chatId, result.reply);
    let qrSent;
    if (result.paymentQr) {
      qrSent = await sendPaymentQr(client, chatId, result.paymentQr, fetchImpl);
    }
    if (result.followUpJobId) {
      void pollAndReply(chatId, result.followUpJobId).catch((error) => {
        console.warn("[feishu-assistant] quota refresh follow-up failed:", safeError(error));
      });
    }
    return { ...result, sent: true, ...(qrSent === undefined ? {} : { qrSent }) };
  }

  async function notifyPaymentUpdate(order) {
    const chatId = order?.chatId ?? paymentTargets.get(order?.orderId);
    if (typeof chatId !== "string" || !chatId || !order?.orderId) {
      return;
    }
    rememberPaymentTarget(order, chatId);
    if (
      [
        "fulfilling",
        "fulfillment_pending",
        "fulfillment_failed",
        "fulfilled",
        "payment_failed",
        "payment_expired"
      ].includes(order.state)
    ) {
      await sendText(client, chatId, formatPaymentStatus(order));
    }
    if (["fulfilled", "payment_failed", "payment_expired"].includes(order.state)) {
      paymentTargets.delete(order.orderId);
    }
  }

  function rememberPaymentTarget(order, chatId = order?.chatId) {
    if (order?.orderId && typeof chatId === "string" && chatId) {
      paymentTargets.set(order.orderId, chatId);
    }
  }

  async function pollAndReply(chatId, jobId) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await wait(POLL_INTERVAL_MS);
      const job = await options.manager.getJob(jobId);
      if (job?.state === "completed" || job?.state === "failed") {
        await sendText(client, chatId, formatJob(job));
        return;
      }
    }
    await sendText(client, chatId, `额度刷新仍在运行\n任务编号：${jobId}\n可稍后发送“健康”或重新刷新查询。`);
  }

  function isDuplicate(messageId) {
    const now = Date.now();
    for (const [id, expiresAt] of seenMessages) {
      if (expiresAt <= now) {
        seenMessages.delete(id);
      }
    }
    if (seenMessages.has(messageId)) {
      return true;
    }
    seenMessages.set(messageId, now + DEDUPE_TTL_MS);
    return false;
  }
}

async function sendText(client, chatId, text) {
  await client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text })
    }
  });
}

async function closeWebSocket(wsClient) {
  if (typeof wsClient.stop === "function") {
    await wsClient.stop();
  } else if (typeof wsClient.close === "function") {
    await wsClient.close({ force: true });
  }
}

async function sendPaymentQr(client, chatId, qr, fetchImpl) {
  try {
    let imageKey = qr?.imageKey;
    if (!imageKey && qr?.imageBase64) {
      imageKey = await uploadPaymentImage(client, decodeBase64Image(qr.imageBase64));
    }
    if (!imageKey && qr?.imageUrl) {
      if (typeof fetchImpl !== "function") {
        throw new Error("当前运行时不支持获取二维码图片。");
      }
      imageKey = await uploadPaymentImage(client, await downloadPaymentImage(qr.imageUrl, fetchImpl));
    }
    if (imageKey) {
      await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "image",
          content: JSON.stringify({ image_key: imageKey })
        }
      });
      return true;
    }
    if (qr?.content) {
      await sendText(client, chatId, `二维码内容或支付链接：\n${qr.content}`);
      return true;
    }
    throw new Error("支付适配器没有可发送的二维码内容。");
  } catch (error) {
    console.warn("[feishu-assistant] payment QR delivery failed:", error instanceof Error ? error.name : "unknown");
    const fallback = qr?.content ?? qr?.imageUrl;
    await sendText(
      client,
      chatId,
      fallback
        ? `二维码图片暂时无法发送，请打开以下 HTTPS 地址完成支付：\n${fallback}`
        : "二维码暂时无法发送，请稍后查询支付状态。"
    );
    return false;
  }
}

async function uploadPaymentImage(client, image) {
  const response = await client.im.v1.image.create({
    data: { image_type: "message", image }
  });
  const imageKey = response?.image_key ?? response?.data?.image_key;
  if (typeof imageKey !== "string" || !imageKey) {
    throw new Error("飞书图片接口没有返回 image_key。");
  }
  return imageKey;
}

function decodeBase64Image(value) {
  const payload = value.replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, "").replace(/\s+/gu, "");
  if (!payload || payload.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/iu.test(payload)) {
    throw new Error("支付适配器返回的二维码图片不是有效 Base64。");
  }
  const image = Buffer.from(payload, "base64");
  if (image.length === 0 || image.length > MAX_QR_BYTES) {
    throw new Error("支付二维码图片大小无效。");
  }
  return image;
}

async function downloadPaymentImage(imageUrl, fetchImpl) {
  const url = new URL(imageUrl);
  if (url.protocol !== "https:") {
    throw new Error("支付二维码图片地址必须使用 HTTPS。");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QR_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url.href, { signal: controller.signal, redirect: "error" });
    if (!response?.ok) {
      throw new Error("支付二维码图片获取失败。");
    }
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_QR_BYTES) {
      throw new Error("支付二维码图片过大。");
    }
    const image = Buffer.from(await response.arrayBuffer());
    if (image.length === 0 || image.length > MAX_QR_BYTES) {
      throw new Error("支付二维码图片大小无效。");
    }
    return image;
  } finally {
    clearTimeout(timeout);
  }
}

function extractMessageId(event) {
  const messageId = event?.message?.message_id ?? event?.event_id;
  return typeof messageId === "string" && messageId ? messageId : undefined;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}
