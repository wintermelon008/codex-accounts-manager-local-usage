"use strict";

const { Eight92Provider } = require("../core/providers/eight92.cjs");
const { BoyaProvider } = require("../core/providers/boya.cjs");
const { CdnsProvider } = require("../core/providers/cdns.cjs");
const { MailboxProviderRegistry } = require("../core/providers/index.cjs");
const { MailboxPool } = require("../mailbox/storage.cjs");
const { MailboxOperationCoordinator } = require("../operations/coordinator.cjs");
const {
  createMailboxPanelHtml,
  createRegistrationPanelHtml,
  MAILBOX_PANEL_VIEW_TYPE,
  REGISTRATION_PANEL_VIEW_TYPE
} = require("./panel.cjs");
const { RegistrationManager } = require("../operations/registration-manager.cjs");
const { STATES } = require("../operations/registration-flow.cjs");
const { RegistrationEmailCodeWatcher } = require("../operations/registration-email-code.cjs");
const { createRegistrationDiagnostics } = require("../operations/registration-diagnostics.cjs");
const { RegistrationKeyPool } = require("../operations/registration-key-pool.cjs");
const {
  getRegistrationPhoneSource,
  listRegistrationPhoneSources
} = require("../operations/registration-phone-sources.cjs");

const INTEGRATION_ID = "mailbox";
const REGISTRATION_INTEGRATION_ID = "mailbox-registration";
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
    this.registrationAssistantRegistration = undefined;
    this.panel = undefined;
    this.registrationPanel = undefined;
    this.selectedMailboxId = undefined;
    // mailbox id -> opaque Manager OAuth operation id. Keeping this separate
    // from provider operations lets mailbox query/renewal continue in parallel
    // while still allowing the shared Stop action to cancel OAuth import.
    this.codexImports = new Map();
    this.registrationManager = new RegistrationManager({
      maxConcurrent: 3,
      startOAuthImport: typeof this.api?.startOAuthAccountImport === "function"
        ? (options) => this.api.startOAuthAccountImport(options)
        : undefined,
      cancelOAuthImport: typeof this.api?.cancelOAuthAccountImport === "function"
        ? (operationId) => this.api.cancelOAuthAccountImport(operationId)
        : undefined,
    });
    this.registrationDiagnostics = createRegistrationDiagnostics(vscode, context);
    this.registrationEmailWatchers = new Map();
    this.registrationKeyPool = new RegistrationKeyPool({ secretStore: context.secrets });
    this.registrationPhoneKeyClaims = new Map();
    this.registrationManager.on("stateChange", (event) => {
      if (event?.state === STATES.STARTING) {
        this.startRegistrationEmailWatcher(event.sessionId);
      }
      if ([STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED].includes(event?.state)) {
        this.stopRegistrationEmailWatcher(event.sessionId);
      }
      void this.syncRegistrationPhoneKey(event).catch((error) => {
        this.postPanelMessage({
          type: "toast",
          level: "error",
          action: "registrationPhoneKeyPool",
          message: safeError(error, "接码平台 Key 状态更新失败")
        });
      });
      void this.publishPanelState().catch(() => undefined);
    });
    this.registrationManager.on("log", (entry) => {
      const diagnostic = this.registrationDiagnostics.record(entry);
      this.postPanelMessage({ type: "registrationLog", ...diagnostic });
    });
    this.loadError = undefined;
    this.disposed = false;
    this.panelDisposables = [];
    this.registrationPanelDisposables = [];
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
      this.vscode.commands.registerCommand("codexAccountsMailbox.open", () => this.openPanel()),
      this.vscode.commands.registerCommand("codexAccountsMailbox.openRegistrationDiagnostics", () => {
        this.registrationDiagnostics.show();
      })
    );
    if (this.api) {
      // Register the new standalone entry first so older lightweight test or
      // host adapters that retain one registration continue to resolve the
      // original Mailbox integration below.
      this.registrationAssistantRegistration = this.api.registerDashboardIntegration({
        id: REGISTRATION_INTEGRATION_ID,
        getViewModel: () => this.getRegistrationViewModel(),
        runAction: (actionId) => this.runRegistrationAction(actionId),
        onDidChange: this.events.event
      });
      this.registration = this.api.registerDashboardIntegration({
        id: INTEGRATION_ID,
        getViewModel: () => this.getViewModel(),
        runAction: (actionId) => this.runAction(actionId),
        onDidChange: this.events.event
      });
    }
    this.publish();
  }

  getRegistrationViewModel() {
    const hasSessions = this.registrationManager.getAllSessions().length > 0;
    return {
      id: REGISTRATION_INTEGRATION_ID,
      title: "注册助手",
      status: this.loadError ? "error" : hasSessions ? "active" : "ready",
      statusMessage: this.loadError ? this.loadError : "独立注册助手面板",
      topButton: {
        actionId: "open",
        label: "注册助手",
        tooltip: "打开独立注册助手面板",
        icon: "default"
      },
      actions: [
        { id: "open", label: "注册助手", enabled: !this.loadError, tone: "primary", tooltip: "打开独立注册助手面板" }
      ]
    };
  }

  getViewModel() {
    return {
      id: INTEGRATION_ID,
      title: "Mailbox",
      status: this.loadError ? "error" : "ready",
      statusMessage: this.loadError ? this.loadError : "独立邮箱面板",
      topButton: {
        actionId: "open",
        label: "Mailbox",
        tooltip: "打开独立 Mailbox 面板",
        icon: "mail"
      },
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

  async runRegistrationAction(actionId) {
    if (actionId !== "open") {
      throw new Error("Unsupported registration assistant action.");
    }
    await this.openRegistrationPanel();
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

  async openRegistrationPanel() {
    if (this.disposed) {
      return;
    }
    if (this.registrationPanel) {
      this.registrationPanel.reveal(this.vscode.ViewColumn.Beside, false);
      await this.publishPanelState();
      return;
    }

    this.registrationPanel = this.vscode.window.createWebviewPanel(
      REGISTRATION_PANEL_VIEW_TYPE,
      "注册助手",
      { viewColumn: this.vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.registrationPanel.webview.html = createRegistrationPanelHtml();
    this.registrationPanelDisposables.push(
      this.registrationPanel.webview.onDidReceiveMessage((message) => this.handlePanelMessage(message)),
      this.registrationPanel.onDidDispose(() => this.closeRegistrationPanel())
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
        case "registrationCreate":
          await this.createRegistrationSession(message);
          return;
        case "registrationStart":
          await this.startRegistrationSession(message.sessionId);
          return;
        case "registrationSubmitEmailCode":
          await this.submitRegistrationEmailCode(message.sessionId, message.code);
          return;
        case "registrationRefreshEmailCode":
          await this.refreshRegistrationEmailCode(message.sessionId);
          return;
        case "registrationSubmitPhone":
          await this.submitRegistrationPhone(message.sessionId, message.phoneNumber);
          return;
        case "registrationSubmitOtp":
          await this.submitRegistrationOtp(message.sessionId, message.otp);
          return;
        case "registrationAuthorize":
          await this.authorizeRegistrationSession(message.sessionId);
          return;
        case "registrationAcquirePhone":
          await this.acquireRegistrationPhone(message.sessionId, {
            sourceId: message.sourceId,
            keyId: message.keyId,
            cardCode: message.cardCode
          });
          return;
        case "registrationConfirmPhone":
          await this.confirmRegistrationPhone(message.sessionId);
          return;
        case "registrationReplacePhone":
          await this.replaceRegistrationPhone(message.sessionId);
          return;
        case "registrationCancelPhone":
          await this.cancelRegistrationPhone(message.sessionId);
          return;
        case "registrationAddPhoneKeys":
          await this.addRegistrationPhoneKeys(message.input);
          return;
        case "registrationRemovePhoneKey":
          await this.removeRegistrationPhoneKey(message.keyId);
          return;
        case "registrationRequestNewPhone":
          await this.requestRegistrationNewPhone(message.sessionId);
          return;
        case "registrationCancel":
          await this.cancelRegistrationSession(message.sessionId);
          return;
        case "registrationCleanup":
          this.stopRegistrationEmailWatcher(message.sessionId);
          this.registrationManager.cleanupSession(message.sessionId);
          await this.publishPanelState();
          return;
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

  async createRegistrationSession(message) {
    const email = typeof message.email === "string" ? message.email.trim() : "";
    if (!email) {
      throw new Error("请填写邮箱");
    }
    const codexImportState = await this.getCodexImportState();
    if (codexImportState.managedEmailsAvailable && codexImportState.emails.some((item) => normalizeEmail(item) === normalizeEmail(email))) {
      throw new Error("该邮箱已经导入 Codex 账号，请选择其他邮箱");
    }
    const sessionId = this.registrationManager.createSession({
      email,
      password: typeof message.password === "string" && message.password ? message.password : "Chatgpt189687",
      name: typeof message.name === "string" && message.name ? message.name : "jdd",
      age: Number.isFinite(message.age) ? message.age : 24
    });
    // “开始注册”按钮应同时启动已创建的浏览器辅助会话；手机号/验证码仍由用户手动填写。
    await this.startRegistrationSession(sessionId);
    await this.publishPanelState();
    return sessionId;
  }

  async startRegistrationSession(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    void this.registrationManager.startSession(id).catch((error) => {
      this.postPanelMessage({
        type: "toast",
        level: "error",
        action: "registrationStart",
        message: safeError(error, "注册流程启动失败")
      });
    });
    await this.publishPanelState();
  }

  startRegistrationEmailWatcher(sessionId) {
    if (typeof sessionId !== "string" || this.registrationEmailWatchers.has(sessionId)) {
      return;
    }
    const session = this.registrationManager.getSessionState(sessionId);
    if (!session || [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED].includes(session.state)) {
      return;
    }

    const watcher = new RegistrationEmailCodeWatcher({
      pool: this.pool,
      providers: this.providers,
      onStateChange: (emailCode) => {
        try {
          this.registrationManager.setEmailCodeState(sessionId, emailCode);
        } catch {
          // The registration session may be cleaned while a provider request is finishing.
        }
      }
    });
    this.registrationEmailWatchers.set(sessionId, watcher);
    const promise = watcher.start(session.email);
    void promise
      .catch((error) => {
        try {
          this.registrationManager.setEmailCodeState(sessionId, {
            phase: "error",
            running: false,
            error: safeError(error, "邮箱验证码查询失败"),
            message: "邮箱验证码查询失败"
          });
        } catch {
          // The registration session may no longer exist.
        }
      })
      .finally(() => {
        if (this.registrationEmailWatchers.get(sessionId) === watcher && !watcher.isRunning()) {
          this.registrationEmailWatchers.delete(sessionId);
        }
      });
  }

  stopRegistrationEmailWatcher(sessionId) {
    const watcher = this.registrationEmailWatchers.get(sessionId);
    if (!watcher) {
      return false;
    }
    watcher.stop();
    this.registrationEmailWatchers.delete(sessionId);
    return true;
  }

  async refreshRegistrationEmailCode(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const session = this.registrationManager.getSessionState(id);
    if (!session) throw new Error("注册会话不存在");
    let watcher = this.registrationEmailWatchers.get(id);
    if (!watcher) {
      this.startRegistrationEmailWatcher(id);
      watcher = this.registrationEmailWatchers.get(id);
    }
    if (!watcher) throw new Error("当前注册会话没有可刷新的邮箱查询任务");
    void watcher.refresh(session.email, {
      ignoreCode: session.emailCode?.code,
      ignoreReceivedAt: session.emailCode?.receivedAt
    }).catch((error) => {
      this.postPanelMessage({
        type: "toast",
        level: "error",
        action: "registrationRefreshEmailCode",
        message: safeError(error, "邮箱验证码刷新失败")
      });
    });
    await this.publishPanelState();
  }

  async submitRegistrationPhone(sessionId, phone) {
    const id = this.requireRegistrationSessionId(sessionId);
    if (typeof phone !== "string" || !phone.trim()) {
      throw new Error("请粘贴从您的接码平台获取的手机号");
    }
    const result = await this.registrationManager.submitPhoneNumber(id, phone.trim());
    if (result?.accepted === false) {
      this.postPanelMessage({
        type: "toast",
        level: "warning",
        action: "registrationSubmitPhone",
        message: result.reason || "号码未通过，请更换号码后重试。"
      });
    }
    await this.publishPanelState();
  }

  async submitRegistrationEmailCode(sessionId, code) {
    const id = this.requireRegistrationSessionId(sessionId);
    if (typeof code !== "string" || !code.trim()) {
      throw new Error("请填写邮箱验证码");
    }
    await this.registrationManager.submitEmailVerificationCode(id, code.trim());
    await this.publishPanelState();
  }

  async submitRegistrationOtp(sessionId, code) {
    const id = this.requireRegistrationSessionId(sessionId);
    if (typeof code !== "string" || !code.trim()) {
      throw new Error("请粘贴从您的接码平台获取的验证码");
    }
    const result = await this.registrationManager.submitVerificationCode(id, code.trim());
    if (result?.accepted) {
      this.postPanelMessage({
        type: "toast",
        level: "success",
        action: "registrationComplete",
        message: "注册表单已提交完成。请使用下方“Codex 导入”按钮完成登录导入。"
      });
    }
    await this.publishPanelState();
  }

  async authorizeRegistrationSession(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const result = await this.registrationManager.authorizeSession(id);
    if (result?.accepted) {
      this.postPanelMessage({
        type: "toast",
        level: result.oauthPending ? "warning" : "success",
        action: "registrationComplete",
        message: result.message || "注册和授权已完成。"
      });
    }
    await this.publishPanelState();
  }

  async acquireRegistrationPhone(sessionId, selection = {}) {
    const id = this.requireRegistrationSessionId(sessionId);
    const legacyCardCode = typeof selection === "string" ? selection.trim() : typeof selection?.cardCode === "string" ? selection.cardCode.trim() : "";
    const sourceId = typeof selection === "string" ? "liye" : String(selection?.sourceId || "liye").trim().toLowerCase();
    const source = getRegistrationPhoneSource(sourceId);
    if (!source) {
      throw new Error("请选择有效的接码平台来源");
    }
    if (legacyCardCode) {
      const result = await this.registrationManager.acquirePhoneNumber(id, legacyCardCode, { sourceId });
      if (result?.phase === "error") throw new Error(result.error || "取号失败");
      await this.publishPanelState();
      return;
    }
    const keyId = typeof selection?.keyId === "string" ? selection.keyId.trim() : "";
    const owner = this.registrationPhoneKeyOwner(id);
    const claimed = await this.registrationKeyPool.claim(keyId, owner);
    this.registrationPhoneKeyClaims.set(id, { keyId: claimed.id, owner, sourceId: source.id });
    try {
      const result = await this.registrationManager.acquirePhoneNumber(id, claimed.code, {
        sourceId: source.id,
        cardKeyId: claimed.id,
        cardMasked: claimed.masked
      });
      if (result?.phase === "error") {
        await this.releaseRegistrationPhoneKey(id);
        throw new Error(result.error || "取号失败");
      }
      await this.publishPanelState();
    } catch (error) {
      await this.releaseRegistrationPhoneKey(id);
      throw error;
    }
  }

  async confirmRegistrationPhone(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const result = await this.registrationManager.confirmPhoneNumber(id);
    if (result?.phase === "error") {
      throw new Error(result.error || "开始读取验证码失败");
    }
    await this.publishPanelState();
  }

  async replaceRegistrationPhone(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const result = await this.registrationManager.replacePhoneNumber(id);
    if (result?.phase === "error") {
      throw new Error(result.error || "重新取号失败");
    }
    await this.publishPanelState();
  }

  async cancelRegistrationPhone(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const result = await this.registrationManager.cancelPhoneNumber(id);
    if (result?.phase === "error") {
      throw new Error(result.error || "取消取号失败");
    }
    await this.releaseRegistrationPhoneKey(id);
    await this.publishPanelState();
  }

  async addRegistrationPhoneKeys(input) {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error("请粘贴至少一个接码平台 Key，每行一个");
    }
    const result = await this.registrationKeyPool.add(input);
    this.postPanelMessage({
      type: "toast",
      level: result.added > 0 ? "success" : "warning",
      action: "registrationAddPhoneKeys",
      message: result.added > 0 ? `已加入 ${result.added} 个接码平台 Key` : "没有加入新的接码平台 Key"
    });
    await this.publishPanelState();
  }

  async removeRegistrationPhoneKey(keyId) {
    const result = await this.registrationKeyPool.remove(keyId);
    this.postPanelMessage({
      type: "toast",
      level: "success",
      action: "registrationRemovePhoneKey",
      message: "接码平台 Key 已删除"
    });
    await this.publishPanelState();
    return result;
  }

  registrationPhoneKeyOwner(sessionId) {
    return `registration:${sessionId}`;
  }

  async releaseRegistrationPhoneKey(sessionId) {
    const claim = this.registrationPhoneKeyClaims.get(sessionId);
    if (!claim) return false;
    this.registrationPhoneKeyClaims.delete(sessionId);
    return this.registrationKeyPool.release(claim.keyId, claim.owner);
  }

  async syncRegistrationPhoneKey(event) {
    const sessionId = typeof event?.sessionId === "string" ? event.sessionId : "";
    if (!sessionId) return;
    const phoneOrder = event?.phoneOrder;
    const order = phoneOrder?.order;
    const smsCode = typeof order?.smsCode === "string" ? order.smsCode.trim() : "";
    const claim = this.registrationPhoneKeyClaims.get(sessionId);
    if (!claim) return;
    if (smsCode) {
      const consumed = await this.registrationKeyPool.consume(claim.keyId, claim.owner);
      if (consumed) {
        this.registrationPhoneKeyClaims.delete(sessionId);
        this.postPanelMessage({
          type: "toast",
          level: "success",
          action: "registrationPhoneCodeReceived",
          message: "已收到短信验证码，所用接码平台 Key 已从池中移除"
        });
        await this.publishPanelState();
      }
      return;
    }
    const terminalPhonePhase = ["cancelled", "error", "timed_out"].includes(phoneOrder?.phase);
    const terminalSession = [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED].includes(event?.state);
    const currentPhoneOrder = phoneOrder || this.registrationManager.getSessionState(sessionId)?.phoneOrder;
    const phoneStillRunning = currentPhoneOrder?.running === true;
    if (terminalPhonePhase || (terminalSession && !phoneStillRunning)) {
      await this.releaseRegistrationPhoneKey(sessionId);
      await this.publishPanelState();
    }
  }

  async requestRegistrationNewPhone(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    this.registrationManager.requestNewPhone(id);
    await this.publishPanelState();
  }

  async cancelRegistrationSession(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    this.stopRegistrationEmailWatcher(id);
    await this.registrationManager.cancelSession(id);
    await this.publishPanelState();
  }

  requireRegistrationSessionId(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("注册会话不存在");
    }
    return sessionId;
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
    const registrationKeyPool = await this.getRegistrationKeyPoolState();
    return {
      mailboxes: mailboxes.map(toPanelMailbox),
      selectedMailboxId: selectedMailbox?.id,
      selected: selectedMailbox ? { mailbox: selectedMailbox, detail } : undefined,
      operations: this.coordinator.getActiveOperations(),
      codexImports: [...this.codexImports.keys()],
      codexImportCancellable: typeof this.api?.cancelOAuthAccountImport === "function",
      providers: this.providers.list().map(sanitizeProvider),
      codexImportAvailable: codexImportState.available,
      managedAccountEmailsAvailable: codexImportState.managedEmailsAvailable,
      managedAccountEmails: codexImportState.emails,
      phoneSources: listRegistrationPhoneSources(),
      registrationKeyPool,
      registrationSessions: this.registrationManager.getAllSessions().map((session) =>
        this.registrationManager.getSessionState(session.id)
      )
    };
  }

  async getRegistrationKeyPoolState() {
    try {
      return await this.registrationKeyPool.snapshot();
    } catch {
      return { count: 0, available: 0, inUse: 0, keys: [], error: "接码平台 Key 池不可用" };
    }
  }

  async getCodexImportState() {
    if (typeof this.api?.getManagedAccountEmails !== "function") {
      return { available: false, managedEmailsAvailable: false, emails: [] };
    }
    try {
      const emails = await this.api.getManagedAccountEmails();
      return {
        available: typeof this.api.startOAuthAccountImport === "function",
        managedEmailsAvailable: true,
        emails: Array.isArray(emails) ? emails.filter((email) => typeof email === "string") : []
      };
    } catch {
      return { available: false, managedEmailsAvailable: false, emails: [] };
    }
  }

  async publishPanelState() {
    if ((!this.panel && !this.registrationPanel) || this.disposed) {
      return;
    }
    this.postPanelMessage({ type: "state", state: await this.getPanelState() });
  }

  postPanelMessage(message) {
    if (this.panel) {
      void this.panel.webview.postMessage(message);
    }
    if (this.registrationPanel) {
      void this.registrationPanel.webview.postMessage(message);
    }
  }

  closePanel() {
    for (const disposable of this.panelDisposables.splice(0)) {
      disposable?.dispose?.();
    }
    this.panel = undefined;
    this.publish();
  }

  closeRegistrationPanel() {
    for (const disposable of this.registrationPanelDisposables.splice(0)) {
      disposable?.dispose?.();
    }
    this.registrationPanel = undefined;
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
    for (const watcher of this.registrationEmailWatchers.values()) {
      watcher.stop();
    }
    this.registrationEmailWatchers.clear();
    for (const sessionId of this.registrationPhoneKeyClaims.keys()) {
      void this.releaseRegistrationPhoneKey(sessionId).catch(() => undefined);
    }
    this.registrationPhoneKeyClaims.clear();
    for (const session of this.registrationManager.getAllSessions()) {
      void this.registrationManager.cancelSession(session.id).catch(() => undefined);
    }
    for (const disposable of this.panelDisposables.splice(0)) {
      disposable?.dispose?.();
    }
    for (const disposable of this.registrationPanelDisposables.splice(0)) {
      disposable?.dispose?.();
    }
    this.panel?.dispose?.();
    this.registrationPanel?.dispose?.();
    this.panel = undefined;
    this.registrationPanel = undefined;
    this.registration?.dispose();
    this.registrationAssistantRegistration?.dispose();
    this.registrationDiagnostics.dispose();
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

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function safeError(error, fallback) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message || fallback).replace(/[\r\n\t]+/gu, " ").slice(0, 160);
}

module.exports = { INTEGRATION_ID, REGISTRATION_INTEGRATION_ID, MailboxIntegration, safeError };
