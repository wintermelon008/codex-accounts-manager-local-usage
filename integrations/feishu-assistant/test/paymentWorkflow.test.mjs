import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createPaymentStore } from "../src/paymentStore.mjs";
import { createPaymentWorkflow } from "../src/paymentWorkflow.mjs";

describe("payment workflow", () => {
  it("does not fulfill before payment and fulfills after a paid status", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-payment-workflow-"));
    try {
      let remoteState = "pending";
      let fulfillmentCalls = 0;
      const workflow = createPaymentWorkflow({
        store: createPaymentStore({ statePath: path.join(temporaryDirectory, "payments.json") }),
        provider: {
          createOrder: async () => ({
            orderId: "order-1",
            productId: "plan-basic",
            amountFen: 990,
            qr: { content: "pay" }
          }),
          getOrderStatus: async () => ({ status: remoteState }),
          fulfillPaidOrder: async () => {
            fulfillmentCalls += 1;
            return { state: "completed", managerImportJobId: "import-1" };
          }
        }
      });

      const created = await workflow.begin({ requesterId: "admin-1", chatId: "chat-1", productId: "plan-basic" });
      assert.equal(created.order.state, "awaiting_payment");
      assert.equal(fulfillmentCalls, 0);
      assert.equal((await workflow.sync(created.order.orderId)).state, "awaiting_payment");
      assert.equal(fulfillmentCalls, 0);

      remoteState = "paid";
      const fulfilled = await workflow.sync(created.order.orderId);
      assert.equal(fulfilled.state, "fulfilled");
      assert.equal(fulfilled.managerImportJobId, "import-1");
      assert.equal(fulfillmentCalls, 1);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("retries a pending paid follow-up without checking payment back to pending", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-payment-retry-"));
    try {
      let fulfillmentCalls = 0;
      let managerImportCalls = 0;
      let importCompleted = false;
      const manager = {
        enqueueImport: async () => {
          managerImportCalls += 1;
          return { id: "import-2", accountCount: 1 };
        },
        getImportStatus: async () => ({ state: importCompleted ? "completed" : "processing" })
      };
      const workflow = createPaymentWorkflow({
        store: createPaymentStore({ statePath: path.join(temporaryDirectory, "payments.json") }),
        provider: {
          createOrder: async () => ({
            orderId: "order-2",
            productId: "plan-basic",
            amountFen: 990,
            qr: { content: "pay" }
          }),
          getOrderStatus: async () => ({ status: "paid" }),
          fulfillPaidOrder: async ({ previousResult }) => {
            fulfillmentCalls += 1;
            if (!previousResult) {
              const queued = await manager.enqueueImport([]);
              return { state: "pending", managerImportJobId: queued.id, message: "import queued" };
            }
            const status = await manager.getImportStatus(previousResult.managerImportJobId);
            return status.state === "completed"
              ? { state: "completed", managerImportJobId: previousResult.managerImportJobId }
              : { state: "pending", managerImportJobId: previousResult.managerImportJobId };
          }
        }
      });
      const created = await workflow.begin({ requesterId: "admin-2", chatId: "chat-2", productId: "plan-basic" });
      assert.equal(managerImportCalls, 0);
      assert.equal((await workflow.sync(created.order.orderId)).state, "fulfillment_pending");
      assert.equal(managerImportCalls, 1);
      importCompleted = true;
      assert.equal((await workflow.sync(created.order.orderId)).state, "fulfilled");
      assert.equal(fulfillmentCalls, 2);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent orders from one requester", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-payment-dedupe-"));
    try {
      let createCalls = 0;
      const workflow = createPaymentWorkflow({
        store: createPaymentStore({ statePath: path.join(temporaryDirectory, "payments.json") }),
        provider: {
          createOrder: async () => {
            createCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { orderId: "order-3", productId: "plan-basic", amountFen: 990, qr: { content: "pay" } };
          },
          getOrderStatus: async () => ({ status: "pending" }),
          fulfillPaidOrder: async () => ({ state: "completed" })
        }
      });

      const results = await Promise.all([
        workflow.begin({ requesterId: "admin-3", chatId: "chat-3", productId: "plan-basic" }),
        workflow.begin({ requesterId: "admin-3", chatId: "chat-3", productId: "plan-basic" })
      ]);
      assert.equal(createCalls, 1);
      assert.equal(results[0].order.orderId, "order-3");
      assert.equal(results[1].order.orderId, "order-3");
      assert.equal((await workflow.listActive()).length, 1);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
