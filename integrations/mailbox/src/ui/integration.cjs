"use strict";

const { Eight92Provider } = require("../core/providers/eight92.cjs");
const { BoyaProvider } = require("../core/providers/boya.cjs");
const { CdnsProvider } = require("../core/providers/cdns.cjs");
const { MailboxProviderRegistry } = require("../core/providers/index.cjs");
const { MailboxPool } = require("../mailbox/storage.cjs");
const { MailboxOperationCoordinator } = require("../operations/coordinator.cjs");
const { createMailboxPanelHtml, MAILBOX_PANEL_VIEW_TYPE } = require("./panel.cjs");

const INTEGRATION_ID = "mailbox";
const SELECTED_MAILBOX_KEY = "codexAccounts.mailbox.selected.v1";
const OPERATION_LABELS = {
  query: "查询邮件",
  wait: "接收验证码",
  renewal: "人工续期"
};

class MailboxIntegration {
  constructor(vscode, context, api, { providers } = {}) {
    this.vscode = vscode;
    this.context = context;
    this.api = api;
    this.events = new vscode.EventEmitter();
    this.providerInstances = providers ?? [
      new Eight92Provider().asProvider(),
      new BoyaProvider().asProvider(),
      new CdnsProvider().asProvider()
    ];
    this.providers = new MailboxProviderRegistry(this.providerInstances);
    this.pool = new MailboxPool({ metadataStore: context.globalState, secretStore: context.secrets });
    this.coordinator = new MailboxOperationCoordinator({
      pool: this.pool,
      providers: this.providers,
      onOperationChange: () => { void this.publishPanelState().catch(() => undefined); }
    });
    this.registration = undefined;
    this.panel = undefined;
    this.selectedMailboxId = undefined;
    // mailbox id -> opaque Manager OAuth operation id. Keeping this separate
    // from provider operations lets mailbox query/renewal continue in parallel
    // while still allowing the shared Stop action to cancel OAuth import.
    this.codexImports = new Map();
    this.loadError = undefined;
    this.disposed = false;
    this.panelDisposables = [];
  }

  async initialize() {
    this.selectedMailboxId = await this.context.globalState.get(SELECTED_MAILBOX_KEY);
    try {
      // Activation is local-only: no provider is queried and no timer starts.
      await this.pool.load();
      if (!this.selectedMailboxId || !this.pool.listMetadata().some((mailbox) => mailbox.id === this.selectedMailboxId)) {
        this.selectedMailboxId = this.pool.listMetadata()[0]?.id;
      }
    } catch (error) {
      this.loadError = safeError(error, "邮箱池本地状态不可用");
    }

    this.context.subscriptions.push(
      this.vscode.commands.registerCommand("codexAccountsMailbox.open", () => this.openPanel())
    );
    if (this.api) {
      this.registration = this.api.registerDashboardIntegration({
        id: INTEGRATION_ID,
        getViewModel: () => this.getViewModel(),
        runAction: (actionId) => this.runAction(actionId),
        onDidChange: this.events.event
      });
    }
    this.publish();
  }

  getViewModel() {
    return {
      id: INTEGRATION_ID,
      title: "Mailbox",
      status: this.loadError ? "error" : "ready",
      statusMessage: this.loadError ? this.loadError : "独立邮箱面板",
      actions: [
        { id: "open", label: "Mailbox", enabled: !this.loadError, tone: "primary", tooltip: "打开独立 Mailbox 面板" }
      ]
    };
  }

  async runAction(actionId) {
    if (actionId !== "open") {
      throw new Error("Unsupported Mailbox action.");
    }
    await this.openPanel();
  }

  async openPanel() {
    if (this.disposed) {
      return;
    }
    if (this.panel) {
      this.panel.reveal(this.vscode.ViewColumn.Beside, false);
      await this.publishPanelState();
      return;
    }

    this.panel = this.vscode.window.createWebviewPanel(
      MAILBOX_PANEL_VIEW_TYPE,
      "Mailbox",
      { viewColumn: this.vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = createMailboxPanelHtml();
    this.panelDisposables.push(
      this.panel.webview.onDidReceiveMessage((message) => this.handlePanelMessage(message)),
      this.panel.onDidDispose(() => this.closePanel())
    );
    await this.publishPanelState();
    this.publish();
  }

  async handlePanelMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    try {
      switch (message.action) {
        case "ready":
        case "refresh":
          await this.publishPanelState();
          return;
        case "select":
          await this.selectMailbox(message.mailboxId);
          return;
        case "import":
          await this.importMailbox(message);
          return;
        case "codexImport":
          await this.runCodexImport(message.mailboxId);
          return;
        case "edit":
          await this.editMailbox(message);
          return;
        case "delete":
          await this.deleteMailbox(message.mailboxId);
          return;
        case "query":
          await this.runQuery(message.mailboxId);
          return;
        case "batchQuery":
          await this.runQueryMany(message.mailboxIds);
          return;
        case "wait":
          await this.runWait(message.mailboxId);
          return;
        case "batchWait":
          await this.runWaitMany(message.mailboxIds);
          return;
        case "renewal":
          await this.runRenewal(message.mailboxId);
          return;
        case "batchRenewal":
          await this.runRenewalMany(message.mailboxIds);
          return;
        case "batchStop": {
          const mailboxIds = this.requireMailboxIds(message.mailboxIds, "请先选择要停止的邮箱");
          const stopped = await this.stopMailboxes(mailboxIds);
          await this.publishPanelState();
          this.postPanelMessage({
            type: "toast",
            level: stopped ? "success" : "warning",
            action: "batchStop",
            mailboxIds,
            message: stopped ? `已停止 ${mailboxIds.length} 个邮箱的操作` : "选中的邮箱没有可停止的操作"
          });
          return;
        }
        case "batchDelete":
          await this.deleteMailboxes(message.mailboxIds);
          return;
        case "stop":
          {
          const stopped = await this.stopMailbox(message.mailboxId);
          await this.publishPanelState();
          this.postPanelMessage({
            type: "toast",
            level: stopped ? "success" : "warning",
            action: "stop",
            mailboxId: typeof message.mailboxId === "string" ? message.mailboxId : undefined,
            message: stopped ? "邮箱操作已停止" : "没有可停止的邮箱操作"
          });
          return;
          }
        default:
          throw new Error("Unsupported Mailbox panel action.");
      }
    } catch (error) {
      this.postPanelMessage({
        type: "toast",
        level: "error",
        action: typeof message.action === "string" ? message.action : undefined,
        mailboxId: typeof message.mailboxId === "string" ? message.mailboxId : undefined,
        message: safeError(error, "Mailbox 操作失败")
      });
      await this.publishPanelState();
    }
  }

  async selectMailbox(id) {
    if (!this.pool.isLoaded() || !this.pool.listMetadata().some((mailbox) => mailbox.id === id)) {
      return;
    }
    this.selectedMailboxId = id;
    await this.context.globalState.update(SELECTED_MAILBOX_KEY, id);
    await this.publishPanelState();
  }

  async importMailbox(message) {
    const provider = this.providers.get(typeof message.providerId === "string" ? message.providerId : "");
    if (!provider) {
      throw new Error("请选择有效的邮箱来源");
    }
    const result = await this.pool.importProvider({
      provider,
      input: typeof message.input === "string" ? message.input : "",
      displayName: typeof message.displayName === "string" ? message.displayName : ""
    });
    if (result.imported.length > 0) {
      this.selectedMailboxId = result.imported[0].id;
      await this.context.globalState.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
    this.postPanelMessage({ type: "toast", level: "success", mailboxId: this.selectedMailboxId, message: `已导入 ${result.imported.length} 个邮箱` });
    }
    if (result.failed.length > 0) {
      this.postPanelMessage({ type: "toast", level: "warning", mailboxId: this.selectedMailboxId, message: `有 ${result.failed.length} 行未导入：${result.failed[0].message}` });
    }
    await this.publishPanelState();
  }

  async editMailbox(message) {
    const id = this.requireMailboxId(message.mailboxId);
    const metadata = this.pool.listMetadata().find((mailbox) => mailbox.id === id);
    const requestedProviderId = typeof message.providerId === "string" && message.providerId ? message.providerId : metadata?.providerId;
    const provider = this.providers.get(requestedProviderId);
    const mailbox = await this.pool.updateAccount(id, {
      provider,
      input: typeof message.input === "string" ? message.input : "",
      displayName: typeof message.displayName === "string" ? message.displayName : "",
      providerId: requestedProviderId
    });
    this.selectedMailboxId = mailbox.id;
    await this.context.globalState.update(SELECTED_MAILBOX_KEY, mailbox.id);
    this.postPanelMessage({ type: "toast", level: "success", action: "edit", mailboxId: id, message: "邮箱信息已更新" });
    await this.publishPanelState();
    this.publish();
  }

  async deleteMailbox(id) {
    const mailboxId = this.requireMailboxId(id);
    if (this.coordinator.isActive(mailboxId) || this.codexImports.has(mailboxId)) {
      const stopped = await this.stopMailbox(mailboxId);
      if (!stopped && (this.coordinator.isActive(mailboxId) || this.codexImports.has(mailboxId))) {
        throw new Error("请先停止邮箱当前操作");
      }
    }
    await this.pool.deleteAccount(mailboxId);
    if (this.selectedMailboxId === mailboxId) {
      this.selectedMailboxId = this.pool.listMetadata()[0]?.id;
      await this.context.globalState.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
    }
    this.postPanelMessage({ type: "toast", level: "success", action: "delete", mailboxId, message: "邮箱已删除" });
    await this.publishPanelState();
    this.publish();
  }

  async runQuery(mailboxId) {
    const id = this.requireSelectedId(mailboxId);
    void this.runOperation(id, "query", () => this.coordinator.queryOnce([id])).catch(() => undefined);
    await this.publishPanelState();
  }

  async runQueryMany(mailboxIds) {
    const ids = this.requireMailboxIds(mailboxIds, "请先选择要查询的邮箱");
    void this.runOperation(ids, "query", () => this.coordinator.queryOnce(ids)).catch(() => undefined);
    await this.publishPanelState();
  }

  async runWait(mailboxId) {
    const id = this.requireSelectedId(mailboxId);
    void this.runOperation(id, "wait", () => this.coordinator.waitForCodes([id], { timeoutMs: 120_000, pollMs: 5_000 })).catch(() => undefined);
    await this.publishPanelState();
  }

  async runWaitMany(mailboxIds) {
    const ids = this.requireMailboxIds(mailboxIds, "请先选择要监听的邮箱");
    void this.runOperation(ids, "wait", () => this.coordinator.waitForCodes(ids, { timeoutMs: 120_000, pollMs: 5_000 })).catch(() => undefined);
    await this.publishPanelState();
  }

  async runRenewal(mailboxId) {
    const id = this.requireSelectedId(mailboxId);
    void this.runOperation(id, "renewal", () => this.coordinator.renew([id])).catch(() => undefined);
    await this.publishPanelState();
  }

  async runRenewalMany(mailboxIds) {
    const ids = this.requireMailboxIds(mailboxIds, "请先选择要续期的邮箱");
    void this.runOperation(ids, "renewal", () => this.coordinator.renew(ids)).catch(() => undefined);
    await this.publishPanelState();
  }

  async runCodexImport(mailboxId) {
    const id = this.requireSelectedId(mailboxId);
    if (typeof this.api?.startOAuthAccountImport !== "function") {
      throw new Error("当前 Manager 不支持 Codex OAuth 导入");
    }
    const mailbox = this.pool.listMetadata().find((item) => item.id === id);
    if (!mailbox || this.codexImports.has(id)) {
      throw new Error("该邮箱正在进行 Codex 导入");
    }
    const operationId = `mailbox-codex-import:${id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    this.codexImports.set(id, operationId);
    void this.runCodexImportOperation(mailbox, operationId).catch(() => undefined);
    await this.publishPanelState();
  }

  async runCodexImportOperation(mailbox, operationId) {
    try {
      const result = await this.api.startOAuthAccountImport({
        operationId,
        expectedEmail: mailbox.address,
        clipboardText: mailbox.address
      });
      if (this.codexImports.get(mailbox.id) !== operationId) {
        return;
      }
      const suffix = result.quotaRefreshed ? "并已刷新额度" : "，额度刷新未完成";
      this.postPanelMessage({
        type: "toast",
        level: result.quotaRefreshed ? "success" : "warning",
        action: "codexImport",
        mailboxId: mailbox.id,
        message: `Codex 账号已导入${suffix}`
      });
    } catch (error) {
      // A user stop is reported by the shared Stop action. Avoid a second
      // misleading error toast when the Manager rejects the cancelled OAuth.
      if (this.codexImports.get(mailbox.id) === operationId) {
        this.postPanelMessage({
          type: "toast",
          level: "error",
          action: "codexImport",
          mailboxId: mailbox.id,
          message: safeError(error, "Codex 账号导入失败")
        });
      }
      throw error;
    } finally {
      if (this.codexImports.get(mailbox.id) === operationId) {
        this.codexImports.delete(mailbox.id);
      }
      await this.publishPanelState();
      this.publish();
    }
  }

  async runOperation(id, kind, operation) {
    const ids = Array.isArray(id) ? id : [id];
    const notificationTarget = ids.length === 1 ? { mailboxId: ids[0] } : { mailboxIds: ids };
    try {
      const result = await operation();
      const failed = result.results.filter((entry) => !entry.ok).length;
      if (failed > 0 && !result.stopped) {
        const firstError = result.results.find((entry) => !entry.ok)?.error;
        const reason = firstError?.message ? `：${safeError(firstError.message, "")}` : "";
        this.postPanelMessage({
          type: "toast",
          level: "warning",
          action: kind,
          ...notificationTarget,
          message: `${OPERATION_LABELS[kind]}有 ${failed}/${ids.length} 个邮箱失败${reason}`
        });
      }
      this.postPanelMessage({ type: "operation-complete", action: kind, ...notificationTarget });
      return result;
    } catch (error) {
      this.postPanelMessage({ type: "toast", level: "error", action: kind, ...notificationTarget, message: safeError(error, "Mailbox 操作失败") });
      throw error;
    } finally {
      await this.publishPanelState();
      this.publish();
    }
  }

  async stopMailbox(id) {
    const mailboxId = typeof id === "string" && id ? id : undefined;
    let stopped = false;

    const cancelOAuth = this.api?.cancelOAuthAccountImport;
    const imports = mailboxId
      ? [[mailboxId, this.codexImports.get(mailboxId)]]
      : [...this.codexImports.entries()];
    if (typeof cancelOAuth === "function") {
      for (const [currentMailboxId, operationId] of imports) {
        if (typeof operationId !== "string" || !operationId) {
          continue;
        }
        cancelOAuth(operationId);
        this.codexImports.delete(currentMailboxId);
        stopped = true;
      }
    }

    if (!this.coordinator.isActive(mailboxId)) {
      return stopped;
    }

    const deadline = Date.now() + 300;
    do {
      if (this.coordinator.stop(mailboxId)) {
        return true;
      }
      if (Date.now() >= deadline) {
        return stopped;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (true);
  }

  async stopMailboxes(ids) {
    const mailboxIds = this.requireMailboxIds(ids, "请先选择要停止的邮箱");
    let stopped = false;
    for (const mailboxId of mailboxIds) {
      stopped = (await this.stopMailbox(mailboxId)) || stopped;
    }
    return stopped;
  }

  async deleteMailboxes(ids, { action = "batchDelete" } = {}) {
    const mailboxIds = this.requireMailboxIds(ids, "请先选择要删除的邮箱");
    for (const mailboxId of mailboxIds) {
      if (this.coordinator.isActive(mailboxId) || this.codexImports.has(mailboxId)) {
        const stopped = await this.stopMailbox(mailboxId);
        if (!stopped && (this.coordinator.isActive(mailboxId) || this.codexImports.has(mailboxId))) {
          throw new Error("请先停止邮箱当前操作");
        }
      }
    }
    for (const mailboxId of mailboxIds) {
      await this.pool.deleteAccount(mailboxId);
    }
    if (mailboxIds.includes(this.selectedMailboxId)) {
      this.selectedMailboxId = this.pool.listMetadata()[0]?.id;
      await this.context.globalState.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
    }
    const target = mailboxIds.length === 1 ? { mailboxId: mailboxIds[0] } : { mailboxIds };
    this.postPanelMessage({
      type: "toast",
      level: "success",
      action,
      ...target,
      message: `已删除 ${mailboxIds.length} 个邮箱`
    });
    await this.publishPanelState();
    this.publish();
  }

  requireSelectedId(id) {
    const selected = this.requireMailboxId(id || this.selectedMailboxId, "请先在列表中选择一个邮箱");
    this.selectedMailboxId = selected;
    return selected;
  }

  requireMailboxId(id, message = "邮箱不存在") {
    if (typeof id !== "string" || !id || !this.pool.listMetadata().some((mailbox) => mailbox.id === id)) {
      throw new Error(message);
    }
    return id;
  }

  requireMailboxIds(ids, message = "邮箱不存在") {
    const candidates = Array.isArray(ids) ? ids : [ids];
    const known = new Set(this.pool.listMetadata().map((mailbox) => mailbox.id));
    const normalized = [...new Set(candidates.filter((id) => typeof id === "string" && known.has(id)))];
    if (normalized.length === 0) {
      throw new Error(message);
    }
    return normalized;
  }

  async getPanelState() {
    const mailboxes = this.pool.isLoaded() ? this.pool.listMetadata() : [];
    const selectedMailbox = mailboxes.find((mailbox) => mailbox.id === this.selectedMailboxId);
    const detail = selectedMailbox ? await this.pool.getDetail(selectedMailbox.id) : undefined;
    const codexImportState = await this.getCodexImportState();
    return {
      mailboxes: mailboxes.map(toPanelMailbox),
      selectedMailboxId: selectedMailbox?.id,
      selected: selectedMailbox ? { mailbox: selectedMailbox, detail } : undefined,
      operations: this.coordinator.getActiveOperations(),
      codexImports: [...this.codexImports.keys()],
      codexImportCancellable: typeof this.api?.cancelOAuthAccountImport === "function",
      providers: this.providers.list().map(sanitizeProvider),
      codexImportAvailable: codexImportState.available,
      managedAccountEmails: codexImportState.emails
    };
  }

  async getCodexImportState() {
    if (
      typeof this.api?.getManagedAccountEmails !== "function" ||
      typeof this.api.startOAuthAccountImport !== "function"
    ) {
      return { available: false, emails: [] };
    }
    try {
      const emails = await this.api.getManagedAccountEmails();
      return {
        available: true,
        emails: Array.isArray(emails) ? emails.filter((email) => typeof email === "string") : []
      };
    } catch {
      return { available: false, emails: [] };
    }
  }

  async publishPanelState() {
    if (!this.panel || this.disposed) {
      return;
    }
    this.postPanelMessage({ type: "state", state: await this.getPanelState() });
  }

  postPanelMessage(message) {
    if (this.panel) {
      void this.panel.webview.postMessage(message);
    }
  }

  closePanel() {
    for (const disposable of this.panelDisposables.splice(0)) {
      disposable?.dispose?.();
    }
    this.panel = undefined;
    this.publish();
  }

  publish() {
    if (!this.disposed) {
      this.events.fire();
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.coordinator.stop();
    if (typeof this.api?.cancelOAuthAccountImport === "function") {
      for (const operationId of this.codexImports.values()) {
        this.api.cancelOAuthAccountImport(operationId);
      }
    }
    this.codexImports.clear();
    for (const disposable of this.panelDisposables.splice(0)) {
      disposable?.dispose?.();
    }
    this.panel?.dispose?.();
    this.panel = undefined;
    this.registration?.dispose();
    this.events.dispose();
  }
}

function sanitizeProvider(provider) {
  return {
    id: provider.id,
    displayName: provider.displayName,
    capabilities: provider.capabilities,
    importSchema: provider.importSchema
  };
}

function toPanelMailbox(mailbox) {
  // The list receives only identity and summary fields. Full message bodies
  // are fetched from the local detail key for the selected mailbox alone.
  const { latestMessage: _latestMessage, ...summary } = mailbox;
  return summary;
}

function safeError(error, fallback) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message || fallback).replace(/[\r\n\t]+/gu, " ").slice(0, 160);
}

module.exports = { INTEGRATION_ID, MailboxIntegration, safeError };
