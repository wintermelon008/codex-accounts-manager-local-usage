import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFeishuAssistant } from "../src/feishuBot.mjs";

describe("Feishu long-connection adapter", () => {
  it("sends a private reply and deduplicates repeated message events", async () => {
    const sent = [];
    const bot = createFeishuAssistant({
      appId: "app-placeholder",
      appSecret: "secret-placeholder",
      adminOpenIds: new Set(["admin-open-id"]),
      manager: {
        getStatus: async () => ({
          accounts: {
            counts: {
              total: 0,
              visible: 0,
              hidden: 0,
              active: 0,
              healthy: 0,
              authFailed: 0,
              quotaLimited: 0,
              poolEnabled: 0,
              poolEligible: 0
            },
            accounts: []
          },
          usageToday: {
            date: "2026-08-18",
            timeZone: "Asia/Shanghai",
            total: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
            eventCount: 0,
            status: "ready",
            byModel: []
          }
        })
      },
      client: { im: { v1: { message: { create: async (request) => sent.push(request) } } } },
      wsClient: { start: async () => undefined, close: () => undefined }
    });
    const event = {
      event_id: "event-1",
      message: {
        message_id: "message-1",
        chat_type: "p2p",
        chat_id: "chat-1",
        content: JSON.stringify({ text: "账号" })
      },
      sender: { sender_id: { open_id: "admin-open-id" } }
    };

    const first = await bot.processMessage(event);
    const second = await bot.processMessage(event);

    assert.equal(first.sent, true);
    assert.equal(second.duplicate, true);
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(sent[0].data.content).text.includes("Manager 账号状态"), true);
  });

  it("starts and force-closes the official SDK WebSocket wrapper", async () => {
    let started = false;
    let closed = false;
    const bot = createFeishuAssistant({
      appId: "app-placeholder",
      appSecret: "secret-placeholder",
      adminOpenIds: new Set(["admin-open-id"]),
      manager: {},
      client: { im: { v1: { message: { create: async () => undefined } } } },
      wsClient: {
        start: async () => {
          started = true;
        },
        close: () => {
          closed = true;
        }
      }
    });
    await bot.start();
    await bot.stop();
    assert.equal(started, true);
    assert.equal(closed, true);
  });

  it("uploads and sends the payment QR after the order text", async () => {
    const sent = [];
    let uploaded;
    const bot = createFeishuAssistant({
      appId: "app-placeholder",
      appSecret: "secret-placeholder",
      adminOpenIds: new Set(["admin-open-id"]),
      manager: {},
      paymentWorkflow: {
        begin: async () => ({
          created: true,
          order: {
            orderId: "order-1",
            productId: "plan-basic",
            amountFen: 990,
            currency: "CNY",
            state: "awaiting_payment",
            qr: { imageBase64: Buffer.from("fake-qr").toString("base64") }
          }
        }),
        setOnUpdate: () => undefined
      },
      client: {
        im: {
          v1: {
            message: { create: async (request) => sent.push(request) },
            image: {
              create: async (request) => {
                uploaded = request;
                return { image_key: "image-1" };
              }
            }
          }
        }
      },
      wsClient: { start: async () => undefined, close: () => undefined }
    });

    const result = await bot.processMessage({
      message: {
        message_id: "message-payment",
        chat_type: "p2p",
        chat_id: "chat-1",
        content: JSON.stringify({ text: "购买 plan-basic" })
      },
      sender: { sender_id: { open_id: "admin-open-id" } }
    });

    assert.equal(result.sent, true);
    assert.equal(result.qrSent, true);
    assert.equal(sent.length, 2);
    assert.equal(JSON.parse(sent[0].data.content).text.includes("支付订单已创建"), true);
    assert.equal(sent[1].data.msg_type, "image");
    assert.equal(JSON.parse(sent[1].data.content).image_key, "image-1");
    assert.equal(uploaded.data.image_type, "message");
  });

  it("restores payment chat targets before polling resumed orders", async () => {
    let onUpdate;
    const sent = [];
    const bot = createFeishuAssistant({
      appId: "app-placeholder",
      appSecret: "secret-placeholder",
      adminOpenIds: new Set(["admin-open-id"]),
      manager: {},
      paymentWorkflow: {
        setOnUpdate: (callback) => {
          onUpdate = callback;
        },
        listActive: async () => [{ orderId: "order-resumed", chatId: "chat-resumed", state: "awaiting_payment" }],
        start: async () => undefined,
        stop: async () => undefined
      },
      client: { im: { v1: { message: { create: async (request) => sent.push(request) } } } },
      wsClient: { start: async () => undefined, close: () => undefined }
    });

    await bot.start();
    await onUpdate({ orderId: "order-resumed", state: "fulfilled" });
    await bot.stop();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].data.receive_id, "chat-resumed");
    assert.match(JSON.parse(sent[0].data.content).text, /已完成/u);
  });
});
