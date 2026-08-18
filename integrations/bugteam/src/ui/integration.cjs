"use strict";

const { BugTeamApiError, BugTeamClient, DEFAULT_BASE_URL } = require("../api/client.cjs");
const { selectOneHourProduct } = require("../core/product.cjs");
const { normalizeSub2Bundle } = require("../core/sub2.cjs");
const { BugTeamStorage } = require("../storage.cjs");
const { TingbaiSource } = require("../tingbaiSource.cjs");
const { createBugTeamPanelHtml, BUGTEAM_PANEL_VIEW_TYPE } = require("./panel.cjs");

const INTEGRATION_ID = "bugteam";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SHELF_POLL_INTERVAL_MS = 5_000;
const IMPORT_RETRY_DELAY_MS = 30_000;
const MAX_TOKEN_LENGTH = 1_024;

class BugTeamIntegration {
  constructor(vscode, context, api, options = {}) {
    const {
      clientFactory,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
      tingbaiClientFactory,
      tingbaiPollIntervalMs
    } = options;
    this.vscode = vscode;
    this.context = context;
    this.api = api;
    this.storage = new BugTeamStorage(context);
    this.clientFactory = clientFactory ?? ((token) => new BugTeamClient({ token }));
    this.pollIntervalMs = pollIntervalMs;
    this.events = new vscode.EventEmitter();
    this.registration = undefined;
    this.panel = undefined;
    this.panelDisposables = [];
    this.pollTimer = undefined;
    this.shelfPollTimer = undefined;
    this.pollInFlight = false;
    this.shelfPollInFlight = false;
    this.purchaseInFlight = false;
    this.importInFlight = false;
    this.lastImportAttemptAt = 0;
    this.token = "";
    this.order = {};
    this.remote = { balance: undefined, product: undefined, inventory: undefined, shelves: [] };
    this.lastError = undefined;
    this.disposed = false;
    this.tingbai = new TingbaiSource({
      storage: this.storage,
      clientFactory: tingbaiClientFactory,
      pollIntervalMs: tingbaiPollIntervalMs,
      importBundle: (bundle) => this.importSharedBundle(bundle),
      onDidChange: () => {
        this.publish();
        void this.publishPanelState();
      }
    });
  }

  async initialize() {
    try {
      this.token = (await this.storage.getToken())?.trim() ?? "";
      this.order = await this.storage.getOrder();
      if (this.order.uncertain && this.order.lastError) {
        this.lastError = this.order.lastError;
      } else if (this.order.state === "completed" && !this.order.imported && this.order.lastImportError) {
        this.lastError = this.order.lastImportError;
      }
    } catch (error) {
      this.lastError = safeError(error, "BugTeam 本地状态不可用");
    }
    try {
      await this.tingbai.initialize();
    } catch (error) {
      this.tingbai.recordError(error);
    }

    this.context.subscriptions.push(
      this.vscode.commands.registerCommand("codexAccountsBugteam.open", () => this.openPanel())
    );
    this.registration = this.api.registerDashboardIntegration({
      id: INTEGRATION_ID,
      getViewModel: () => this.getViewModel(),
      runAction: (actionId) => this.runAction(actionId),
      onDidChange: this.events.event
    });
    this.publish();

    if (this.token && this.shouldContinuePolling()) {
      this.startPolling();
      void this.refreshRemoteState().catch((error) => this.recordError(error));
    }
  }

  getViewModel() {
    const tingbai = this.tingbai.getViewModel();
    const hasPendingOrder = this.shouldContinuePolling() || tingbai.waitlist?.active || tingbai.attemptPending || Boolean(tingbai.order && !tingbai.order.imported);
    const sourceError = this.lastError ?? tingbai.lastError;
    const hasConfiguredSource = Boolean(this.token || tingbai.credentialsConfigured);
    const status = sourceError ? "warning" : hasPendingOrder ? "active" : hasConfiguredSource ? "ready" : "inactive";
    const balance = this.remote.balance;
    const product = this.remote.product;
    return {
      id: INTEGRATION_ID,
      title: "BugTeam",
      status,
      statusMessage: sourceError
        ? sourceError
        : hasPendingOrder
          ? `后台任务 ${this.order.orderId ?? tingbai.order?.orderId ?? "候补中"}`
          : hasConfiguredSource
            ? "服务来源已连接"
            : "待配置服务来源",
      description: "从多个 BugTeam 来源购买并自动导入无感池",
      details: [
        { label: "BugTeam 余额", value: balance ? formatMoney(balance.availableFen) : "—" },
        { label: "超级炸弹车余额", value: tingbai.balance ? formatMoney(tingbai.balance.balanceFen) : "—" }
      ],
      metrics: [
        { label: "订单", value: this.order.state ? orderStateLabel(this.order.state) : "无" },
        { label: "导入", value: this.order.importResult ? `${this.order.importResult.poolEnabled}/${this.order.importResult.total} 入池` : "—" }
      ],
      topButton: {
        actionId: "open",
        label: "BugTeam",
        tooltip: "打开 BugTeam 余额与补货面板",
        icon: "bugteam"
      },
      actions: [
        { id: "open", label: "打开 BugTeam", enabled: !this.lastError || Boolean(this.token), tone: "primary" }
      ]
    };
  }

  async runAction(actionId) {
    if (actionId !== "open") {
      throw new Error("Unsupported BugTeam action.");
    }
    await this.openPanel();
  }

  async openPanel() {
    if (this.disposed) return;
    if (this.panel) {
      this.panel.reveal(this.vscode.ViewColumn.Beside, false);
      this.startShelfPolling();
      await this.publishPanelState();
      return;
    }
    this.panel = this.vscode.window.createWebviewPanel(
      BUGTEAM_PANEL_VIEW_TYPE,
      "BugTeam",
      { viewColumn: this.vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = createBugTeamPanelHtml();
    this.panelDisposables.push(
      this.panel.webview.onDidReceiveMessage((message) => this.handlePanelMessage(message)),
      this.panel.onDidDispose(() => this.closePanel())
    );
    await this.publishPanelState();
    this.startShelfPolling();
    this.publish();
  }

  async handlePanelMessage(message) {
    if (!message || typeof message !== "object") return;
    try {
      switch (message.action) {
        case "ready":
          if (this.token) {
            try {
              await this.refreshRemoteState();
            } catch (error) {
              await this.recordError(error);
            }
          }
          try {
            await this.tingbai.refresh();
          } catch (error) {
            this.tingbai.recordError(error);
          }
          await this.publishPanelState();
          return;
        case "setToken":
          await this.setToken(message.token);
          break;
        case "clearToken":
          await this.clearToken();
          break;
        case "refresh":
          await this.refreshRemoteState();
          await this.postToast("success", "BugTeam 状态已同步");
          break;
        case "purchase":
        case "reserve":
          await this.purchaseOneHourAccount();
          await this.postToast("success", "候补订单已创建，等待补货后自动发货");
          break;
        case "purchaseShelf":
          await this.purchaseOneHourAccount({ shelfBucketStart: message.bucketStart });
          await this.postToast("success", "选档购买已提交，正在处理发货");
          break;
        case "retryImport":
          await this.processCompletedOrder(true);
          break;
        case "openWebsite":
          await this.vscode.env.openExternal(this.vscode.Uri.parse(DEFAULT_BASE_URL));
          break;
        case "tingbaiSetCredentials":
          await this.tingbai.setCredentials(message.username, message.password);
          await this.postToast("success", "超级炸弹车买家账号已验证");
          break;
        case "tingbaiClearCredentials":
          await this.tingbai.clearCredentials();
          break;
        case "tingbaiRefresh":
          await this.tingbai.refresh();
          await this.postToast("success", "超级炸弹车状态已同步");
          break;
        case "tingbaiStartWaitlist":
          await this.tingbai.startWaitlist({
            minTotalFen: message.minTotalFen,
            maxTotalFen: message.maxTotalFen
          });
          await this.postToast("success", "候补已启动，发现库存后将按金额范围自动购买 1 个");
          break;
        case "tingbaiStopWaitlist":
          await this.tingbai.stopWaitlist();
          break;
        case "tingbaiRetryImport":
          await this.tingbai.retryImport();
          break;
        case "tingbaiOpenWebsite":
          await this.vscode.env.openExternal(this.vscode.Uri.parse("https://tingbai.top/bugteam/"));
          break;
        default:
          throw new Error("Unsupported BugTeam panel action.");
      }
      await this.publishPanelState();
      this.publish();
      await this.postActionResult(message.action, "success");
    } catch (error) {
      if (String(message.action ?? "").startsWith("tingbai")) {
        const messageText = this.tingbai.recordError(error);
        await this.postToast("error", messageText);
        await this.postActionResult(message.action, "error");
        return;
      }
      await this.recordError(error);
      await this.postToast("error", this.lastError);
      await this.postActionResult(message.action, "error");
    }
  }

  getPanelState() {
    return {
      tokenConfigured: Boolean(this.token),
      baseUrl: DEFAULT_BASE_URL,
      balance: this.remote.balance,
      product: this.remote.product,
      inventory: this.remote.inventory,
      shelves: this.remote.shelves,
      order: this.order.orderId || this.order.uncertain || this.order.creationPending ? publicOrder(this.order) : undefined,
      managerImportAvailable: typeof this.api.importSharedAccountsToBalancePool === "function",
      lastError: this.lastError,
      tingbai: this.tingbai.getViewModel()
    };
  }

  async setToken(value) {
    const token = typeof value === "string" ? value.trim() : "";
    if (!token || token.length > MAX_TOKEN_LENGTH) {
      throw new Error("请输入有效的 BugTeam API Token");
    }
    await this.storage.setToken(token);
    this.token = token;
    this.remote = { balance: undefined, product: undefined, inventory: undefined, shelves: [] };
    this.lastError = undefined;
    await this.refreshRemoteState();
    this.startShelfPolling();
  }

  async clearToken() {
    if (this.shouldContinuePolling() || this.order.uncertain) {
      throw new Error("请先完成或确认当前 BugTeam 订单，再清除本地 Token");
    }
    await this.storage.deleteToken();
    this.token = "";
    this.remote = { balance: undefined, product: undefined, inventory: undefined, shelves: [] };
    this.lastError = undefined;
    this.stopShelfPolling();
  }

  async refreshRemoteState() {
    const client = this.requireClient();
    const [dashboard, balance] = await Promise.all([client.getDashboard(), client.getBalance()]);
    const product = selectOneHourProduct(dashboard?.products ?? dashboard?.product_catalog ?? []);
    const [inventory, shelves] = await Promise.all([
      client.getInventory(product.code, 1),
      typeof client.getInventoryShelves === "function" ? client.getInventoryShelves(product.code) : undefined
    ]);
    this.remote = {
      balance: normalizeBalance(balance),
      product,
      inventory: normalizeInventory(inventory),
      shelves: normalizeShelves(shelves)
    };
    this.lastError = undefined;
    if (this.order.orderId) {
      await this.pollOrder({ forceImport: false });
    }
    this.syncPolling();
    this.startShelfPolling();
  }

  async purchaseOneHourAccount({ shelfBucketStart } = {}) {
    if (this.purchaseInFlight) return;
    if (this.hasOpenOrder()) {
      throw new Error("已有 BugTeam 订单，请等待当前订单完成并导入");
    }
    const retryingUncertainOrder = Boolean(this.order.uncertain && this.order.idempotencyKey);
    if (this.order.uncertain && !retryingUncertainOrder) {
      throw new Error("上一次下单结果尚未确认，请先在 BugTeam 网页核对订单，扩展不会重复下单");
    }

    this.purchaseInFlight = true;
    try {
      if (!retryingUncertainOrder) {
        await this.refreshRemoteState();
      }
      const requestedShelfBucketStart = retryingUncertainOrder
        ? readString(this.order.shelfBucketStart)
        : readString(shelfBucketStart);
      const product = this.remote.product;
      const balance = this.remote.balance;
      const orderQuantity = retryingUncertainOrder ? Math.max(1, nonNegativeInteger(this.order.quantity)) : 1;
      if (!retryingUncertainOrder && (!product || !balance)) {
        throw new Error("BugTeam 商品报价尚未准备好，请刷新后重试");
      }
      if (!retryingUncertainOrder && requestedShelfBucketStart) {
        const selectedShelf = this.remote.shelves.find((shelf) => shelf.bucketStart === requestedShelfBucketStart);
        if (!selectedShelf || selectedShelf.available < orderQuantity) {
          throw new Error("所选发车档已售罄或库存不足，请刷新后重新选择");
        }
      }
      const inventory = !retryingUncertainOrder && requestedShelfBucketStart
        ? normalizeInventory(await this.requireClient().getInventory(product.code, orderQuantity, requestedShelfBucketStart))
        : this.remote.inventory;
      if (!retryingUncertainOrder && (!product || !balance || !inventory)) {
        throw new Error("BugTeam 商品报价尚未准备好，请刷新后重试");
      }
      if (!retryingUncertainOrder) {
        const holdFen = nonNegativeInteger(inventory.hold_total_fen ?? inventory.estimated_total_fen ?? product.priceFen);
        if (balance.availableFen < holdFen) {
          throw new Error(`BugTeam 可用余额不足，需要 ${formatMoney(holdFen)}，当前为 ${formatMoney(balance.availableFen)}`);
        }
      }

      const idempotencyKey = retryingUncertainOrder ? this.order.idempotencyKey : createIdempotencyKey();
      const orderProduct = retryingUncertainOrder ? readString(this.order.product) : product?.code;
      if (!orderProduct) {
        throw new Error("BugTeam 上一次订单缺少商品编码，无法安全重试");
      }
      this.order = {
        idempotencyKey,
        product: orderProduct,
        productName: retryingUncertainOrder ? this.order.productName : product?.name,
        quantity: orderQuantity,
        shelfBucketStart: retryingUncertainOrder ? readString(this.order.shelfBucketStart) : requestedShelfBucketStart,
        state: "creating",
        creationPending: true,
        uncertain: false,
        imported: false,
        lastError: undefined,
        lastImportError: undefined,
        importResult: undefined
      };
      await this.persistOrder();

      try {
        const created = await this.requireClient().createPickupOrder({
          product: orderProduct,
          quantity: orderQuantity,
          idempotencyKey,
          expiryBucketStart: this.order.shelfBucketStart
        });
        const order = withCreatedOrderDefaults(normalizeOrder(created), this.order);
        if (!order.orderId) {
          throw new Error("BugTeam 创建订单响应缺少订单号");
        }
        this.applyOrder(order);
        this.order.creationPending = false;
        this.order.uncertain = false;
        this.lastError = undefined;
        await this.persistOrder();
        this.startPolling();
        await this.pollOrder({ forceImport: true });
      } catch (error) {
        const recoveredOrderId = readOrderId(error?.payload);
        if (recoveredOrderId) {
          this.applyOrder(withCreatedOrderDefaults(normalizeOrder(error.payload), this.order));
          this.order.orderId = recoveredOrderId;
          this.order.creationPending = false;
          this.order.uncertain = false;
          await this.persistOrder();
          this.startPolling();
        } else {
          this.order.creationPending = false;
          this.order.state = "uncertain";
          this.order.uncertain = true;
          this.order.lastError = safeError(error, "BugTeam 下单结果待确认", this.token);
          await this.persistOrder();
        }
        throw error;
      }
    } finally {
      this.purchaseInFlight = false;
      this.syncPolling();
      this.publish();
    }
  }

  async pollOrder({ forceImport = false } = {}) {
    if (!this.order.orderId || this.pollInFlight || !this.token) return;
    this.pollInFlight = true;
    try {
      const response = await this.requireClient().getPickupOrder(this.order.orderId);
      const order = normalizeOrder(response);
      if (!order.orderId) order.orderId = this.order.orderId;
      this.applyOrder(order);
      this.order.lastError = undefined;
      this.lastError = undefined;
      await this.persistOrder();
      if (this.order.state === "completed" && !this.order.imported) {
        await this.processCompletedOrder(forceImport);
      }
    } catch (error) {
      await this.recordError(error, false);
    } finally {
      this.pollInFlight = false;
      this.syncPolling();
      this.publish();
      await this.publishPanelState();
    }
  }

  async processCompletedOrder(force = false) {
    if (!this.order.orderId || this.order.state !== "completed" || this.order.imported || this.importInFlight) return;
    if (!force && Date.now() - this.lastImportAttemptAt < IMPORT_RETRY_DELAY_MS) return;
    this.importInFlight = true;
    this.lastImportAttemptAt = Date.now();
    try {
      const bundle = await this.requireClient().downloadSub2(this.order.orderId);
      const summary = await this.importSharedBundle(bundle);
      this.order.importResult = summary;
      this.order.imported = summary.imported === summary.total && summary.poolEnabled === summary.total;
      this.order.lastImportError = this.order.imported
        ? undefined
        : summary.imported < summary.total
          ? `已导入 ${summary.imported}/${summary.total} 个账号`
          : `账号已导入，但仅 ${summary.poolEnabled}/${summary.total} 个启用无感池`;
      this.lastError = this.order.imported ? undefined : this.order.lastImportError;
      await this.persistOrder();
    } catch (error) {
      this.order.lastImportError = safeError(error, "BugTeam 账号导入失败", this.token);
      await this.persistOrder();
      throw error;
    } finally {
      this.importInFlight = false;
    }
  }

  async importSharedBundle(bundle) {
    if (typeof this.api.importSharedAccountsToBalancePool !== "function") {
      throw new Error("当前 Manager 未提供无感账号池导入能力");
    }
    const accounts = normalizeSub2Bundle(bundle);
    const result = await this.api.importSharedAccountsToBalancePool(accounts);
    return normalizeImportResult(result);
  }

  applyOrder(order) {
    this.order = {
      ...this.order,
      ...order,
      creationPending: false,
      updatedAt: new Date().toISOString()
    };
  }

  async recordError(error, persist = true) {
    this.lastError = safeError(error, "BugTeam 操作失败", this.token);
    if (this.order.orderId) {
      this.order.lastError = this.lastError;
    }
    if (persist) await this.persistOrder();
    await this.publishPanelState();
    this.publish();
  }

  async persistOrder() {
    await this.storage.updateOrder(publicOrder(this.order, true));
  }

  requireClient() {
    if (!this.token) throw new Error("请先配置 BugTeam API Token");
    return this.clientFactory(this.token);
  }

  shouldContinuePolling() {
    return this.hasOpenOrder();
  }

  hasOpenOrder() {
    return Boolean(this.order.orderId && this.order.state !== "cancelled" && !this.order.imported);
  }

  syncPolling() {
    if (this.shouldContinuePolling() && this.token) this.startPolling();
    else this.stopPolling();
  }

  startPolling() {
    if (this.pollTimer || !this.shouldContinuePolling() || !this.token) return;
    this.pollTimer = setInterval(() => {
      void this.pollOrder();
    }, this.pollIntervalMs);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  startShelfPolling() {
    if (this.shelfPollTimer || !this.panel || !this.token || !this.remote.product) return;
    const client = this.requireClient();
    if (typeof client.getInventoryShelves !== "function") return;
    this.shelfPollTimer = setInterval(() => {
      void this.refreshShelfState();
    }, SHELF_POLL_INTERVAL_MS);
    this.shelfPollTimer.unref?.();
  }

  stopShelfPolling() {
    if (this.shelfPollTimer) clearInterval(this.shelfPollTimer);
    this.shelfPollTimer = undefined;
  }

  async refreshShelfState() {
    if (this.shelfPollInFlight || !this.panel || !this.token || !this.remote.product) return;
    const client = this.requireClient();
    if (typeof client.getInventoryShelves !== "function") return;
    this.shelfPollInFlight = true;
    try {
      const shelves = await client.getInventoryShelves(this.remote.product.code);
      this.remote = { ...this.remote, shelves: normalizeShelves(shelves) };
      this.lastError = undefined;
      await this.publishPanelState();
    } catch (error) {
      await this.recordError(error, false);
    } finally {
      this.shelfPollInFlight = false;
    }
  }

  publish() {
    if (this.disposed) return;
    this.events.fire();
  }

  async publishPanelState() {
    if (this.panel) {
      await this.panel.webview.postMessage({ type: "state", state: this.getPanelState() });
    }
  }

  async postToast(level, message) {
    if (this.panel) {
      await this.panel.webview.postMessage({ type: "toast", level, message });
    }
  }

  async postActionResult(action, level) {
    if (this.panel) {
      await this.panel.webview.postMessage({ type: "actionResult", action, level });
    }
  }

  closePanel() {
    this.stopShelfPolling();
    for (const disposable of this.panelDisposables.splice(0)) disposable.dispose?.();
    this.panel = undefined;
  }

  dispose() {
    this.disposed = true;
    this.stopPolling();
    this.stopShelfPolling();
    this.tingbai.dispose();
    for (const disposable of this.panelDisposables.splice(0)) disposable.dispose?.();
    this.panel?.dispose?.();
    this.panel = undefined;
    this.registration?.dispose?.();
    this.registration = undefined;
    this.events.dispose();
  }
}

function normalizeBalance(balance) {
  return {
    balanceFen: nonNegativeInteger(balance?.balance_fen),
    heldFen: nonNegativeInteger(balance?.held_fen),
    availableFen: nonNegativeInteger(balance?.available_fen),
    currency: typeof balance?.currency === "string" && balance.currency.trim() ? balance.currency.trim() : "CNY"
  };
}

function normalizeInventory(inventory) {
  if (!inventory || typeof inventory !== "object") return undefined;
  return {
    available: nonNegativeInteger(inventory.available),
    missing: nonNegativeInteger(inventory.missing),
    hold_total_fen: nonNegativeInteger(inventory.hold_total_fen),
    estimated_total_fen: nonNegativeInteger(inventory.estimated_total_fen),
    minimum_remaining_seconds: nonNegativeInteger(inventory.minimum_remaining_seconds),
    maximum_remaining_seconds: nonNegativeInteger(inventory.maximum_remaining_seconds)
  };
}

function normalizeShelves(response) {
  const buckets = Array.isArray(response?.buckets)
    ? response.buckets
    : Array.isArray(response?.shelves)
      ? response.shelves
      : [];
  return buckets
    .filter((bucket) => bucket && typeof bucket === "object" && !Array.isArray(bucket))
    .map((bucket) => ({
      bucketStart: readString(bucket.bucket_start) ?? readString(bucket.bucketStart),
      departureAt: readString(bucket.departure_at) ?? readString(bucket.departureAt) ?? readString(bucket.bucket_start),
      available: nonNegativeInteger(bucket.available),
      sold: nonNegativeInteger(bucket.sold),
      minimumRemainingSeconds: nonNegativeInteger(
        bucket.minimum_remaining_seconds ?? bucket.minimumRemainingSeconds
      ),
      maximumRemainingSeconds: nonNegativeInteger(
        bucket.maximum_remaining_seconds ?? bucket.maximumRemainingSeconds
      )
    }))
    .filter((bucket) => bucket.bucketStart);
}

function normalizeOrder(response) {
  const order = response?.order && typeof response.order === "object" ? response.order : response;
  if (!order || typeof order !== "object") return {};
  return {
    orderId: readOrderId(order),
    state: typeof order.state === "string" ? order.state : typeof order.status === "string" ? order.status : undefined,
    product: readString(order.product),
    productName: readString(order.product_name),
    shelfBucketStart:
      readString(order.expiry_bucket_start) ??
      readString(order.expiryBucketStart) ??
      readString(order.shelf_bucket_start) ??
      readString(order.shelfBucketStart) ??
      readString(order.bucket_start),
    quantity: nonNegativeInteger(order.quantity),
    deliveredQuantity: nonNegativeInteger(order.delivered_quantity),
    reservationExpiresAt: readString(order.reservation_expires_at),
    createdAt: readString(order.created_at),
    completedAt: readString(order.completed_at),
    chargedFen: nonNegativeInteger(order.charged_fen),
    releasedFen: nonNegativeInteger(order.released_fen)
  };
}

function withCreatedOrderDefaults(order, previous) {
  return {
    ...order,
    state: order.state ?? "waiting_inventory",
    product: order.product ?? previous.product,
    productName: order.productName ?? previous.productName,
    shelfBucketStart: order.shelfBucketStart ?? previous.shelfBucketStart,
    quantity: order.quantity > 0 ? order.quantity : previous.quantity
  };
}

function normalizeImportResult(result) {
  if (!result || typeof result !== "object") throw new Error("Manager 导入结果格式无效");
  const summary = {
    status: result.status,
    total: nonNegativeInteger(result.total),
    imported: nonNegativeInteger(result.imported),
    poolEnabled: nonNegativeInteger(result.poolEnabled),
    refreshFailed: nonNegativeInteger(result.refreshFailed),
    notEligible: nonNegativeInteger(result.notEligible),
    authFailed: nonNegativeInteger(result.authFailed),
    importFailed: nonNegativeInteger(result.importFailed),
    accounts: Array.isArray(result.accounts) ? result.accounts.map(normalizeAccountBalance).filter(Boolean) : []
  };
  if (
    !["completed", "partial", "failed"].includes(summary.status) ||
    !summary.total ||
    summary.imported > summary.total ||
    summary.poolEnabled > summary.imported
  ) {
    throw new Error("Manager 导入结果计数无效");
  }
  return summary;
}

function normalizeAccountBalance(value) {
  if (!value || typeof value !== "object") return undefined;
  const status = ["ready", "refresh_failed", "not_eligible", "import_failed"].includes(value.status)
    ? value.status
    : value.poolEnabled === true
      ? "ready"
      : "not_eligible";
  return {
    accountId: readString(value.accountId),
    email: readString(value.email),
    planType: readString(value.planType),
    hourlyPercentage: percentageOrUndefined(value.hourlyPercentage),
    weeklyPercentage: percentageOrUndefined(value.weeklyPercentage),
    creditsBalance: readString(value.creditsBalance),
    poolEnabled: value.poolEnabled === true,
    status
  };
}

function percentageOrUndefined(value) {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : undefined;
}

function publicOrder(order, includeSecrets = false) {
  const result = {
    orderId: readString(order.orderId),
    state: readString(order.state),
    product: readString(order.product),
    productName: readString(order.productName),
    shelfBucketStart: readString(order.shelfBucketStart),
    quantity: nonNegativeInteger(order.quantity),
    deliveredQuantity: nonNegativeInteger(order.deliveredQuantity),
    reservationExpiresAt: readString(order.reservationExpiresAt),
    createdAt: readString(order.createdAt),
    completedAt: readString(order.completedAt),
    chargedFen: nonNegativeInteger(order.chargedFen),
    releasedFen: nonNegativeInteger(order.releasedFen),
    imported: order.imported === true,
    creationPending: order.creationPending === true,
    uncertain: order.uncertain === true,
    importResult: order.importResult,
    lastError: readString(order.lastError),
    lastImportError: readString(order.lastImportError),
    updatedAt: readString(order.updatedAt)
  };
  if (includeSecrets) result.idempotencyKey = readString(order.idempotencyKey);
  return result;
}

function orderStateLabel(state) {
  return {
    creating: "创建中",
    waiting_inventory: "等待补货",
    ready: "自动发货中",
    partial: "部分到货",
    uncertain: "结果待确认",
    completed: "已完成",
    cancelled: "已取消"
  }[state] ?? state ?? "未知";
}

function formatMoney(fen) {
  return `¥${(nonNegativeInteger(fen) / 100).toFixed(2)}`;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function createIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `bugteam-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readOrderId(value) {
  return readString(value?.order_id) ?? readString(value?.orderId) ?? readString(value?.id);
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeError(error, fallback, secret) {
  return safeErrorWithSecret(error, fallback, secret);
}

function safeErrorWithSecret(error, fallback, secret) {
  const message =
    error instanceof BugTeamApiError
      ? error.message
      : error instanceof Error && error.message
        ? error.message.slice(0, 240)
        : fallback;
  if (!secret) return message;
  const candidates = [secret];
  try {
    candidates.push(encodeURIComponent(secret));
  } catch {
    // The raw token is still redacted even if it contains malformed URI data.
  }
  return candidates.reduce((current, candidate) => current.split(candidate).join("[redacted]"), message);
}

module.exports = {
  BugTeamIntegration,
  DEFAULT_POLL_INTERVAL_MS,
  formatMoney,
  normalizeBalance,
  normalizeInventory,
  normalizeShelves,
  normalizeOrder,
  normalizeSub2Bundle,
  orderStateLabel,
  publicOrder,
  safeError
};
