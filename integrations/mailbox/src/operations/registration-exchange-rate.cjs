"use strict";

const DEFAULT_STORE_KEY = "codexAccounts.mailbox.registration.exchangeRate.usdCny.v1";
const DEFAULT_ENDPOINT = "https://api.frankfurter.dev/v2/rate/USD/CNY";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_FEE_MULTIPLIER = 1.029;

class RegistrationExchangeRateError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "RegistrationExchangeRateError";
    this.status = status;
    this.code = code || "";
  }
}

class RegistrationExchangeRateStore {
  constructor({
    metadataStore,
    storeKey = DEFAULT_STORE_KEY,
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => Date.now()
  } = {}) {
    if (!metadataStore || typeof metadataStore.get !== "function" || (typeof metadataStore.update !== "function" && typeof metadataStore.store !== "function")) {
      throw new TypeError("Registration exchange-rate store requires a metadata store");
    }
    if (typeof fetchImpl !== "function") {
      throw new RegistrationExchangeRateError("当前 Node 环境不支持汇率查询", { code: "FETCH_UNAVAILABLE" });
    }
    this.metadataStore = metadataStore;
    this.storeKey = storeKey;
    this.endpoint = String(endpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Number(timeoutMs)) : DEFAULT_TIMEOUT_MS;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.lock = Promise.resolve();
  }

  async get() {
    return normalizeExchangeRate(await this.metadataStore.get(this.storeKey));
  }

  async ensureCurrent() {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const cached = await this.get();
      const currentDate = localDateKey(this.now());
      if (cached?.date === currentDate && Number.isFinite(cached.rate) && cached.rate > 0) {
        return { ...cached, cached: true };
      }

      try {
        const fetched = await this.fetchRate();
        const next = {
          version: 1,
          base: "USD",
          quote: "CNY",
          rate: fetched.rate,
          date: currentDate,
          rateDate: fetched.rateDate || currentDate,
          fetchedAt: this.now(),
          source: this.endpoint
        };
        await this.save(next);
        return { ...next, cached: false };
      } catch (error) {
        // This is a one-day cache, not a historical fallback. Once the local
        // date changes, never keep using yesterday's quote after a failed
        // refresh.
        if (cached && cached.date !== currentDate) await this.clear().catch(() => undefined);
        return {
          version: 1,
          base: "USD",
          quote: "CNY",
          rate: null,
          date: currentDate,
          rateDate: "",
          fetchedAt: 0,
          source: this.endpoint,
          stale: true,
          error: safeRateError(error)
        };
      }
    } finally {
      release();
    }
  }

  async save(value) {
    const normalized = normalizeExchangeRate(value);
    if (!normalized) throw new RegistrationExchangeRateError("汇率数据无效", { code: "INVALID_RATE" });
    if (typeof this.metadataStore.update === "function") {
      await this.metadataStore.update(this.storeKey, normalized);
    } else {
      await this.metadataStore.store(this.storeKey, normalized);
    }
    return normalized;
  }

  async clear() {
    if (typeof this.metadataStore.update === "function") {
      await this.metadataStore.update(this.storeKey, undefined);
    } else if (typeof this.metadataStore.delete === "function") {
      await this.metadataStore.delete(this.storeKey);
    } else {
      await this.metadataStore.store(this.storeKey, undefined);
    }
  }

  async fetchRate() {
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        ...(controller ? { signal: controller.signal } : {})
      });
      const raw = typeof response.text === "function"
        ? await response.text()
        : typeof response.json === "function"
          ? JSON.stringify(await response.json())
          : "";
      const payload = parsePayload(raw);
      if (!response.ok) {
        throw new RegistrationExchangeRateError("汇率服务暂时不可用", {
          status: response.status,
          code: "HTTP_ERROR"
        });
      }
      const rate = Number(payload?.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new RegistrationExchangeRateError("汇率服务返回了无效数据", { code: "INVALID_RATE" });
      }
      return {
        rate,
        rateDate: typeof payload?.date === "string" ? payload.date : ""
      };
    } catch (error) {
      if (error instanceof RegistrationExchangeRateError) throw error;
      throw new RegistrationExchangeRateError(
        error?.name === "AbortError" ? "汇率查询超时" : "汇率查询失败",
        { code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK" }
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function normalizeExchangeRate(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const rate = Number(parsed.rate);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const date = String(parsed.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined;
  return {
    version: 1,
    base: "USD",
    quote: "CNY",
    rate,
    date,
    rateDate: String(parsed.rateDate || "").trim(),
    fetchedAt: Number.isFinite(Number(parsed.fetchedAt)) ? Number(parsed.fetchedAt) : 0,
    source: String(parsed.source || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT
  };
}

function localDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "1970-01-01";
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function parsePayload(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeRateError(error) {
  if (error instanceof RegistrationExchangeRateError && error.code === "TIMEOUT") return "汇率查询超时";
  return "汇率查询失败，暂时无法显示人民币换算";
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_FEE_MULTIPLIER,
  DEFAULT_STORE_KEY,
  DEFAULT_TIMEOUT_MS,
  RegistrationExchangeRateError,
  RegistrationExchangeRateStore,
  localDateKey,
  normalizeExchangeRate
};
