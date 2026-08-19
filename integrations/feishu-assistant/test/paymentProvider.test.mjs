import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeFulfillmentResult,
  normalizePaymentCreation,
  normalizePaymentStatus,
  PaymentProviderError
} from "../src/paymentProvider.mjs";

describe("payment provider boundary", () => {
  it("normalizes an order while accepting only HTTPS image URLs", () => {
    assert.deepEqual(
      normalizePaymentCreation({ id: "order-1", product: "plan-basic", amount_fen: 990, qr: { imageKey: "img-key" } }),
      {
        orderId: "order-1",
        productId: "plan-basic",
        amountFen: 990,
        currency: "CNY",
        qr: { imageKey: "img-key", imageUrl: undefined, imageBase64: undefined, content: undefined },
        expiresAt: undefined,
        createdAt: undefined
      }
    );
    assert.equal(normalizePaymentStatus({ status: "success", reference: "payment-1" }).state, "paid");
  });

  it("rejects incomplete orders, insecure QR URLs, and missing fulfillment results", () => {
    assert.throws(
      () => normalizePaymentCreation({ id: "order-1", product: "plan-basic", amount_fen: 990 }),
      (error) => error instanceof PaymentProviderError && error.code === "payment_order_invalid"
    );
    assert.throws(
      () =>
        normalizePaymentCreation({
          id: "order-1",
          product: "plan-basic",
          amount_fen: 990,
          qr: { imageUrl: "http://example.invalid/qr" }
        }),
      (error) => error instanceof PaymentProviderError && error.code === "payment_qr_invalid"
    );
    assert.throws(
      () => normalizeFulfillmentResult(undefined),
      (error) => error instanceof PaymentProviderError && error.code === "payment_fulfillment_invalid"
    );
    assert.throws(
      () => normalizeFulfillmentResult({}),
      (error) => error instanceof PaymentProviderError && error.code === "payment_fulfillment_invalid"
    );
  });
});
