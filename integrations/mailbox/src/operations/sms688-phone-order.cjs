"use strict";

const crypto = require("node:crypto");

const DEFAULT_BASE_URL = "https://cdk.sms688.cc/api/v1/manual-sms";
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_ORDER_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PHONE_ALLOCATION_TIMEOUT_MS = 60 * 1000;
const TERMINAL_STATUSES = new Set(["complete", "cancelled", "expired", "error", "failed"]);

class Sms688OrderError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "Sms688OrderError";
    this.status = status;
    this.code = code || "";
  }
}

class Sms688Client {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30000,
    onLog = () => {},
    providerName = "SMS688",
    credentialLabel = "API Key",
    requestIdPrefix = "sms688",
    errorClass = Sms688OrderError
  } = {}) {
    if (typeof fetchImpl !== "function") throw new errorClass("当前 Node 环境不支持网络请求");
    this.baseUrl = text(baseUrl).replace(/\/+$/u, "") || DEFAULT_BASE_URL;
    this.token = text(token);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onLog = typeof onLog === "function" ? onLog : () => {};
    this.providerName = text(providerName) || "SMS688";
    this.credentialLabel = text(credentialLabel) || "API Key";
    this.requestIdPrefix = text(requestIdPrefix) || "sms688";
    this.errorClass = typeof errorClass === "function" ? errorClass : Sms688OrderError;
  }

  async request(method, path, {
    body,
    idempotencyKey = "",
    executionGeneration,
    leaseGeneration
  } = {}) {
    if (!this.token) throw new this.errorClass(`缺少 ${this.providerName} ${this.credentialLabel}`, { code: "MISSING_TOKEN" });
    const requestUrl = `${this.baseUrl}${path}`;
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`
    };
    if (method !== "GET") headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (executionGeneration !== undefined && executionGeneration !== null) {
      headers["x-execution-generation"] = String(executionGeneration);
    }
    if (leaseGeneration !== undefined && leaseGeneration !== null) {
      headers["x-phone-lease-generation"] = String(leaseGeneration);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.onLog("info", `${this.providerName} 请求 ${method} ${safeApiPath(path)}`);
    try {
      const response = await this.fetchImpl(requestUrl, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const raw = typeof response.text === "function"
        ? await response.text()
        : typeof response.json === "function"
          ? JSON.stringify(await response.json())
          : "";
      const payload = parsePayload(raw);
      if (!response.ok) {
        const message = responseMessage(payload) || `HTTP ${response.status}`;
        this.onLog("error", `${this.providerName} 响应 ${method} ${safeApiPath(path)} HTTP ${response.status}：${safeError(message, this.token, `${this.providerName} 请求失败`)}`);
        throw new this.errorClass(message, { status: response.status, code: responseCode(payload) });
      }
      return payload;
    } catch (error) {
      if (error instanceof this.errorClass) throw error;
      this.onLog("error", `${this.providerName} 网络请求失败 ${method} ${safeApiPath(path)}`);
      throw new this.errorClass(
        error?.name === "AbortError" ? `${this.providerName} 请求超时` : `${this.providerName} 网络请求失败`,
        { code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK" }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async profile() {
    const payload = await this.request("GET", "/me");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new this.errorClass(responseMessage(payload) || `${this.providerName} 未返回账户资料`);
    }
    return payload;
  }

  async createLease() {
    const payload = await this.request("POST", "/leases", { idempotencyKey: uniqueRequestId("lease", this.requestIdPrefix) });
    return normalizeLease(payload, `${this.providerName} 未返回有效号码租约`, this.errorClass);
  }

  async orderStatus(jobId) {
    const id = text(jobId);
    if (!id) throw new this.errorClass("租约缺少编号，无法查询状态");
    return normalizeLease(await this.request("GET", `/leases/${encodeURIComponent(id)}`), `${this.providerName} 未返回有效租约状态`, this.errorClass);
  }

  async changeLease(order) {
    const id = orderId(order);
    if (!id) throw new this.errorClass("租约缺少编号，无法换号");
    return normalizeLease(await this.request("POST", `/leases/${encodeURIComponent(id)}/change`, {
      idempotencyKey: uniqueRequestId("change", this.requestIdPrefix),
      executionGeneration: order?.execution_generation,
      leaseGeneration: order?.lease_generation
    }), `${this.providerName} 未返回换号结果`, this.errorClass);
  }

  async releaseLease(order) {
    const id = orderId(order);
    if (!id) throw new this.errorClass("租约缺少编号，无法释放");
    return normalizeLease(await this.request("POST", `/leases/${encodeURIComponent(id)}/release`, {
      idempotencyKey: uniqueRequestId("release", this.requestIdPrefix),
      executionGeneration: order?.execution_generation,
      leaseGeneration: order?.lease_generation
    }), `${this.providerName} 未返回释放结果`, this.errorClass);
  }
}

class Sms688PhoneOrderSession {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    sourceId = "sms688",
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    orderTimeoutMs = DEFAULT_ORDER_TIMEOUT_MS,
    fetchImpl,
    clientFactory,
    providerName = "SMS688",
    credentialLabel = "API Key",
    errorClass = Sms688OrderError,
    onStateChange = () => {},
    onLog = () => {}
  } = {}) {
    this.baseUrl = text(baseUrl).replace(/\/+$/u, "") || DEFAULT_BASE_URL;
    this.sourceId = text(sourceId).toLowerCase() || "sms688";
    this.providerName = text(providerName) || "SMS688";
    this.credentialLabel = text(credentialLabel) || "API Key";
    this.errorClass = typeof errorClass === "function" ? errorClass : Sms688OrderError;
    this.pollIntervalMs = clampNumber(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 250, 30000);
    this.orderTimeoutMs = clampNumber(orderTimeoutMs, DEFAULT_ORDER_TIMEOUT_MS, 10000, 15 * 60 * 1000);
    this.fetchImpl = typeof fetchImpl === "function" ? fetchImpl : undefined;
    this.clientFactory = clientFactory || ((token) => new Sms688Client({
      baseUrl: this.baseUrl,
      token,
      fetchImpl: this.fetchImpl,
      providerName: this.providerName,
      credentialLabel: this.credentialLabel,
      requestIdPrefix: this.sourceId,
      errorClass: this.errorClass,
      onLog: (level, message) => this.onLog(level, message)
    }));
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : () => {};
    this.onLog = typeof onLog === "function" ? onLog : () => {};
    this.client = null;
    this.order = null;
    this.pollPromise = null;
    this.pollGeneration = 0;
    this.phoneReadyAt = 0;
    this.state = this.initialState();
  }

  initialState() {
    return {
      running: false,
      phase: "idle",
      service: "manual-sms",
      card: {
        authenticated: false,
        status: "",
        service: "manual-sms",
        source: this.sourceId,
        keyId: "",
        masked: "",
        balance: null,
        availableUses: null,
        remainingUses: null,
        frozenBalance: null,
        rating: null,
        updatedAt: 0
      },
      catalog: [],
      selection: { country: "", operator: "any", product: "" },
      order: null,
      humanConfirmed: false,
      replacements: 0,
      pollIntervalMs: this.pollIntervalMs,
      orderTimeoutMs: this.orderTimeoutMs,
      startedAt: 0,
      message: "",
      error: "",
      updatedAt: 0
    };
  }

  snapshot() {
    return {
      ...this.state,
      card: { ...this.state.card },
      catalog: this.state.catalog.map((offer) => ({ ...offer })),
      selection: { ...this.state.selection },
      order: this.state.order ? { ...this.state.order } : null
    };
  }

  async refreshInfo(token) {
    if (this.state.running) throw new this.errorClass("当前会话已有取号任务正在运行");
    this.setClient(token);
    this.state.phase = "logging_in";
    this.state.message = `正在查询 ${this.providerName} 可用次数…`;
    this.state.error = "";
    this.touch();
    try {
      const profile = await this.client.profile();
      this.adoptProfile(profile);
      this.state.phase = "idle";
      this.state.message = `${this.providerName} 账户信息已更新`;
      this.state.error = "";
      this.touch();
      return this.snapshot();
    } catch (error) {
      this.setError(safeError(error, token, `${this.providerName} 请求失败`));
      return this.snapshot();
    }
  }

  async start(token) {
    if (this.state.running) throw new this.errorClass(`已有 ${this.providerName} 取号任务正在运行`);
    this.setClient(token);
    this.order = null;
    this.phoneReadyAt = 0;
    this.pollPromise = null;
    ++this.pollGeneration;
    this.state.running = true;
    this.state.humanConfirmed = true;
    this.state.phase = "logging_in";
    this.state.message = `正在验证 ${this.providerName} ${this.credentialLabel} 并获取号码…`;
    this.state.error = "";
    this.state.order = null;
    this.state.startedAt = Date.now();
    this.touch();

    try {
      const profile = await this.client.profile();
      this.adoptProfile(profile);
      const order = await this.client.createLease();
      this.adoptOrder(order);
      if (this.state.running) {
        this.beginPolling(this.order?.phone ? `已获取 ${this.providerName} 号码，正在自动读取验证码…` : `${this.providerName} 正在分配号码…`);
        this.onLog("ok", `已获取 ${this.providerName} 取号任务，自动读取验证码`);
      }
      return this.snapshot();
    } catch (error) {
      this.setError(safeError(error, token, `${this.providerName} 请求失败`));
      return this.snapshot();
    }
  }

  async confirmNumber() {
    this.requireOrder();
    if (!this.state.running || !["purchasing", "waiting", "polling"].includes(this.state.phase)) {
      throw new this.errorClass("当前没有可读取验证码的号码");
    }
    this.beginPolling(`已开始读取 ${this.providerName} 验证码…`);
    return this.snapshot();
  }

  async replaceNumber() {
    this.requireOrder();
    if (!this.state.running || !["waiting", "polling"].includes(this.state.phase) || this.order.can_change === false) {
      throw new this.errorClass("当前号码不在可换号状态");
    }
    const previousPhase = this.state.phase;
    ++this.pollGeneration;
    this.pollPromise = null;
    this.state.phase = "replacing";
    this.state.message = `正在向 ${this.providerName} 申请换号…`;
    this.state.error = "";
    this.touch();
    try {
      const next = await this.client.changeLease(this.order);
      this.order = { ...(this.order || {}), phone: "", sms_code: "", code_expires_at: 0 };
      this.phoneReadyAt = 0;
      this.adoptOrder(next);
      if (orderHasCode(this.order)) return this.snapshot();
      ++this.state.replacements;
      this.state.running = true;
      this.state.humanConfirmed = true;
      this.beginPolling(`${this.providerName} 换号请求已受理，正在等待新号码…`);
      this.onLog("info", `已按用户确认向 ${this.providerName} 请求换号`);
      return this.snapshot();
    } catch (error) {
      const recovered = await this.recoverAfterActionRace(error, previousPhase);
      if (recovered) return this.snapshot();
      this.state.running = true;
      this.state.humanConfirmed = true;
      this.state.phase = previousPhase === "polling" ? "polling" : "waiting";
      this.state.message = `${this.providerName} 换号失败，请重试或取消取号`;
      this.state.error = safeError(error, "", `${this.providerName} 请求失败`);
      this.touch();
      throw error;
    }
  }

  async cancelNumber() {
    this.requireOrder();
    if (!this.state.running || ["received", "completed", "cancelled", "error", "timed_out"].includes(this.state.phase) || this.order.can_release === false) {
      throw new this.errorClass("当前没有可取消的取号任务");
    }
    ++this.pollGeneration;
    this.state.phase = "cancelling";
    this.state.message = `正在向 ${this.providerName} 请求释放号码…`;
    this.state.error = "";
    this.touch();
    try {
      const result = await this.client.releaseLease(this.order);
      this.adoptOrder(result);
      if (orderHasCode(this.order)) return this.snapshot();
      this.state.running = false;
      this.state.humanConfirmed = false;
      this.state.phase = "cancelled";
      this.state.message = "取号已取消";
      this.touch();
      return this.snapshot();
    } catch (error) {
      const recovered = await this.recoverAfterActionRace(error, "waiting");
      if (recovered) return this.snapshot();
      this.state.running = true;
      this.state.humanConfirmed = true;
      this.state.phase = "waiting";
      this.state.message = `${this.providerName} 取消失败，请重试`;
      this.state.error = safeError(error, "", `${this.providerName} 请求失败`);
      this.touch();
      throw error;
    }
  }

  async dispose() {
    ++this.pollGeneration;
    this.state.running = false;
    this.state.humanConfirmed = false;
    this.pollPromise = null;
    this.client = null;
    this.phoneReadyAt = 0;
  }

  beginPolling(message) {
    if (!this.state.running || !this.order || orderHasCode(this.order)) return;
    this.state.humanConfirmed = true;
    this.state.phase = this.order.phone ? "polling" : "purchasing";
    this.state.error = "";
    this.state.message = message || (this.order.phone ? `正在等待 ${this.providerName} 短信验证码…` : `${this.providerName} 正在分配号码…`);
    this.touch();
    if (this.pollPromise) return;
    const generation = ++this.pollGeneration;
    const promise = this.pollLease(generation);
    this.pollPromise = promise;
    void promise.finally(() => {
      if (this.pollPromise === promise) this.pollPromise = null;
    });
  }

  async pollLease(generation) {
    while (this.state.running && this.state.humanConfirmed && generation === this.pollGeneration) {
      const deadline = this.order?.phone && this.phoneReadyAt
        ? this.phoneReadyAt + this.orderTimeoutMs
        : (this.state.startedAt || Date.now()) + DEFAULT_PHONE_ALLOCATION_TIMEOUT_MS;
      if (Date.now() >= deadline) {
        this.state.phase = "timed_out";
        this.state.running = false;
        this.state.humanConfirmed = false;
        this.state.message = `读取 ${this.providerName} 验证码超时，请手动取消或重新取号`;
        this.touch();
        return;
      }
      try {
        const latest = await this.client.orderStatus(this.order.id);
        if (generation !== this.pollGeneration || !this.state.running) return;
        this.adoptOrder(latest, { resetTimer: false });
        if (orderHasCode(latest)) {
          await this.handleReceivedOrder();
          return;
        }
        if (!this.state.running) return;
        this.state.phase = this.order.phone ? "polling" : "purchasing";
        this.state.message = this.order.phone ? `正在等待 ${this.providerName} 短信验证码…` : `${this.providerName} 正在分配号码…`;
        this.state.error = "";
        this.touch();
      } catch (error) {
        if (generation !== this.pollGeneration || !this.state.running) return;
        this.state.error = safeError(error, "", `${this.providerName} 请求失败`);
        this.state.message = `读取 ${this.providerName} 状态失败，稍后重试…`;
        this.touch();
      }
      const interval = this.order?.phone ? Math.min(this.pollIntervalMs, 500) : this.pollIntervalMs;
      await wait(interval, () => generation !== this.pollGeneration || !this.state.running);
    }
  }

  adoptProfile(profile) {
    if (!profile || typeof profile !== "object") return;
    const quota = profile.quota && typeof profile.quota === "object" ? profile.quota : {};
    const availableUses = finiteOrNull(profile.available_uses ?? quota.available_uses ?? profile.cdk?.available_uses
      ?? profile.remaining_uses ?? quota.remaining_uses ?? profile.cdk?.remaining_uses);
    const remainingUses = finiteOrNull(profile.remaining_uses ?? quota.remaining_uses ?? profile.cdk?.remaining_uses);
    this.state.card = {
      ...this.state.card,
      authenticated: true,
      status: "available",
      service: "manual-sms",
      source: this.sourceId,
      balance: availableUses,
      availableUses,
      remainingUses,
      updatedAt: Date.now()
    };
    this.touch();
  }

  adoptOrder(order, { resetTimer = true } = {}) {
    const normalized = normalizeLease(order, `${this.providerName} 未返回有效租约`, this.errorClass);
    this.order = { ...(this.order || {}), ...normalized };
    this.state.order = publicOrder(this.order);
    if (resetTimer || !this.state.startedAt) this.state.startedAt = Date.now();
    this.state.error = "";
    const status = orderStatus(this.order);
    if (this.order.phone && !this.phoneReadyAt) this.phoneReadyAt = Date.now();
    if (!this.order.phone) this.phoneReadyAt = 0;
    if (orderHasCode(this.order)) {
      this.state.phase = "received";
      this.state.running = false;
      this.state.humanConfirmed = false;
    } else if (status === "cancelled") {
      this.state.phase = "cancelled";
      this.state.running = false;
      this.state.humanConfirmed = false;
    } else if (status === "expired") {
      this.state.phase = "timed_out";
      this.state.running = false;
      this.state.humanConfirmed = false;
    } else if (TERMINAL_STATUSES.has(status)) {
      this.state.phase = "error";
      this.state.running = false;
      this.state.humanConfirmed = false;
      this.state.message = orderErrorMessage(this.order) || `${this.providerName} 租约已结束，但未返回验证码`;
      this.state.error = this.state.message;
    } else {
      this.state.running = true;
      this.state.phase = this.order.phone ? "polling" : "purchasing";
    }
    this.touch();
  }

  async handleReceivedOrder() {
    this.state.phase = "received";
    this.state.running = false;
    this.state.humanConfirmed = false;
    this.state.message = `已读取 ${this.providerName} 验证码，请手动填写并提交`;
    this.state.error = "";
    this.touch();
    this.onLog("ok", `已读取 ${this.providerName} 验证码`);
  }

  async recoverAfterActionRace(error, previousPhase) {
    if (!this.order || !this.client) return false;
    let latest;
    try {
      latest = await this.client.orderStatus(this.order.id);
    } catch {
      return false;
    }
    this.adoptOrder(latest, { resetTimer: false });
    if (orderHasCode(latest)) {
      await this.handleReceivedOrder();
      return true;
    }
    if (!this.state.running) return false;
    this.state.running = true;
    this.state.humanConfirmed = true;
    this.state.phase = previousPhase === "polling" ? "polling" : "waiting";
    this.state.message = "操作未执行，已恢复读取当前号码验证码…";
    this.state.error = safeError(error, "", `${this.providerName} 请求失败`);
    this.touch();
    this.beginPolling("正在继续读取当前号码验证码…");
    return false;
  }

  setClient(token) {
    const secret = text(token);
    if (!secret) throw new this.errorClass(`请先保存 ${this.providerName} ${this.credentialLabel}`);
    this.client = this.clientFactory(secret);
  }

  requireOrder() {
    if (!this.client || !this.order) throw new this.errorClass(`当前没有运行中的 ${this.providerName} 取号任务`);
  }

  setError(message) {
    this.state.running = false;
    this.state.humanConfirmed = false;
    this.state.phase = "error";
    this.state.error = message;
    this.state.message = message;
    this.touch();
    this.onLog("error", message);
  }

  touch() {
    this.state.updatedAt = Date.now();
    this.onStateChange(this.snapshot());
  }
}

function normalizeLease(payload, fallbackMessage, ErrorClass = Sms688OrderError) {
  const raw = leaseFromPayload(payload);
  if (!raw) throw new ErrorClass(fallbackMessage || "SMS688 未返回有效租约");
  const id = orderId(raw);
  if (!id) throw new ErrorClass(fallbackMessage || "SMS688 租约缺少编号");
  return {
    ...raw,
    id,
    job_id: id,
    status: orderStatus(raw),
    phone: text(raw.phone || raw.phone_number || raw.phoneNumber),
    sms_code: text(raw.sms_code || raw.smsCode || raw.external_sms_code || raw.externalSmsCode)
  };
}

function leaseFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.lease && typeof payload.lease === "object") return payload.lease;
  if (payload.job && typeof payload.job === "object") return payload.job;
  if (Array.isArray(payload.leases)) {
    return payload.leases.find((lease) => lease && (lease.job_id || lease.id)) || null;
  }
  return payload.job_id || payload.id ? payload : null;
}

function publicOrder(order) {
  const result = {
    id: orderId(order),
    status: orderStatus(order),
    phone: text(order?.phone || order?.phone_number || order?.phoneNumber),
    smsCode: orderSmsCode(order)
  };
  for (const key of [
    "execution_generation", "lease_generation", "expires_at", "code_received_at", "code_expires_at",
    "pending", "can_change", "can_release", "phone_ready", "allocation_status", "needs_phone_change",
    "recovery_message", "quota_charged", "replaceAvailableAt", "cancelAvailableAt"
  ]) {
    if (key in (order || {})) result[key] = order[key];
  }
  return result;
}

function orderId(order) {
  return text(order?.job_id || order?.id);
}

function orderStatus(order) {
  return text(order?.status).toLowerCase();
}

function orderSmsCode(order) {
  const code = text(order?.sms_code || order?.smsCode || order?.external_sms_code || order?.externalSmsCode || order?.code);
  if (!code) return "";
  const expiresAt = Number(order?.code_expires_at || 0);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now() / 1000 ? "" : code;
}

function orderHasCode(order) {
  return Boolean(orderSmsCode(order));
}

function orderErrorMessage(order) {
  for (const key of ["error", "message", "reason", "recovery_message"]) {
    if (typeof order?.[key] === "string" && order[key].trim()) return order[key].trim();
  }
  return "";
}

function uniqueRequestId(action, prefix = "sms688") {
  return `${text(prefix) || "sms688"}-${action}-${Date.now()}-${crypto.randomUUID()}`;
}

function safeApiPath(path) {
  return text(path).replace(/\/leases\/[^/]+(?=\/|$)/u, "/leases/[job-id]");
}

function safeError(error, secret = "", fallback = "SMS688 请求失败") {
  let message = error instanceof Error ? error.message : text(error);
  if (secret) message = message.split(secret).join("[已隐藏]");
  return (message || fallback).replace(/[\r\n\t]+/gu, " ").slice(0, 180);
}

function parsePayload(raw) {
  const value = text(raw);
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function responseMessage(payload) {
  if (typeof payload === "string") return payload.trim();
  if (!payload || typeof payload !== "object") return "";
  return text(payload.detail || payload.error || payload.message || payload.reason);
}

function responseCode(payload) {
  if (!payload || typeof payload !== "object") return "";
  return text(payload.code || payload.error_code || payload.reasonCode || payload.reason_code);
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value, fallback, low, high) {
  const parsed = Number(value);
  return Math.max(low, Math.min(high, Number.isFinite(parsed) ? parsed : fallback));
}

function text(value) {
  return String(value ?? "").trim();
}

function wait(ms, shouldStop) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof shouldStop === "function" && shouldStop()) {
      clearTimeout(timer);
      resolve();
    }
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_ORDER_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PHONE_ALLOCATION_TIMEOUT_MS,
  Sms688Client,
  Sms688OrderError,
  Sms688PhoneOrderSession,
  leaseFromPayload,
  normalizeLease,
  orderHasCode,
  orderSmsCode,
  orderStatus,
  publicOrder
};
