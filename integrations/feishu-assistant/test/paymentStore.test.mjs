import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createPaymentStore, PAYMENT_STATE_SCHEMA } from "../src/paymentStore.mjs";

describe("payment state store", () => {
  it("persists private order state and reloads the schema", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-payment-store-"));
    try {
      const statePath = path.join(temporaryDirectory, "nested", "payments.json");
      const record = {
        schema: PAYMENT_STATE_SCHEMA,
        requesterId: "admin-open-id",
        chatId: "chat-1",
        creationKey: "feishu-payment-test",
        orderId: "order-1",
        state: "awaiting_payment",
        fulfillmentState: "not_started",
        qr: { content: "pay-content" }
      };
      const store = createPaymentStore({ statePath });
      await store.put(record);

      assert.deepEqual(await store.get("order-1"), record);
      assert.deepEqual(await createPaymentStore({ statePath }).list(), [record]);
      const directoryMode = (await fs.stat(path.dirname(statePath))).mode & 0o777;
      const fileMode = (await fs.stat(statePath)).mode & 0o777;
      assert.equal(directoryMode, 0o700);
      assert.equal(fileMode, 0o600);
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
