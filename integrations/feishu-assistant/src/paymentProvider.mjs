export const PAYMENT_REMOTE_STATES = Object.freeze({
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
  EXPIRED: "expired",
  UNKNOWN: "unknown"
});

export class PaymentProviderError extends Error {
  constructor(message, code = "payment_provider_error") {
    super(message);
    this.name = "PaymentProviderError";
    this.code = code;
  }
}

export function assertPaymentProvider(provider) {
  if (
    !provider ||
    typeof provider.createOrder !== "function" ||
    typeof provider.getOrderStatus !== "function" ||
    typeof provider.fulfillPaidOrder !== "function"
  ) {
    throw new PaymentProviderError(
      "支付适配器必须实现 createOrder、getOrderStatus 和 fulfillPaidOrder。",
      "payment_provider_contract"
    );
  }
}

export function normalizePaymentCreation(value) {
  const record = asRecord(value?.order) ? value.order : value;
  const orderId = nonempty(record?.orderId ?? record?.order_id ?? record?.id);
  const productId = nonempty(record?.productId ?? record?.product_id ?? record?.product);
  const amountFen = nonNegativeInteger(
    record?.amountFen ?? record?.amount_fen ?? record?.totalFen ?? record?.total_fen
  );
  const currency = nonempty(record?.currency)?.toUpperCase() ?? "CNY";
  const qr = normalizeQr(record?.qr ?? record);
  if (!orderId || !productId || amountFen === undefined || !qr) {
    throw new PaymentProviderError("支付适配器返回的订单缺少订单号、商品、金额或二维码。", "payment_order_invalid");
  }
  return {
    orderId,
    productId,
    amountFen,
    currency,
    qr,
    expiresAt: optionalString(record?.expiresAt ?? record?.expires_at),
    createdAt: optionalString(record?.createdAt ?? record?.created_at)
  };
}

export function normalizePaymentStatus(value) {
  const record = asRecord(value?.order) ? value.order : value;
  const rawState = String(record?.state ?? record?.status ?? "")
    .trim()
    .toLocaleLowerCase();
  const state = mapRemoteState(rawState);
  return {
    state,
    paidAt: optionalString(record?.paidAt ?? record?.paid_at ?? record?.completedAt ?? record?.completed_at),
    reference: optionalString(record?.reference ?? record?.paymentReference ?? record?.payment_reference),
    message: safeMessage(record?.message)
  };
}

export function normalizeFulfillmentResult(value) {
  if (!asRecord(value)) {
    throw new PaymentProviderError("支付后续流程没有返回结果。", "payment_fulfillment_invalid");
  }
  const record = value;
  const rawState = nonempty(record.state ?? record.status)?.toLocaleLowerCase();
  if (!rawState) {
    throw new PaymentProviderError("支付后续流程没有返回明确状态。", "payment_fulfillment_invalid");
  }
  const state =
    rawState === "pending" || rawState === "processing"
      ? "pending"
      : ["completed", "complete", "success", "succeeded"].includes(rawState)
        ? "completed"
        : rawState === "failed"
          ? "failed"
          : undefined;
  if (!state) {
    throw new PaymentProviderError("支付后续流程返回了未知状态。", "payment_fulfillment_invalid");
  }
  return {
    state,
    managerImportJobId: optionalString(record.managerImportJobId ?? record.manager_import_job_id ?? record.importJobId),
    imported: nonNegativeInteger(record.imported),
    poolEnabled: nonNegativeInteger(record.poolEnabled ?? record.pool_enabled),
    message: safeMessage(record.message)
  };
}

export function normalizeQr(value) {
  const record = asRecord(value) ? value : {};
  const imageKey = optionalString(record.imageKey ?? record.image_key);
  const imageUrl = optionalString(record.imageUrl ?? record.image_url);
  const imageBase64 = optionalString(record.imageBase64 ?? record.image_base64);
  const content = optionalString(record.content ?? record.qrContent ?? record.qr_content);
  if (!imageKey && !imageUrl && !imageBase64 && !content) {
    return undefined;
  }
  if (imageUrl) {
    try {
      const url = new URL(imageUrl);
      if (url.protocol !== "https:") {
        throw new Error("unsupported QR URL");
      }
    } catch {
      throw new PaymentProviderError("支付适配器返回的二维码图片地址不是 HTTPS URL。", "payment_qr_invalid");
    }
  }
  if (imageBase64 && imageBase64.length > 4 * 1024 * 1024) {
    throw new PaymentProviderError("支付二维码图片过大。", "payment_qr_too_large");
  }
  return { imageKey, imageUrl, imageBase64, content };
}

function mapRemoteState(value) {
  if (["paid", "success", "succeeded", "completed", "complete"].includes(value)) {
    return PAYMENT_REMOTE_STATES.PAID;
  }
  if (["failed", "cancelled", "canceled", "refunded", "rejected"].includes(value)) {
    return PAYMENT_REMOTE_STATES.FAILED;
  }
  if (["expired", "timeout", "timed_out"].includes(value)) {
    return PAYMENT_REMOTE_STATES.EXPIRED;
  }
  if (["pending", "created", "unpaid", "processing", "awaiting_payment", "waiting"].includes(value)) {
    return PAYMENT_REMOTE_STATES.PENDING;
  }
  return PAYMENT_REMOTE_STATES.UNKNOWN;
}

function asRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(value) {
  return nonempty(value);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function safeMessage(value) {
  const message = nonempty(value);
  return message && message.length <= 240 ? message : undefined;
}
