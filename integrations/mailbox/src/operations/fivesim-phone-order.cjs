"use strict";

const DEFAULT_BASE_URL = "https://5sim.net/v1";
const DEFAULT_PRODUCT = "openai";
const DEFAULT_POLL_INTERVAL_MS = 4000;
const DEFAULT_ORDER_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_REPLACEMENTS = 10;

class FiveSimOrderError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "FiveSimOrderError";
    this.status = status;
    this.code = code || "";
  }
}

class FiveSimClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, token, fetchImpl = globalThis.fetch, timeoutMs = 30000, onLog = () => {} } = {}) {
    if (typeof fetchImpl !== "function") throw new FiveSimOrderError("当前 Node 环境不支持网络请求");
    this.baseUrl = text(baseUrl).replace(/\/+$/u, "") || DEFAULT_BASE_URL;
    this.token = text(token);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onLog = typeof onLog === "function" ? onLog : () => {};
  }

  async request(method, path, { auth = true, query, cacheBust = false } = {}) {
    if (auth && !this.token) throw new FiveSimOrderError("缺少 5SIM API Token", { code: "MISSING_TOKEN" });
    const url = new URL(`${this.baseUrl}${path}`);
    const requestQuery = { ...(query || {}) };
    if (cacheBust) requestQuery._ = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const [key, value] of Object.entries(requestQuery)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const requestUrl = url.toString();
    const headers = { accept: "application/json" };
    if (cacheBust) {
      headers["cache-control"] = "no-cache, no-store, max-age=0";
      headers.pragma = "no-cache";
    }
    if (auth) headers.authorization = `Bearer ${this.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.onLog("info", `5SIM 请求 ${method} ${requestUrl}`);
    try {
      const response = await this.fetchImpl(requestUrl, {
        method,
        headers,
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
        this.onLog("error", `5SIM 响应 ${method} ${requestUrl} HTTP ${response.status}：${safeError(message, this.token)}`);
        throw new FiveSimOrderError(message, { status: response.status, code: responseCode(payload) });
      }
      return payload;
    } catch (error) {
      if (error instanceof FiveSimOrderError) throw error;
      this.onLog("error", `5SIM 网络请求失败 ${method} ${requestUrl}`);
      throw new FiveSimOrderError(
        error?.name === "AbortError" ? "5SIM 请求超时" : "5SIM 网络请求失败",
        { code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK" }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async profile() {
    const payload = await this.request("GET", "/user/profile", { cacheBust: true });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new FiveSimOrderError(responseMessage(payload) || "5SIM 未返回账户资料");
    }
    return payload;
  }

  async countries() {
    const payload = await this.request("GET", "/guest/countries", { auth: false, cacheBust: true });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new FiveSimOrderError(responseMessage(payload) || "5SIM 未返回国家列表");
    }
    return payload;
  }

  async prices(product = DEFAULT_PRODUCT) {
    const payload = await this.request("GET", "/guest/prices", {
      auth: false,
      query: { product: text(product).toLowerCase() || DEFAULT_PRODUCT },
      cacheBust: true
    });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new FiveSimOrderError(responseMessage(payload) || "5SIM 未返回价格列表");
    }
    return payload;
  }

  async catalog(product = DEFAULT_PRODUCT) {
    const [prices, countries] = await Promise.all([this.prices(product), this.countries()]);
    return flattenCatalog(prices, countries, product);
  }

  async buyActivation(country, operator, product = DEFAULT_PRODUCT, { maxPrice } = {}) {
    const countryName = text(country);
    const operatorName = text(operator) || "any";
    const productName = text(product).toLowerCase() || DEFAULT_PRODUCT;
    if (!countryName) throw new FiveSimOrderError("请选择 5SIM 地区");
    const payload = await this.request(
      "GET",
      `/user/buy/activation/${encodeURIComponent(countryName)}/${encodeURIComponent(operatorName)}/${encodeURIComponent(productName)}`,
      { query: Number.isFinite(Number(maxPrice)) ? { maxPrice } : undefined }
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new FiveSimOrderError(responseMessage(payload) || "5SIM 未返回购买订单", { code: responseCode(payload) });
    }
    return payload;
  }

  async checkOrder(orderId) {
    return this.orderRequest("check", orderId);
  }

  async finishOrder(orderId) {
    return this.orderRequest("finish", orderId);
  }

  async cancelOrder(orderId) {
    return this.orderRequest("cancel", orderId);
  }

  async banOrder(orderId) {
    return this.orderRequest("ban", orderId);
  }

  async orderRequest(action, orderId) {
    const id = text(orderId);
    if (!id) throw new FiveSimOrderError("订单缺少编号，无法执行操作");
    const payload = await this.request("GET", `/user/${action}/${encodeURIComponent(id)}`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new FiveSimOrderError(responseMessage(payload) || `5SIM ${action} 未返回订单状态`, { code: responseCode(payload) });
    }
    return payload;
  }
}

class FiveSimPhoneOrderSession {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    service = DEFAULT_PRODUCT,
    sourceId = "fivesim",
    cardKeyId = "",
    cardMasked = "",
    maxReplacements = DEFAULT_MAX_REPLACEMENTS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    orderTimeoutMs = DEFAULT_ORDER_TIMEOUT_MS,
    clientFactory,
    onStateChange = () => {},
    onLog = () => {}
  } = {}) {
    this.baseUrl = text(baseUrl).replace(/\/+$/u, "") || DEFAULT_BASE_URL;
    this.service = text(service).toLowerCase() || DEFAULT_PRODUCT;
    this.sourceId = text(sourceId).toLowerCase() || "fivesim";
    this.cardKeyId = text(cardKeyId);
    this.cardMasked = text(cardMasked);
    this.maxReplacements = clampNumber(maxReplacements, DEFAULT_MAX_REPLACEMENTS, 0, 20);
    this.pollIntervalMs = clampNumber(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 250, 30000);
    this.orderTimeoutMs = clampNumber(orderTimeoutMs, DEFAULT_ORDER_TIMEOUT_MS, 10000, 15 * 60 * 1000);
    this.clientFactory = clientFactory || ((token) => new FiveSimClient({
      baseUrl: this.baseUrl,
      token,
      onLog: (level, message) => this.onLog(level, message)
    }));
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : () => {};
    this.onLog = typeof onLog === "function" ? onLog : () => {};
    this.client = null;
    this.order = null;
    this.pollPromise = null;
    this.pollGeneration = 0;
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
        service: this.service,
        source: this.sourceId,
        keyId: this.cardKeyId,
        masked: this.cardMasked,
        balance: null,
        frozenBalance: null,
        rating: null,
        updatedAt: 0
      },
      catalog: [],
      selection: { country: "", operator: "any", product: this.service },
      order: null,
      humanConfirmed: false,
      replacements: 0,
      maxReplacements: this.maxReplacements,
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

  async refreshInfo(token, { country = "", operator = "any", product = this.service } = {}) {
    if (this.state.running) throw new FiveSimOrderError("当前会话已有取号任务正在运行");
    this.setClient(token);
    this.state.catalog = [];
    this.state.selection = { country: "", operator: "any", product: text(product).toLowerCase() || this.service };
    this.state.card = {
      ...this.state.card,
      balance: null,
      frozenBalance: null,
      rating: null,
      updatedAt: 0
    };
    this.state.phase = "logging_in";
    this.state.message = "正在查询 5SIM 余额与可选号区…";
    this.state.error = "";
    this.touch();
    try {
      const [profile, catalog] = await Promise.all([
        this.client.profile(),
        this.client.catalog(product)
      ]);
      this.adoptProfile(profile);
      this.adoptCatalog(catalog, { country, operator, product });
      this.state.phase = "idle";
      this.state.message = "5SIM 账户和可选号区已更新";
      this.state.error = "";
      this.touch();
      return this.snapshot();
    } catch (error) {
      this.setError(safeError(error, token));
      return this.snapshot();
    }
  }

  async start(token, { country = "", operator = "any", product = this.service } = {}) {
    if (this.state.running) throw new FiveSimOrderError("已有取号任务正在运行");
    this.setClient(token);
    this.order = null;
    this.pollPromise = null;
    ++this.pollGeneration;
    this.state.running = true;
    this.state.phase = "logging_in";
    this.state.message = "正在验证 5SIM 账户并获取号码…";
    this.state.error = "";
    this.state.order = null;
    this.state.startedAt = Date.now();
    this.touch();

    try {
      const offer = await this.preparePurchase({ country, operator, product });
      this.state.phase = "purchasing";
      this.state.message = `正在购买 ${offer.countryName || offer.country} 号码…`;
      this.touch();
      const order = await this.client.buyActivation(offer.country, offer.operator, offer.product, {
        maxPrice: offer.operator === "any" ? offer.price : undefined
      });
      this.adoptOrder(order);
      await this.finishOrPoll();
      return this.snapshot();
    } catch (error) {
      this.setError(safeError(error, token));
      return this.snapshot();
    }
  }

  async confirmNumber() {
    this.requireOrder();
    if (!this.state.running || !["waiting", "polling"].includes(this.state.phase)) {
      throw new FiveSimOrderError("当前没有可读取验证码的号码");
    }
    this.beginPolling("已开始读取验证码…");
    return this.snapshot();
  }

  async replaceNumber() {
    this.requireOrder();
    if (!this.state.running || !["waiting", "polling"].includes(this.state.phase)) {
      throw new FiveSimOrderError("当前号码不在可换号状态");
    }
    if (this.state.replacements >= this.state.maxReplacements) {
      throw new FiveSimOrderError("已达到最大换号次数");
    }
    const previousPhase = this.state.phase;
    ++this.pollGeneration;
    this.pollPromise = null;
    this.state.phase = "replacing";
    this.state.message = "正在取消当前 5SIM 订单并重新取号…";
    this.state.error = "";
    this.touch();
    let oldOrderCancelled = false;
    try {
      const cancelled = await this.client.cancelOrder(this.order.id);
      this.adoptOrder(cancelled);
      oldOrderCancelled = true;
      if (orderHasCode(cancelled)) {
        await this.handleReceivedOrder();
        return this.snapshot();
      }
      ++this.state.replacements;
      this.state.running = true;
      this.state.phase = "purchasing";
      this.state.message = "正在购买新号码…";
      this.touch();
      const offer = await this.preparePurchase(this.state.selection);
      const next = await this.client.buyActivation(offer.country, offer.operator, offer.product, {
        maxPrice: offer.operator === "any" ? offer.price : undefined
      });
      this.adoptOrder(next);
      await this.finishOrPoll();
      this.onLog("info", "已按用户确认取消旧订单并重新购买号码");
      return this.snapshot();
    } catch (error) {
      if (oldOrderCancelled) {
        this.state.running = false;
        this.state.humanConfirmed = false;
        this.state.phase = "error";
        this.state.message = "旧订单已取消，但新号码购买失败";
        this.state.error = safeError(error);
        this.touch();
        throw error;
      }
      const recovered = await this.recoverAfterActionRace(error, previousPhase);
      if (recovered) return this.snapshot();
      this.state.running = true;
      this.state.phase = previousPhase === "polling" ? "polling" : "waiting";
      this.state.message = "重新取号失败，请重试或取消取号";
      this.state.error = safeError(error);
      this.touch();
      throw error;
    }
  }

  async cancelNumber() {
    this.requireOrder();
    if (!this.state.running || ["received", "completed", "cancelled", "error", "timed_out"].includes(this.state.phase)) {
      throw new FiveSimOrderError("当前没有可取消的取号任务");
    }
    ++this.pollGeneration;
    this.state.phase = "cancelling";
    this.state.message = "正在取消 5SIM 订单…";
    this.state.error = "";
    this.touch();
    try {
      const result = await this.client.cancelOrder(this.order.id);
      this.adoptOrder(result);
      if (orderHasCode(result)) {
        await this.handleReceivedOrder();
        return this.snapshot();
      }
      this.state.running = false;
      this.state.humanConfirmed = false;
      this.state.phase = "cancelled";
      this.state.message = "取号已取消";
      this.touch();
      return this.snapshot();
    } catch (error) {
      const recovered = await this.recoverAfterActionRace(error, "waiting");
      if (recovered) return this.snapshot();
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
    this.pollPromise = null;
    this.client = null;
  }

  async preparePurchase(selection = {}) {
    const product = text(selection.product).toLowerCase() || this.service;
    const requestedCountry = text(selection.country);
    const requestedOperator = text(selection.operator) || "any";
    const [profile, catalog] = await Promise.all([
      this.client.profile(),
      this.client.catalog(product)
    ]);
    this.adoptProfile(profile);
    this.adoptCatalog(catalog, { country: requestedCountry, operator: requestedOperator, product });
    const offer = this.state.catalog.find((item) => item.country === this.state.selection.country && item.operator === this.state.selection.operator && item.product === product);
    if (!offer) throw new FiveSimOrderError("当前选择的 5SIM 地区或运营商暂不可用");
    if (offer.count <= 0) throw new FiveSimOrderError("当前选择的 5SIM 地区暂无可用号码");
    if (Number.isFinite(this.state.card.balance) && Number.isFinite(offer.price) && this.state.card.balance < offer.price) {
      throw new FiveSimOrderError(`5SIM 余额不足，需要 ${formatPrice(offer.price)}，当前余额 ${formatPrice(this.state.card.balance)}`);
    }
    return offer;
  }

  async finishOrPoll() {
    if (orderHasCode(this.order)) {
      await this.handleReceivedOrder();
    } else if (["CANCELED", "TIMEOUT", "BANNED", "FINISHED"].includes(orderStatus(this.order))) {
      this.state.running = false;
      this.state.phase = orderStatus(this.order) === "TIMEOUT" ? "timed_out" : orderStatus(this.order) === "CANCELED" ? "cancelled" : "error";
      this.state.message = terminalMessage(this.order, this.state.phase);
      this.state.error = this.state.phase === "error" ? this.state.message : "";
      this.touch();
    } else {
      this.beginPolling("已获取号码，正在自动读取验证码…");
      this.onLog("ok", "已获取 5SIM 号码，自动读取验证码");
    }
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

  async pollOtp(generation) {
    const deadline = Date.now() + this.state.orderTimeoutMs;
    while (this.state.running && this.state.humanConfirmed && generation === this.pollGeneration) {
      if (Date.now() >= deadline) {
        this.state.phase = "timed_out";
        this.state.running = false;
        this.state.message = "读取验证码超时，请手动取消或重新取号";
        this.touch();
        return;
      }
      try {
        const latest = await this.client.checkOrder(this.order.id);
        if (generation !== this.pollGeneration || !this.state.running) return;
        this.adoptOrder(latest, { resetTimer: false });
        if (orderHasCode(latest)) {
          await this.handleReceivedOrder();
          return;
        }
        const status = orderStatus(latest);
        if (["CANCELED", "TIMEOUT", "BANNED", "FINISHED"].includes(status)) {
          this.state.running = false;
          this.state.phase = status === "TIMEOUT" ? "timed_out" : status === "CANCELED" ? "cancelled" : "error";
          this.state.message = terminalMessage(latest, this.state.phase);
          this.state.error = this.state.phase === "error" ? this.state.message : "";
          this.touch();
          return;
        }
        this.state.phase = "polling";
        this.state.message = "正在等待 5SIM 短信验证码…";
        this.touch();
      } catch (error) {
        if (generation !== this.pollGeneration || !this.state.running) return;
        this.state.error = safeError(error);
        this.state.message = "读取 5SIM 验证码失败，稍后重试…";
        this.touch();
      }
      await wait(this.state.pollIntervalMs, () => generation !== this.pollGeneration || !this.state.running);
    }
  }

  adoptProfile(profile) {
    if (!profile || typeof profile !== "object") return;
    this.state.card = {
      ...this.state.card,
      authenticated: true,
      status: "available",
      service: this.service,
      source: this.sourceId,
      balance: finiteOrNull(profile.balance),
      frozenBalance: finiteOrNull(profile.frozen_balance),
      rating: finiteOrNull(profile.rating),
      updatedAt: Date.now()
    };
    this.touch();
  }

  adoptCatalog(catalog, selection = {}) {
    const normalized = Array.isArray(catalog) ? catalog.map((offer) => ({ ...offer })) : [];
    this.state.catalog = normalized;
    const requestedCountry = text(selection.country);
    const requestedOperator = text(selection.operator) || "any";
    const requestedProduct = text(selection.product).toLowerCase() || this.service;
    const current = normalized.find((offer) => offer.country === requestedCountry && offer.operator === requestedOperator && offer.product === requestedProduct && offer.count > 0)
      || normalized.find((offer) => offer.country === this.state.selection.country && offer.operator === this.state.selection.operator && offer.product === requestedProduct && offer.count > 0)
      || normalized.find((offer) => offer.count > 0)
      || normalized[0];
    this.state.selection = current
      ? { country: current.country, operator: current.operator, product: current.product }
      : { country: requestedCountry, operator: requestedOperator, product: requestedProduct };
    this.touch();
  }

  adoptOrder(order, { resetTimer = true } = {}) {
    if (!order || typeof order !== "object") throw new FiveSimOrderError("5SIM 未返回有效订单");
    const merged = { ...(this.order || {}), ...order };
    for (const key of ["phone", "country", "operator", "product", "price", "expires"]) {
      if ((merged[key] === undefined || merged[key] === null || merged[key] === "") && this.order?.[key] !== undefined) {
        merged[key] = this.order[key];
      }
    }
    this.order = merged;
    this.state.order = publicOrder(merged);
    if (resetTimer || !this.state.startedAt) this.state.startedAt = Date.now();
    this.state.error = "";
    const status = orderStatus(merged);
    if (orderHasCode(merged)) this.state.phase = "received";
    else if (status === "CANCELED") this.state.phase = "cancelled";
    else if (status === "TIMEOUT") this.state.phase = "timed_out";
    else if (status === "BANNED" || status === "FINISHED") this.state.phase = "error";
    else this.state.phase = status === "RECEIVED" ? "waiting" : "waiting";
    this.touch();
  }

  async handleReceivedOrder() {
    this.state.phase = "received";
    this.state.running = false;
    this.state.humanConfirmed = false;
    this.state.message = "已收到验证码，请手动填写并提交";
    this.state.error = "";
    this.touch();
    try {
      const finished = await this.client.finishOrder(this.order.id);
      if (finished && typeof finished === "object") this.adoptOrder(finished, { resetTimer: false });
      this.state.phase = "received";
      this.state.running = false;
      this.state.message = "已收到验证码，请手动填写并提交";
      this.touch();
      this.onLog("ok", "已读取 5SIM 验证码并完成订单");
    } catch (error) {
      this.onLog("warn", `5SIM 订单完成标记失败：${safeError(error)}`);
    }
  }

  async recoverAfterActionRace(error, previousPhase) {
    if (!this.order || !this.client) return false;
    let latest;
    try {
      latest = await this.client.checkOrder(this.order.id);
    } catch {
      return false;
    }
    this.adoptOrder(latest, { resetTimer: false });
    if (orderHasCode(latest)) {
      await this.handleReceivedOrder();
      return true;
    }
    this.state.running = true;
    this.state.humanConfirmed = true;
    this.state.phase = previousPhase === "polling" ? "polling" : "waiting";
    this.state.message = "操作未执行，已恢复读取当前号码验证码…";
    this.state.error = safeError(error);
    this.touch();
    this.beginPolling("正在继续读取当前号码验证码…");
    return false;
  }

  setClient(token) {
    const secret = text(token);
    if (!secret) throw new FiveSimOrderError("请先保存 5SIM API Token");
    this.client = this.clientFactory(secret);
    this.cleaned = false;
  }

  requireOrder() {
    if (!this.client || !this.order) throw new FiveSimOrderError("当前没有运行中的 5SIM 取号任务");
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
}

function flattenCatalog(prices, countries, product = DEFAULT_PRODUCT) {
  const productName = text(product).toLowerCase() || DEFAULT_PRODUCT;
  const countryInfo = new Map();
  for (const [country, value] of Object.entries(countries || {})) {
    const info = value && typeof value === "object" ? value : {};
    countryInfo.set(country, {
      name: text(info.text_en || info.name) || country,
      iso: firstObjectKey(info.iso),
      prefix: firstObjectKey(info.prefix)
    });
  }

  const rows = [];
  const productTree = prices?.[productName] && typeof prices[productName] === "object"
    ? prices[productName]
    : Object.fromEntries(Object.entries(prices || {}).filter(([, value]) => value && typeof value === "object" && value[productName]).map(([country, value]) => [country, value[productName]]));
  for (const [country, operators] of Object.entries(productTree || {})) {
    const info = countryInfo.get(country) || { name: country, iso: "", prefix: "" };
    for (const [operator, raw] of Object.entries(operators || {})) {
      if (!raw || typeof raw !== "object") continue;
      const price = finiteOrNull(raw.cost ?? raw.price ?? raw.Price);
      const count = integerOrZero(raw.count ?? raw.qty ?? raw.Qty);
      rows.push({
        country,
        countryName: info.name,
        iso: info.iso,
        prefix: info.prefix,
        operator,
        product: productName,
        price,
        count,
        successRate: normalizeSuccessRate(raw.rate ?? raw.successRate ?? raw.success_rate)
      });
    }
  }
  // 5SIM omits `rate` for offers with insufficient/low delivery history. Such
  // entries must not be presented as selectable offers when the UI promises a
  // minimum usable success rate.
  return rows.filter((offer) => offer.successRate !== null && offer.successRate >= 1).sort(compareOffers);
}

function publicOrder(order) {
  const result = {
    id: text(order?.id),
    status: orderStatus(order),
    phone: text(order?.phone || order?.phoneNumber || order?.phone_number),
    smsCode: orderSmsCode(order)
  };
  for (const key of ["country", "operator", "product", "price", "expires", "created_at", "createdAt", "updated_at", "updatedAt"]) {
    if (key in (order || {})) result[key] = order[key];
  }
  return result;
}

function orderSmsCode(order) {
  const sms = Array.isArray(order?.sms) ? order.sms : [];
  return sms.map((item) => text(item?.code || item?.smsCode || item?.otp_code)).find(Boolean) || text(order?.smsCode || order?.code);
}

function orderHasCode(order) {
  return Boolean(orderSmsCode(order));
}

function orderStatus(order) {
  return text(order?.status).toUpperCase();
}

function terminalMessage(order, phase) {
  if (phase === "cancelled") return "5SIM 订单已取消";
  if (phase === "timed_out") return "5SIM 订单超时，平台未返回验证码";
  if (phase === "error" && orderStatus(order) === "BANNED") return "5SIM 号码已被标记为不可用";
  return "5SIM 订单已结束，但平台未返回验证码";
}

function normalizeSuccessRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const stringValue = typeof value === "string" ? value.trim() : "";
  const explicitPercent = stringValue.endsWith("%");
  const parsed = Number(explicitPercent ? stringValue.slice(0, -1).trim() : value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  // 5SIM documents `rate` as a percentage (for example 59.38), not a
  // fractional ratio. Preserve values below 1 so the UI can remove them.
  return parsed;
}

function compareOffers(left, right) {
  const leftPrice = finiteOrNull(left?.price);
  const rightPrice = finiteOrNull(right?.price);
  if (leftPrice === null && rightPrice !== null) return 1;
  if (leftPrice !== null && rightPrice === null) return -1;
  return (leftPrice ?? 0) - (rightPrice ?? 0)
    || (finiteOrNull(right?.successRate) ?? -1) - (finiteOrNull(left?.successRate) ?? -1)
    || String(left?.countryName || left?.country).localeCompare(String(right?.countryName || right?.country), "en", { numeric: true })
    || String(left?.operator || "").localeCompare(String(right?.operator || ""), "en", { numeric: true });
}

function firstObjectKey(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return Object.keys(value)[0] || "";
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
  return text(payload.error || payload.message || payload.reason || payload.detail);
}

function responseCode(payload) {
  if (!payload || typeof payload !== "object") return "";
  return text(payload.code || payload.reasonCode || payload.reason_code);
}

function safeError(error, secret = "") {
  let message = error instanceof Error ? error.message : text(error);
  if (secret) message = message.split(secret).join("[已隐藏]");
  return (message || "5SIM 请求失败").replace(/[\r\n\t]+/gu, " ").slice(0, 180);
}

function formatPrice(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `$${parsed.toFixed(2)}` : "未知价格";
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
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
  DEFAULT_PRODUCT,
  FiveSimClient,
  FiveSimOrderError,
  FiveSimPhoneOrderSession,
  flattenCatalog,
  normalizeSuccessRate,
  orderHasCode,
  orderSmsCode,
  orderStatus,
  publicOrder
};
