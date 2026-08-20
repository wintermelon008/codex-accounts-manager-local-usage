"use strict";

// LIYE 人工取号/收码工作流。
//
// 这个模块只负责：用户点击后取一个号码、自动轮询验证码，以及在用户明确
// 点击时换号或取消。它不会填写注册页面、提交手机号/验证码，也不会自动换号。

const DEFAULT_BASE_URL = "https://liye.5x20.cn";
const ACTIVE_STATUSES = new Set(["purchasing", "replacing", "cancelling", "waiting"]);
const CANCELLED_STATUSES = new Set(["cancelled", "refunded"]);

function text(value) {
  return String(value ?? "").trim();
}

function splitSetCookieHeader(value) {
  return text(value).split(/,(?=\s*[^,;=\s]+\s*=)/u).map((item) => item.trim()).filter(Boolean);
}

function getSetCookieValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") {
    try {
      const values = headers.getSetCookie();
      if (Array.isArray(values)) return values;
    } catch {
      // Older Node Headers implementations do not expose getSetCookie().
    }
  }
  if (typeof headers.get !== "function") return [];
  const value = headers.get("set-cookie");
  if (Array.isArray(value)) return value;
  return value ? splitSetCookieHeader(value) : [];
}

function saveSetCookies(cookieJar, headers) {
  for (const value of getSetCookieValues(headers)) {
    const pair = text(value).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!cookieValue) cookieJar.delete(name);
    else cookieJar.set(name, cookieValue);
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function originForUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function safeError(error, secret = "") {
  let message = error instanceof Error ? error.message : text(error);
  if (secret) message = message.split(secret).join("[已隐藏]");
  return (message || "接码平台请求失败").replace(/[\r\n\t]+/gu, " ").slice(0, 180);
}

function safeApiPath(path) {
  return text(path).replace(/(\/api\/orders\/)[^/]+(?=\/|$)/u, "$1[order-id]");
}

function orderPhone(order) {
  if (!order || typeof order !== "object") return "";
  return text(order.phone || order.phoneNumber || order.phone_number);
}

function orderCode(order) {
  if (!order || typeof order !== "object") return "";
  return text(order.smsCode || order.sms_code || order.otp_code || order.code);
}

function orderStatus(order) {
  return text(order && typeof order === "object" ? order.status : "").toLowerCase();
}

function orderHasCode(order) {
  // “received” without an actual code is not enough to consume a Key; keep
  // polling until the SMS content is available to copy.
  return Boolean(orderCode(order));
}

function cardStatus(profile) {
  return text(profile?.card?.status).toLowerCase();
}

function normalizeSuccessRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const stringValue = typeof value === "string" ? value.trim() : "";
  const explicitPercent = stringValue.endsWith("%");
  const raw = explicitPercent ? stringValue.slice(0, -1).trim() : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return !explicitPercent && parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
}

function extractSuccessRate(profile) {
  if (!profile || typeof profile !== "object") return null;
  const card = profile.card && typeof profile.card === "object" ? profile.card : {};
  const containers = [
    profile,
    card,
    profile.stats,
    profile.statistics,
    card.stats,
    card.statistics,
  ].filter((value) => value && typeof value === "object");
  const rateKeys = [
    "successRate",
    "success_rate",
    "successRatePercent",
    "success_rate_percent",
    "smsSuccessRate",
    "verificationSuccessRate",
  ];
  for (const container of containers) {
    for (const key of rateKeys) {
      const rate = normalizeSuccessRate(container[key]);
      if (rate !== null) return rate;
    }
  }

  // Some LIYE responses expose only platform-side counters. Derive the
  // percentage from those counters, but never from this extension's history.
  const successKeys = ["successCount", "successfulOrders", "receivedCount", "completedCount", "successes"];
  const totalKeys = ["totalCount", "totalOrders", "ordersCount", "attempts", "total"];
  for (const container of containers) {
    const successKey = successKeys.find((key) => Number.isFinite(Number(container[key])));
    const totalKey = totalKeys.find((key) => Number.isFinite(Number(container[key])));
    if (!successKey || !totalKey) continue;
    const success = Number(container[successKey]);
    const total = Number(container[totalKey]);
    if (total > 0 && success >= 0 && success <= total) return (success / total) * 100;
  }
  return null;
}

function isCodeReceivedConflict(error) {
  if (Number(error?.status) !== 409) return false;
  const marker = `${text(error?.code)} ${text(error?.message)}`;
  return /(验证码.{0,16}(?:已)?到达|(?:otp|verification\s*code|code).{0,24}(?:received|arrived)|already.{0,24}(?:received|arrived))/iu.test(marker);
}

function publicOrder(order) {
  if (!order || typeof order !== "object") return null;
  const result = {
    id: text(order.id),
    status: orderStatus(order),
    phone: orderPhone(order),
    smsCode: orderCode(order),
  };
  for (const key of [
    "countryName",
    "countryEnglishName",
    "createdAt",
    "updatedAt",
    "replaceAvailableAt",
    "cancelAvailableAt",
  ]) {
    if (key in order) result[key] = order[key];
  }
  for (const key of ["canReplace", "canCancel"]) {
    if (key in order) result[key] = Boolean(order[key]);
  }
  return result;
}

class LIYEOrderError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "LIYEOrderError";
    this.status = status;
    this.code = code || "";
  }
}

class LIYEClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = 30000, onLog = () => {} } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new LIYEOrderError("当前 Node 环境不支持网络请求");
    }
    this.baseUrl = text(baseUrl).replace(/\/+$/u, "") || DEFAULT_BASE_URL;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onLog = typeof onLog === "function" ? onLog : () => {};
    this.cookies = new Map();
  }

  async request(method, path, { body, redact = "" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      accept: "application/json",
      "user-agent": "codex-accounts-mailbox-liye/1.0",
    };
    const origin = originForUrl(this.baseUrl);
    if (origin) {
      // LIYE 的同源 POST 会校验来源；这两个头与之前仓库的客户端保持一致。
      headers.origin = origin;
      headers.referer = `${origin}/`;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const cookies = cookieHeader(this.cookies);
    if (cookies) headers.cookie = cookies;
    const requestUrl = `${this.baseUrl}${safeApiPath(path)}`;
    this.onLog("info", `接码请求 ${method} ${requestUrl}`);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      saveSetCookies(this.cookies, response.headers);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = text(payload?.error || payload?.message) || `HTTP ${response.status}`;
        this.onLog("error", `接码响应 ${method} ${requestUrl} HTTP ${response.status}：${safeError(message, redact)}`);
        throw new LIYEOrderError(message, { status: response.status, code: text(payload?.code) });
      }
      if (payload && payload.success === false) {
        const message = text(payload.error || payload.message) || "接码平台请求失败";
        this.onLog("error", `接码响应 ${method} ${requestUrl}：${safeError(message, redact)}`);
        throw new LIYEOrderError(message, {
          status: response.status,
          code: text(payload.code),
        });
      }
      return payload && typeof payload === "object" ? payload : {};
    } catch (error) {
      if (error instanceof LIYEOrderError) throw error;
      this.onLog("error", `接码网络请求失败 ${method} ${requestUrl}`);
      throw new LIYEOrderError(
        error?.name === "AbortError" ? "接码平台请求超时" : "接码平台网络请求失败",
        { code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK" }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async login(cardCode, service = "chatai") {
    return this.request("POST", "/api/card/login", { body: { code: cardCode, service }, redact: cardCode });
  }

  async cardMe() {
    return this.request("GET", "/api/card/me");
  }

  async orders() {
    const payload = await this.request("GET", "/api/orders");
    return Array.isArray(payload.orders) ? payload.orders.filter((item) => item && typeof item === "object") : [];
  }

  async createOrder(service = "chatai") {
    const payload = await this.request("POST", "/api/orders", { body: { service } });
    if (!payload.order || typeof payload.order !== "object") {
      throw new LIYEOrderError("接码平台未返回新订单");
    }
    return payload.order;
  }

  async orderStatus(orderId) {
    const payload = await this.request("GET", `/api/orders/${encodeURIComponent(orderId)}/status`);
    if (!payload.order || typeof payload.order !== "object") {
      throw new LIYEOrderError("接码平台未返回订单状态");
    }
    return payload.order;
  }

  async orderAction(order, action) {
    const orderId = text(order?.id);
    if (!orderId) throw new LIYEOrderError("订单缺少编号，无法执行操作");
    const payload = await this.request("POST", `/api/orders/${encodeURIComponent(orderId)}/action`, {
      body: {
        action,
        expectedActivationId: order.activationId,
        expectedGeneration: order.activationGeneration || 0,
      },
    });
    return payload.order && typeof payload.order === "object" ? payload.order : null;
  }

  async logout() {
    try {
      await this.request("POST", "/api/card/logout", { body: {} });
    } catch {
      // 退出是清理动作，不能覆盖已经显示给用户的订单结果。
    }
  }

  close() {}
}

class LIYEPhoneOrderSession {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    service = "chatai",
    sourceId = "liye",
    cardKeyId = "",
    cardMasked = "",
    maxReplacements = 10,
    pollIntervalMs = 4000,
    orderTimeoutMs = 900000,
    clientFactory,
    onStateChange = () => {},
    onLog = () => {},
  } = {}) {
    this.baseUrl = baseUrl;
    this.service = text(service).toLowerCase() || "chatai";
    this.sourceId = text(sourceId).toLowerCase() || "liye";
    this.cardKeyId = text(cardKeyId);
    this.cardMasked = text(cardMasked);
    this.maxReplacements = clampNumber(maxReplacements, 10, 0, 20);
    this.pollIntervalMs = clampNumber(pollIntervalMs, 4000, 250, 30000);
    this.orderTimeoutMs = clampNumber(orderTimeoutMs, 900000, 10000, 3600000);
    this.clientFactory = clientFactory || (() => new LIYEClient({
      baseUrl: this.baseUrl,
      onLog: (level, message) => this.onLog(level, message)
    }));
    this.onStateChange = onStateChange;
    this.onLog = onLog;
    this.client = null;
    this.order = null;
    this.pollPromise = null;
    this.pollGeneration = 0;
    this.startedAt = 0;
    this.cleaned = false;
    this.state = this.initialState();
  }

  initialState() {
    return {
      running: false,
      phase: "idle",
      service: this.service,
      card: {
        authenticated: false,
        status: "",
        service: "",
        source: this.sourceId,
        keyId: this.cardKeyId,
        masked: this.cardMasked,
        successRate: null,
      },
      order: null,
      humanConfirmed: false,
      replacements: 0,
      maxReplacements: this.maxReplacements,
      pollIntervalMs: this.pollIntervalMs,
      orderTimeoutMs: this.orderTimeoutMs,
      startedAt: 0,
      message: "",
      error: "",
      updatedAt: 0,
    };
  }

  snapshot() {
    return {
      ...this.state,
      order: this.state.order ? { ...this.state.order } : null,
    };
  }

  async start(cardCode) {
    const secret = text(cardCode);
    if (!secret) throw new LIYEOrderError("请填写接码平台卡密");
    if (this.state.running) throw new LIYEOrderError("已有取号任务正在运行");

    this.state = this.initialState();
    this.order = null;
    this.pollPromise = null;
    ++this.pollGeneration;
    this.state.running = true;
    this.state.phase = "logging_in";
    this.state.message = "正在连接接码平台…";
    this.touch();
    this.client = this.clientFactory();
    this.cleaned = false;
    this.startedAt = Date.now();

    try {
      await this.client.login(secret, this.service);
      this.state.phase = "purchasing";
      this.state.message = "正在验证卡密并获取号码…";
      this.touch();
      const profile = typeof this.client.cardMe === "function" ? await this.client.cardMe() : null;
      this.adoptCard(profile);
      const orders = await this.client.orders();
      const existing = selectOrderForCard(profile, orders);
      if (!existing && ["exhausted", "used", "processing"].includes(cardStatus(profile))) {
        throw new LIYEOrderError("卡密已使用，但当前没有可恢复的订单");
      }
      this.adoptOrder(existing || await this.client.createOrder(this.service));
      if (this.state.phase === "received") {
        this.state.running = false;
        this.state.message = "已收到验证码";
        this.touch();
        this.onLog("ok", "已读取验证码");
        await this.finalizeReceivedOrder();
        await this.cleanupClient();
      } else {
        this.beginPolling();
        this.onLog("ok", "已获取号码，自动读取验证码");
      }
      return this.snapshot();
    } catch (error) {
      this.setError(safeError(error, secret));
      await this.cleanupClient();
      return this.snapshot();
    } finally {
      // 不在实例上保留卡密；公开状态也从不包含卡密。
    }
  }

  async confirmNumber() {
    this.requireOrder();
    if (!this.state.running || !["waiting", "purchasing", "polling"].includes(this.state.phase)) {
      throw new LIYEOrderError("当前没有可读取验证码的号码");
    }
    if (!orderPhone(this.order)) throw new LIYEOrderError("接码平台尚未返回手机号");
    // 保留旧消息的兼容入口；新面板不再要求用户点击确认号码。
    this.beginPolling("已开始读取验证码…");
    return this.snapshot();
  }

  async replaceNumber() {
    this.requireOrder();
    if (!this.state.running || !["waiting", "polling"].includes(this.state.phase)) {
      throw new LIYEOrderError("当前号码不在可换号状态");
    }
    if (this.state.replacements >= this.state.maxReplacements) {
      throw new LIYEOrderError("已达到最大换号次数");
    }
    ++this.pollGeneration;
    // 让旧轮询在当前请求完成后退出；新号码必须建立自己的轮询循环。
    this.pollPromise = null;
    const previousPhase = this.state.phase;
    this.state.phase = "replacing";
    this.state.message = "正在申请重新取号…";
    this.state.error = "";
    this.touch();
    try {
      let next = await this.client.orderAction(this.order, "replace");
      if (!next) next = await this.client.orderStatus(this.order.id);
      this.adoptOrder(next);
      this.state.replacements += 1;
      if (this.state.phase !== "received") {
        this.beginPolling("已获取新号码，正在自动读取验证码…");
      }
      this.onLog("info", "已按用户确认换号，自动读取新号码验证码");
      return this.snapshot();
    } catch (error) {
      if (isCodeReceivedConflict(error)) {
        let latest;
        try {
          latest = await this.client.orderStatus(this.order.id);
        } catch {
          // The order can still be polled even if this recovery status request
          // briefly fails; do not turn the expected replace race into a dead
          // session.
        }
        if (latest) {
          this.adoptOrder(latest, { resetTimer: false });
        }
        if (latest && orderHasCode(latest)) {
          this.state.phase = "received";
          this.state.running = false;
          this.state.humanConfirmed = false;
          this.state.message = "换号时发现验证码已到达，已读取当前验证码";
          this.state.error = "";
          this.touch();
          this.onLog("ok", "换号请求冲突，但当前订单已有验证码，已读取");
          await this.finalizeReceivedOrder();
          await this.cleanupClient();
          return this.snapshot();
        }

        this.state.running = true;
        this.state.humanConfirmed = true;
        this.state.phase = "polling";
        this.state.message = "换号未执行，已恢复读取当前号码验证码…";
        this.state.error = "";
        this.touch();
        this.beginPolling("换号未执行，正在继续读取当前号码验证码…");
        this.onLog("warn", "换号请求冲突，已恢复读取当前号码验证码");
        return this.snapshot();
      }
      this.state.phase = previousPhase === "polling" ? "polling" : "waiting";
      this.state.message = "换号失败，请重试或取消取号";
      this.state.error = safeError(error);
      this.touch();
      throw error;
    }
  }

  async cancelNumber() {
    this.requireOrder();
    if (!this.state.running || ["received", "completed", "cancelled", "error", "timed_out"].includes(this.state.phase)) {
      throw new LIYEOrderError("当前没有可取消的取号任务");
    }
    ++this.pollGeneration;
    this.state.phase = "cancelling";
    this.state.message = "正在取消取号…";
    this.state.error = "";
    this.touch();
    try {
      let result = await this.client.orderAction(this.order, "cancel");
      if (!result) result = await this.client.orderStatus(this.order.id);
      this.adoptOrder(result);
      this.state.phase = "cancelled";
      this.state.running = false;
      this.state.humanConfirmed = false;
      this.state.message = "取号已取消";
      this.touch();
      await this.cleanupClient();
      return this.snapshot();
    } catch (error) {
      this.state.phase = "waiting";
      this.state.message = "取消失败，请重试";
      this.state.error = safeError(error);
      this.touch();
      throw error;
    }
  }

  async dispose() {
    ++this.pollGeneration;
    this.state.running = false;
    await this.cleanupClient();
  }

  async pollOtp(generation) {
    const deadline = Date.now() + this.state.orderTimeoutMs;
    while (this.state.running && this.state.humanConfirmed && generation === this.pollGeneration) {
      if (Date.now() >= deadline) {
        this.state.phase = "timed_out";
        this.state.running = false;
        this.state.message = "读取验证码超时，请手动取消或重新取号";
        this.touch();
        await this.cleanupClient();
        return;
      }
      try {
        const latest = await this.client.orderStatus(this.order.id);
        if (generation !== this.pollGeneration || !this.state.running) return;
        this.adoptOrder(latest, { resetTimer: false });
        if (orderHasCode(latest)) {
          this.state.phase = "received";
          this.state.running = false;
          this.state.message = "已读取验证码，请手动填写并提交";
          this.state.error = "";
          this.touch();
          this.onLog("ok", "已读取验证码");
          await this.finalizeReceivedOrder();
          await this.cleanupClient();
          return;
        }
        this.state.phase = "polling";
        this.state.message = "正在等待验证码…";
        this.touch();
      } catch (error) {
        if (generation !== this.pollGeneration || !this.state.running) return;
        this.state.error = safeError(error);
        this.state.message = "读取验证码失败，稍后重试…";
        this.touch();
      }
      await wait(this.state.pollIntervalMs, () => generation !== this.pollGeneration || !this.state.running);
    }
  }

  adoptOrder(order, { resetTimer = true } = {}) {
    if (!order || typeof order !== "object") throw new LIYEOrderError("接码平台未返回有效订单");
    this.order = { ...order };
    this.state.order = publicOrder(order);
    if (resetTimer || !this.state.startedAt) this.state.startedAt = Date.now();
    this.state.error = "";
    if (orderHasCode(order)) this.state.phase = "received";
    else if (CANCELLED_STATUSES.has(orderStatus(order))) this.state.phase = "cancelled";
    else this.state.phase = "waiting";
    this.touch();
  }

  adoptCard(profile) {
    if (!profile || typeof profile !== "object") return;
    const card = profile.card && typeof profile.card === "object" ? profile.card : {};
    this.state.card = {
      authenticated: profile.authenticated !== false,
      status: cardStatus(profile),
      service: text(card.serviceName || card.serviceCode),
      source: this.state.card.source || this.sourceId,
      keyId: this.state.card.keyId || this.cardKeyId,
      masked: this.state.card.masked || this.cardMasked,
      successRate: extractSuccessRate(profile),
    };
    this.touch();
  }

  requireOrder() {
    if (!this.client || !this.order) throw new LIYEOrderError("当前没有运行中的取号任务");
  }

  beginPolling(message = "已获取号码，正在自动读取验证码…") {
    if (!this.state.running || !this.order || orderHasCode(this.order)) return;
    this.state.humanConfirmed = true;
    this.state.phase = "polling";
    this.state.error = "";
    this.state.message = message;
    this.touch();
    if (this.pollPromise) return;
    const generation = ++this.pollGeneration;
    const promise = this.pollOtp(generation);
    this.pollPromise = promise;
    void promise.finally(() => {
      if (this.pollPromise === promise) this.pollPromise = null;
    });
  }

  setError(message) {
    this.state.running = false;
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

  async cleanupClient() {
    if (this.cleaned || !this.client) return;
    this.cleaned = true;
    const client = this.client;
    this.client = null;
    try { await client.logout?.(); } catch {}
    try { await client.close?.(); } catch {}
  }

  async finalizeReceivedOrder() {
    const order = this.order;
    const client = this.client;
    if (!order || !client || !orderHasCode(order)) {
      this.order = null;
      return;
    }
    try {
      await client.orderAction(order, "cancel");
      this.onLog("info", "已清理 LIYE 平台旧号码订单");
    } catch (error) {
      // 收码后部分 LIYE 服务会拒绝重复取消；历史订单过滤仍保证下次
      // 启动不会复用这笔订单，因此清理失败不能覆盖已经取得的验证码。
      this.onLog("warn", `LIYE 旧号码清理未完成：${safeError(error)}`);
    } finally {
      this.order = null;
    }
  }
}

function selectActiveOrder(orders) {
  return [...(Array.isArray(orders) ? orders : [])]
    .sort((a, b) => Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0))
    .find((order) => ACTIVE_STATUSES.has(orderStatus(order)) && !orderHasCode(order)) || null;
}

function selectOrderForCard(profile, orders) {
  const active = selectActiveOrder(orders);
  if (active) return active;
  if (!["exhausted", "used", "processing"].includes(cardStatus(profile))) return null;
  return [...(Array.isArray(orders) ? orders : [])]
    .sort((a, b) => Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0))
    .find((order) => !CANCELLED_STATUSES.has(orderStatus(order)) && !orderHasCode(order)) || null;
}

function clampNumber(value, fallback, low, high) {
  const parsed = Number(value);
  return Math.max(low, Math.min(high, Number.isFinite(parsed) ? parsed : fallback));
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
  LIYEOrderError,
  LIYEClient,
  LIYEPhoneOrderSession,
  publicOrder,
  normalizeSuccessRate,
  extractSuccessRate,
  isCodeReceivedConflict,
};
