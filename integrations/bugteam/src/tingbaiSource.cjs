"use strict";

const crypto = require("node:crypto");
const { TingbaiApiError, TingbaiClient } = require("./api/tingbaiClient.cjs");

const DEFAULT_TINGBAI_POLL_INTERVAL_MS = 3_000;
const TINGBAI_POLL_JITTER_MS = 1_000;
const IMPORT_RETRY_DELAY_MS = 30_000;
const MAX_RECORDS = 20;
const USERNAME_PATTERN = /^[A-Za-z0-9_.@-]{4,64}$/u;

class TingbaiSource {
  constructor({ storage, importBundle, onDidChange, clientFactory, pollIntervalMs = DEFAULT_TINGBAI_POLL_INTERVAL_MS }) {
    this.storage = storage;
    this.importBundle = importBundle;
    this.onDidChange = onDidChange;
    this.clientFactory = clientFactory ?? (() => new TingbaiClient());
    this.pollIntervalMs = pollIntervalMs;
    this.client = this.clientFactory();
    this.credentials = undefined;
    this.data = { records: [] };
    this.remote = { product: undefined, balance: undefined, checkedAt: undefined };
    this.lastError = undefined;
    this.pollTimer = undefined;
    this.nextPollAt = undefined;
    this.cycleInFlight = false;
    this.purchaseInFlight = false;
    this.importInFlightOrders = new Set();
    this.lastImportAttemptAtByOrderId = new Map();
    this.disposed = false;
  }

  async initialize() {
    this.credentials = await this.storage.getTingbaiCredentials();
    this.data = normalizePersistedState(await this.storage.getTingbaiState());
    this.lastError = this.data.order?.lastImportError ?? this.data.attempt?.lastError;
    this.syncPolling();
    if (this.shouldContinuePolling()) void this.runCycle();
  }

  getViewModel() {
    return {
      credentialsConfigured: Boolean(this.credentials),
      username: this.credentials?.username,
      product: this.remote.product,
      balance: this.remote.balance,
      checkedAt: this.remote.checkedAt,
      checking: this.cycleInFlight,
      nextPollAt: this.nextPollAt,
      waitlist: publicWaitlist(this.data.waitlist),
      attemptPending: Boolean(this.data.attempt),
      order: publicOrder(this.data.order),
      records: this.data.records.map(publicRecord),
      lastError: this.lastError
    };
  }

  async setCredentials(usernameValue, passwordValue) {
    const username = readString(usernameValue) ?? "";
    const password = typeof passwordValue === "string" ? passwordValue : "";
    if (!USERNAME_PATTERN.test(username) || password.length < 8 || password.length > 128) {
      throw new Error("请输入有效的买家账号和密码（密码 8-128 位）");
    }
    const candidate = this.clientFactory();
    const payload = await candidate.login(username, password);
    this.client = candidate;
    this.credentials = { username, password };
    this.remote.balance = normalizeBuyer(payload);
    await this.storage.setTingbaiCredentials(username, password);
    this.lastError = this.data.order?.lastImportError ?? this.data.attempt?.lastError;
    await this.refreshCatalog();
    this.notify();
  }

  async clearCredentials() {
    if (this.shouldContinuePolling()) {
      throw new Error("请先停止候补并完成当前订单导入，再清除买家凭据");
    }
    await this.storage.deleteTingbaiCredentials();
    this.credentials = undefined;
    this.client = this.clientFactory();
    this.remote.balance = undefined;
    this.lastError = undefined;
    this.notify();
  }

  async refresh() {
    this.lastError = undefined;
    await this.refreshCatalog();
    if (this.credentials) await this.refreshWallet();
    if (this.data.order && !this.data.order.imported && !isFailedOrder(this.data.order)) {
      await this.pollOrder({ forceImport: false, awaitImport: false });
    }
    if (this.data.attempt) {
      await this.submitAttempt();
    }
    if (this.data.waitlist?.active && !isBlockingWaitlistOrder(this.data.order)) {
      await this.considerPurchase();
    }
    this.syncPolling();
    this.notify();
  }

  async startWaitlist(options = {}) {
    if (!this.credentials) throw new Error("请先保存并验证超级炸弹车买家账号");
    if (this.data.attempt || isBlockingWaitlistOrder(this.data.order)) {
      throw new Error("已有自动购买或导入任务正在处理");
    }
    const minTotalFen = readWaitlistBound(options.minTotalFen, "候补金额下限");
    const maxTotalFen = readWaitlistBound(options.maxTotalFen, "候补金额上限");
    if (minTotalFen !== undefined && maxTotalFen !== undefined && minTotalFen > maxTotalFen) {
      throw new Error("候补金额下限不能大于上限");
    }
    const product = this.remote.product;
    this.data.waitlist = {
      active: true,
      productCode: product?.code,
      productName: product?.name,
      quantity: 1,
      minTotalFen,
      maxTotalFen,
      startedAt: new Date().toISOString()
    };
    this.lastError = undefined;
    await this.persist();
    this.syncPolling();
    this.notify();
    if (this.data.order && !this.data.order.imported && isCompletedOrder(this.data.order)) {
      void this.processCompletedOrder(false, this.data.order).catch(() => {});
    }
    try {
      await this.refreshCatalog();
      await this.refreshWallet();
    } catch (error) {
      this.lastError = safeError(error, "超级炸弹车候补初始化失败", this.credentials?.password);
      await this.persist();
    }
    await this.considerPurchase();
    this.syncPolling();
    this.notify();
  }

  async stopWaitlist() {
    if (this.data.attempt) throw new Error("订单请求结果待确认，不能停止候补");
    if (this.data.waitlist) this.data.waitlist.active = false;
    await this.persist();
    this.syncPolling();
    this.notify();
  }

  async retryImport() {
    const orderId = this.data.order?.orderId;
    if (orderId) this.lastImportAttemptAtByOrderId.delete(orderId);
    await this.processCompletedOrder(true);
    this.syncPolling();
    this.notify();
  }

  recordError(error) {
    this.lastError = safeError(error, "超级炸弹车操作失败", this.credentials?.password);
    this.notify();
    return this.lastError;
  }

  async runCycle() {
    if (this.cycleInFlight || this.disposed) return;
    this.cycleInFlight = true;
    this.lastError = undefined;
    this.notify();
    try {
      if (this.data.order && !this.data.order.imported && !isFailedOrder(this.data.order) && !isCompletedOrder(this.data.order)) {
        await this.pollOrder({ forceImport: false, awaitImport: false });
      }
      if (this.data.attempt) {
        await this.submitAttempt();
      }
      if (this.data.order && !this.data.order.imported && isCompletedOrder(this.data.order)) {
        await this.pollOrder({ forceImport: false, awaitImport: false });
      }
      if (this.data.waitlist?.active && !isBlockingWaitlistOrder(this.data.order)) {
        await this.refreshCatalog();
        await this.considerPurchase();
      }
    } catch (error) {
      this.lastError = safeError(error, "超级炸弹车候补同步失败", this.credentials?.password);
    } finally {
      this.cycleInFlight = false;
      this.syncPolling();
      this.notify();
    }
  }

  async refreshCatalog() {
    const payload = await this.client.getCatalog();
    const products = normalizeCatalog(payload);
    const selectedCode = this.data.attempt?.product ?? this.data.waitlist?.productCode;
    const availableProduct = !this.data.attempt
      ? products.find((product) => product.purchasable)
      : undefined;
    this.remote.product = availableProduct
      ?? products.find((product) => product.code === selectedCode)
      ?? products[0];
    this.remote.checkedAt = new Date().toISOString();
    return this.remote.product;
  }

  async refreshWallet() {
    const payload = await this.withSession(() => this.client.getWallet());
    this.remote.balance = normalizeBuyer(payload);
    return this.remote.balance;
  }

  async considerPurchase() {
    const waitlist = this.data.waitlist;
    const product = this.remote.product;
    if (!waitlist?.active || !product) return;
    if (isBlockingWaitlistOrder(this.data.order)) return;
    if (!product.purchasable || this.purchaseInFlight) return;

    this.purchaseInFlight = true;
    try {
      await this.refreshWallet();
      const quotePayload = await this.client.getQuote(product.code, waitlist.quantity);
      const quote = normalizeQuote(quotePayload, product, waitlist.quantity);
      if (!quote.canBuy) return;
      if (!quote.totalFen) return;
      const minTotalFen = nonNegativeIntegerOrUndefined(waitlist.minTotalFen);
      const maxTotalFen = nonNegativeIntegerOrUndefined(waitlist.maxTotalFen);
      if (minTotalFen !== undefined && quote.totalFen < minTotalFen) return;
      if (maxTotalFen !== undefined && quote.totalFen > maxTotalFen) return;
      if (!this.remote.balance || this.remote.balance.balanceFen < quote.totalFen) {
        waitlist.active = false;
        this.lastError = "买家余额不足，候补已暂停";
        await this.persist();
        return;
      }
      waitlist.productCode = product.code;
      waitlist.productName = product.name;
      this.data.attempt = {
        idempotencyKey: createIdempotencyKey(),
        product: product.code,
        productName: product.name,
        quantity: waitlist.quantity,
        expectedUnitPriceFen: quote.unitFen,
        expectedTotalFen: quote.totalFen,
        quoteId: quote.quoteId,
        detectedAt: new Date().toISOString(),
        estimatedExplosionAt: product.estimatedExplosionAt
      };
      await this.persist();
      await this.submitAttempt();
    } finally {
      this.purchaseInFlight = false;
    }
  }

  async submitAttempt() {
    const attempt = this.data.attempt;
    if (!attempt) return;
    try {
      const response = await this.withSession(() => this.client.createOrder({
        product: attempt.product,
        quantity: attempt.quantity,
        expectedUnitPriceFen: attempt.expectedUnitPriceFen,
        expectedTotalFen: attempt.expectedTotalFen,
        quoteId: attempt.quoteId,
        idempotencyKey: attempt.idempotencyKey
      }));
      const normalized = normalizeOrder(response);
      if (!normalized.orderId) throw new Error("订单服务未返回订单号");
      this.data.order = {
        ...normalized,
        product: attempt.product,
        productName: attempt.productName,
        quantity: attempt.quantity,
        amountFen: normalized.amountFen || attempt.expectedTotalFen,
        detectedAt: attempt.detectedAt,
        estimatedExplosionAt: attempt.estimatedExplosionAt,
        imported: false
      };
      this.data.attempt = undefined;
      if (this.data.waitlist) this.data.waitlist.active = false;
      this.upsertRecord(this.data.order);
      await this.persist();
      await this.pollOrder({ forceImport: true, awaitImport: false });
    } catch (error) {
      if (isStockUnavailable(error) || isQuoteChanged(error)) {
        this.data.attempt = undefined;
        await this.persist();
        return;
      }
      if (isBalanceInsufficient(error)) {
        this.data.attempt = undefined;
        if (this.data.waitlist) this.data.waitlist.active = false;
        await this.persist();
      } else {
        attempt.lastError = safeError(error, "订单请求结果待确认", this.credentials?.password);
        await this.persist();
      }
      throw error;
    }
  }

  async pollOrder({ forceImport = false, awaitImport = false } = {}) {
    if (!this.data.order?.orderId) return;
    const response = await this.withSession(() => this.client.getOrder(this.data.order.orderId));
    const normalized = normalizeOrder(response);
    this.data.order = { ...this.data.order, ...normalized, orderId: this.data.order.orderId };
    this.upsertRecord(this.data.order);
    await this.persist();
    if (isCompletedOrder(this.data.order) && !this.data.order.imported) {
      const importTask = this.processCompletedOrder(forceImport, this.data.order);
      if (awaitImport) await importTask;
      else void importTask.catch(() => {});
    }
  }

  async processCompletedOrder(force = false, sourceOrder = this.data.order) {
    const order = sourceOrder;
    const orderId = order?.orderId;
    const retryingPoolFailure = force && order?.imported && Boolean(order.lastImportError);
    if (!orderId || !isCompletedOrder(order) || (order.imported && !retryingPoolFailure) || this.importInFlightOrders.has(orderId)) return;
    const lastAttemptAt = this.lastImportAttemptAtByOrderId.get(orderId) ?? 0;
    if (!force && Date.now() - lastAttemptAt < IMPORT_RETRY_DELAY_MS) return;
    this.importInFlightOrders.add(orderId);
    this.lastImportAttemptAtByOrderId.set(orderId, Date.now());
    try {
      const bundle = await this.withSession(() => this.client.downloadSub2(order.orderId));
      const summary = await this.importBundle(bundle);
      order.importResult = summary;
      order.imported = summary.imported === summary.total;
      order.lastImportError = importResultError(summary);
      this.lastError = order.lastImportError;
      this.upsertRecord(order);
      await this.persist();
      this.lastImportAttemptAtByOrderId.delete(orderId);
    } catch (error) {
      order.lastImportError = safeError(error, "超级炸弹车账号导入失败", this.credentials?.password);
      this.lastError = order.lastImportError;
      this.upsertRecord(order);
      await this.persist();
      throw error;
    } finally {
      this.importInFlightOrders.delete(orderId);
      this.syncPolling();
      this.notify();
    }
  }

  async withSession(action) {
    await this.ensureSession();
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof TingbaiApiError) || error.status !== 401) throw error;
      this.client.clearSession?.();
      await this.ensureSession();
      return action();
    }
  }

  async ensureSession() {
    if (this.client.authenticated) return;
    if (!this.credentials) throw new Error("超级炸弹车买家凭据未配置");
    const payload = await this.client.login(this.credentials.username, this.credentials.password);
    this.remote.balance = normalizeBuyer(payload);
  }

  upsertRecord(order) {
    const record = publicRecord(order);
    if (!record?.orderId) return;
    this.data.records = [record, ...this.data.records.filter((item) => item.orderId !== record.orderId)]
      .slice(0, MAX_RECORDS);
  }

  shouldContinuePolling() {
    return Boolean(
      this.data.waitlist?.active ||
      this.data.attempt ||
      (this.data.order?.orderId && !this.data.order.imported && !isFailedOrder(this.data.order))
    );
  }

  syncPolling() {
    if (this.shouldContinuePolling() && !this.pollTimer && !this.disposed) {
      const delayMs = calculatePollDelayMs(this.pollIntervalMs);
      this.nextPollAt = Date.now() + delayMs;
      this.pollTimer = setTimeout(() => {
        this.pollTimer = undefined;
        this.nextPollAt = undefined;
        void this.runCycle().finally(() => this.syncPolling());
      }, delayMs);
      this.pollTimer.unref?.();
    } else if (!this.shouldContinuePolling() && this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
      this.nextPollAt = undefined;
    } else if (!this.shouldContinuePolling()) {
      this.nextPollAt = undefined;
    }
  }

  async persist() {
    await this.storage.updateTingbaiState({
      waitlist: this.data.waitlist,
      attempt: this.data.attempt,
      order: publicOrder(this.data.order, true),
      records: this.data.records.map(publicRecord)
    });
  }

  notify() {
    if (!this.disposed) this.onDidChange?.();
  }

  dispose() {
    this.disposed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.nextPollAt = undefined;
  }
}

function calculatePollDelayMs(intervalMs, randomValue = Math.random()) {
  return intervalMs + Math.floor(randomValue * TINGBAI_POLL_JITTER_MS);
}

function normalizeCatalog(payload) {
  const products = Array.isArray(payload?.products) ? payload.products : [];
  return products.map((product) => {
    const supply = product?.supply && typeof product.supply === "object" ? product.supply : {};
    const refreshedAt = readString(supply.refreshed_at);
    const minimumRemainingSeconds = nonNegativeIntegerOrUndefined(supply.minimum_remaining_seconds);
    const availableValue = product?.available ?? product?.stock ?? product?.stock_count ?? product?.available_quantity ?? product?.quantity;
    const available = nonNegativeInteger(availableValue);
    const availableKnown = availableValue !== undefined && availableValue !== null && availableValue !== "" && Number.isFinite(Number(availableValue));
    const explicitPurchasable = readBoolean(product?.purchasable ?? product?.can_buy ?? product?.canBuy ?? product?.available_for_sale);
    const explicitInStock = readBoolean(product?.in_stock ?? product?.inStock);
    const status = readString(product?.status)?.toLowerCase();
    const unavailableState = ["disabled", "offline", "inactive", "sold_out", "unavailable"].includes(status);
    const purchasable = explicitPurchasable
      ?? (explicitInStock === false
        ? false
        : !unavailableState && (!availableKnown || available > 0));
    return {
      code: readString(product?.code),
      name: readString(product?.name) ?? readString(product?.code) ?? "商品",
      description: readString(product?.description),
      priceFen: nonNegativeInteger(product?.unit_price_fen ?? product?.price_fen),
      currency: readString(product?.currency) ?? "CNY",
      available,
      availableKnown,
      purchasable,
      refreshedAt,
      minimumRemainingSeconds,
      maximumRemainingSeconds: nonNegativeIntegerOrUndefined(supply.maximum_remaining_seconds),
      departureAt: readString(supply.departure_time),
      estimatedExplosionAt: calculateEstimatedExplosionAt(refreshedAt, minimumRemainingSeconds)
    };
  }).filter((product) => product.code);
}

function normalizeQuote(payload, product, quantity) {
  const quote = payload?.quote && typeof payload.quote === "object" ? payload.quote : payload;
  const unitFen = nonNegativeInteger(quote?.estimated_unit_price_fen ?? quote?.unit_price_fen ?? product.priceFen);
  const totalFen = nonNegativeInteger(quote?.estimated_total_fen ?? quote?.total_fen ?? quote?.amount_fen ?? unitFen * quantity);
  const availableValue = quote?.available ?? quote?.available_quantity ?? quote?.deliverable_quantity ?? quote?.deliverable;
  const available = nonNegativeIntegerOrUndefined(availableValue);
  const needsProduction = quote?.needs_production === true || quote?.needsProduction === true || quote?.backorder === true;
  const explicitCanBuy = readBoolean(quote?.can_buy ?? quote?.canBuy ?? quote?.purchasable ?? quote?.available_for_sale);
  return {
    unitFen,
    totalFen,
    available,
    canBuy: explicitCanBuy ?? (available === undefined ? !needsProduction : available >= quantity),
    quoteId: readString(quote?.quote_id ?? quote?.id)
  };
}

function normalizeBuyer(payload) {
  const buyer = payload?.buyer && typeof payload.buyer === "object" ? payload.buyer : {};
  return {
    username: readString(buyer.username),
    balanceFen: nonNegativeInteger(buyer.balance_fen),
    currency: readString(buyer.currency) ?? "CNY"
  };
}

function normalizeOrder(payload) {
  const root = payload?.order && typeof payload.order === "object"
    ? payload.order
    : payload?.data?.order && typeof payload.data.order === "object"
      ? payload.data.order
      : payload?.data && typeof payload.data === "object"
        ? payload.data
        : payload;
  const funding = root?.funding && typeof root.funding === "object" ? root.funding : {};
  return {
    orderId: readString(root?.order_id ?? root?.id),
    state: readString(root?.state ?? root?.status),
    amountFen: nonNegativeInteger(root?.charged_fen ?? root?.total_fen ?? root?.amount_fen ?? funding.debited_fen),
    createdAt: readString(root?.created_at),
    completedAt: readString(root?.delivered_at ?? root?.completed_at),
    updatedAt: readString(root?.updated_at) ?? new Date().toISOString()
  };
}

function calculateEstimatedExplosionAt(refreshedAt, minimumRemainingSeconds) {
  const refreshed = Date.parse(refreshedAt ?? "");
  if (!Number.isFinite(refreshed) || !Number.isFinite(minimumRemainingSeconds)) return undefined;
  return new Date(refreshed + minimumRemainingSeconds * 1000).toISOString();
}

function normalizePersistedState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    waitlist: state.waitlist && typeof state.waitlist === "object" ? { ...state.waitlist } : undefined,
    attempt: state.attempt && typeof state.attempt === "object" ? { ...state.attempt } : undefined,
    order: state.order && typeof state.order === "object" ? { ...state.order } : undefined,
    records: Array.isArray(state.records) ? state.records.map(publicRecord).filter(Boolean).slice(0, MAX_RECORDS) : []
  };
}

function publicWaitlist(value) {
  if (!value || typeof value !== "object") return undefined;
  return {
    active: value.active === true,
    productCode: readString(value.productCode),
    productName: readString(value.productName),
    quantity: nonNegativeInteger(value.quantity),
    minTotalFen: nonNegativeIntegerOrUndefined(value.minTotalFen),
    maxTotalFen: nonNegativeIntegerOrUndefined(value.maxTotalFen),
    startedAt: readString(value.startedAt)
  };
}

function publicOrder(value, includeAttemptState = false) {
  if (!value || typeof value !== "object") return undefined;
  const result = {
    orderId: readString(value.orderId),
    state: readString(value.state),
    product: readString(value.product),
    productName: readString(value.productName),
    quantity: nonNegativeInteger(value.quantity),
    amountFen: nonNegativeInteger(value.amountFen),
    detectedAt: readString(value.detectedAt),
    estimatedExplosionAt: readString(value.estimatedExplosionAt),
    createdAt: readString(value.createdAt),
    completedAt: readString(value.completedAt),
    updatedAt: readString(value.updatedAt),
    imported: value.imported === true,
    importResult: value.importResult,
    lastImportError: readString(value.lastImportError)
  };
  if (includeAttemptState && value.idempotencyKey) result.idempotencyKey = value.idempotencyKey;
  return result;
}

function publicRecord(value) {
  const order = publicOrder(value);
  return order?.orderId ? order : undefined;
}

function isCompletedOrder(order) {
  return ["completed", "complete", "fulfilled", "delivered", "success"].includes(String(order?.state ?? "").toLowerCase());
}

function importResultError(summary) {
  if (summary.imported < summary.total) {
    return `已导入 ${summary.imported}/${summary.total} 个账号`;
  }
  const pendingPool = Math.max(0, summary.total - nonNegativeInteger(summary.skippedExisting));
  if (summary.poolEnabled >= pendingPool) return undefined;
  return nonNegativeInteger(summary.skippedExisting) > 0
    ? `账号已导入，但仅 ${summary.poolEnabled}/${pendingPool} 个新账号启用无感池`
    : `账号已导入，但仅 ${summary.poolEnabled}/${summary.total} 个启用无感池`;
}

function isBlockingWaitlistOrder(order) {
  return Boolean(order?.orderId && !order.imported && !isFailedOrder(order) && !isCompletedOrder(order));
}

function isFailedOrder(order) {
  return ["cancelled", "canceled", "expired", "failed", "refunded", "fulfillment_error"].includes(
    String(order?.state ?? "").toLowerCase()
  );
}

function isStockUnavailable(error) {
  return error instanceof TingbaiApiError && ["stock_unavailable", "insufficient_stock"].includes(error.code);
}

function isQuoteChanged(error) {
  return error instanceof TingbaiApiError && ["quote_changed", "quote_expired"].includes(error.code);
}

function isBalanceInsufficient(error) {
  return error instanceof TingbaiApiError && (error.status === 402 || error.code === "balance_insufficient");
}

function createIdempotencyKey() {
  return `manager-${crypto.randomUUID()}`;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function nonNegativeIntegerOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function readWaitlistBound(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label}必须是有效的非负金额`);
  }
  return number;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "enabled", "1"].includes(normalized)) return true;
  if (["false", "no", "disabled", "0"].includes(normalized)) return false;
  return undefined;
}

function safeError(error, fallback, secret) {
  let message = error instanceof Error && error.message ? error.message.slice(0, 240) : fallback;
  if (secret) message = message.split(secret).join("[redacted]");
  return message;
}

module.exports = {
  DEFAULT_TINGBAI_POLL_INTERVAL_MS,
  TINGBAI_POLL_JITTER_MS,
  TingbaiSource,
  calculateEstimatedExplosionAt,
  calculatePollDelayMs,
  normalizeCatalog,
  normalizeOrder,
  normalizeQuote,
  publicRecord
};
