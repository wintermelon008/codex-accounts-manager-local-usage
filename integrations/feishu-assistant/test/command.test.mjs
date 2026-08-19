import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAssistantCommand } from "../src/command.mjs";

describe("Feishu assistant commands", () => {
  it("parses read and refresh commands", () => {
    assert.deepEqual(parseAssistantCommand("账号"), { action: "status" });
    assert.deepEqual(parseAssistantCommand("刷新额度 account-1, account-2"), {
      action: "refresh",
      accountIds: ["account-1", "account-2"]
    });
    assert.deepEqual(parseAssistantCommand("导入状态 123e4567-e89b-12d3-a456-426614174000"), {
      action: "import-status",
      jobId: "123e4567-e89b-12d3-a456-426614174000"
    });
    assert.deepEqual(parseAssistantCommand("购买 plan-basic"), { action: "buy", productId: "plan-basic" });
    assert.deepEqual(parseAssistantCommand("支付状态 order-1"), { action: "payment-status", orderId: "order-1" });
    assert.deepEqual(parseAssistantCommand("分析商品 https://shop.example/products free 已接码 有库存 最低价"), {
      action: "analyze-web",
      url: "https://shop.example/products",
      criteriaText: "free 已接码 有库存 最低价"
    });
    assert.deepEqual(parseAssistantCommand("网页流程 https://shop.example/products"), {
      action: "web-workflow",
      url: "https://shop.example/products"
    });
  });

  it("rejects malformed job ids and empty refresh targets", () => {
    assert.deepEqual(parseAssistantCommand("导入状态 nope"), {
      action: "invalid",
      message: "导入状态后需要一个有效的任务编号。"
    });
    assert.deepEqual(parseAssistantCommand("刷新额度"), { action: "refresh", accountIds: undefined });
    assert.deepEqual(parseAssistantCommand("购买"), { action: "invalid", message: "购买后需要商品编号。" });
  });
});
