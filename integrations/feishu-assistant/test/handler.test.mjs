import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleAssistantEvent, PRIVATE_CHAT_ONLY_MESSAGE, UNAUTHORIZED_MESSAGE } from "../src/handler.mjs";

const adminOpenIds = new Set(["admin-open-id"]);

describe("Feishu assistant handler", () => {
  it("rejects groups and unauthorized senders before calling Manager", async () => {
    const manager = throwingManager();
    const groupResult = await handleAssistantEvent(event("group", "admin-open-id", "账号"), {
      adminOpenIds,
      manager
    });
    const unauthorizedResult = await handleAssistantEvent(event("p2p", "not-admin", "账号"), {
      adminOpenIds,
      manager
    });
    assert.deepEqual(groupResult, { handled: true, reply: PRIVATE_CHAT_ONLY_MESSAGE });
    assert.deepEqual(unauthorizedResult, { handled: true, reply: UNAUTHORIZED_MESSAGE });
  });

  it("queries status and keeps the response free of credential fields", async () => {
    const result = await handleAssistantEvent(event("p2p", "admin-open-id", "账号"), {
      adminOpenIds,
      manager: {
        getStatus: async () => ({
          accounts: {
            counts: {
              total: 1,
              visible: 1,
              hidden: 0,
              active: 1,
              healthy: 1,
              authFailed: 0,
              quotaLimited: 0,
              poolEnabled: 1,
              poolEligible: 1
            },
            accounts: [
              {
                id: "account-1",
                email: "person@example.invalid",
                displayName: "Person",
                health: "healthy",
                balancePoolEnabled: true,
                poolEligible: true,
                quota: {}
              }
            ]
          },
          usageToday: {
            date: "2026-08-18",
            timeZone: "Asia/Shanghai",
            total: {
              totalTokens: 42,
              inputTokens: 10,
              cachedInputTokens: 2,
              outputTokens: 20,
              reasoningOutputTokens: 10
            },
            eventCount: 1,
            status: "ready",
            byModel: []
          }
        })
      }
    });
    assert.equal(result.handled, true);
    assert.match(result.reply, /Person/u);
    assert.doesNotMatch(result.reply, /access_token|refresh_token|id_token|secret/u);
  });

  it("returns a refresh job for asynchronous follow-up", async () => {
    const result = await handleAssistantEvent(event("p2p", "admin-open-id", "刷新额度 account-1"), {
      adminOpenIds,
      manager: { refreshQuotas: async (accountIds) => ({ id: "job-1", state: "queued", accountIds }) }
    });
    assert.equal(result.handled, true);
    assert.equal(result.followUpJobId, "job-1");
    assert.match(result.reply, /account-1/u);
  });

  it("creates a payment order and exposes only a QR delivery request", async () => {
    const result = await handleAssistantEvent(event("p2p", "admin-open-id", "购买 plan-basic"), {
      adminOpenIds,
      manager: {},
      paymentWorkflow: {
        begin: async (input) => ({
          created: true,
          input,
          order: {
            orderId: "order-1",
            productId: "plan-basic",
            amountFen: 990,
            currency: "CNY",
            state: "awaiting_payment",
            qr: { imageKey: "image-1" }
          }
        })
      }
    });
    assert.equal(result.paymentOrder.orderId, "order-1");
    assert.deepEqual(result.paymentQr, { imageKey: "image-1" });
    assert.match(result.reply, /只有确认支付成功后/u);
    assert.doesNotMatch(result.reply, /access_token|refresh_token|id_token/u);
  });

  it("analyzes and formats a saved web workflow without executing it", async () => {
    let analyzed;
    const result = await handleAssistantEvent(
      event("p2p", "admin-open-id", "分析商品 https://shop.example/products free 已接码 有库存"),
      {
        adminOpenIds,
        manager: {},
        webWorkflow: {
          analyze: async (input) => {
            analyzed = input;
            return {
              url: input.url,
              title: "Example shop",
              siteStatus: "available",
              criteria: { plan: "free", phoneVerified: true, inStock: true, sort: "price_asc" },
              selected: {
                id: "free-1",
                name: "Free account",
                priceFen: 350,
                currency: "CNY",
                inStock: true,
                phoneVerified: true,
                features: []
              },
              candidates: [],
              instructions: [{ order: 1, action: "submit", target: "pay", requiresConfirmation: true, value: null }],
              warnings: [],
              remembered: true
            };
          }
        }
      }
    );
    assert.equal(analyzed.remember, true);
    assert.match(result.reply, /最低价候选/u);
    assert.match(result.reply, /CNY 3\.50/u);
    assert.match(result.reply, /需确认/u);
  });

  it("does not expose web workflow commands when the feature is not configured", async () => {
    const result = await handleAssistantEvent(event("p2p", "admin-open-id", "网页流程 https://shop.example/products"), {
      adminOpenIds,
      manager: {}
    });
    assert.match(result.reply, /网页分析流程尚未配置/u);
  });
});

function event(chatType, openId, text) {
  return {
    message: { chat_type: chatType, chat_id: "chat-id", content: JSON.stringify({ text }) },
    sender: { sender_id: { open_id: openId } }
  };
}

function throwingManager() {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("Manager should not be called");
      }
    }
  );
}
