"use strict";

const { createServerMailboxStores, createServerRegistrationSessionStore } = require("../mailbox/server-storage.cjs");
const { Eight92Provider } = require("../core/providers/eight92.cjs");
const { BoyaProvider } = require("../core/providers/boya.cjs");
const { CdnsProvider } = require("../core/providers/cdns.cjs");
const { isOpenAiAccountDeactivatedMessage } = require("../core/messages.cjs");
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
const {
  createLocalRegistrationKeyStore,
  RegistrationKeyPool
} = require("../operations/registration-key-pool.cjs");
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
const CLIPBOARD_RETRY_DELAYS_MS = [0, 250, 750];
const REGISTRATION_CLIPBOARD_MESSAGES = {
  emailCode: "邮箱验证码已自动复制",
  phone: "手机号已自动复制",
  otp: "短信验证码已自动复制"
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
    this.sharedMailboxStores = createServerMailboxStores({
      storageUri: context.globalStorageUri,
      legacyMetadataStore: context.globalState,
      legacySecretStore: context.secrets,
      sourceId: typeof vscode.env?.machineId === "string" ? vscode.env.machineId : undefined
    });
    this.pool = new MailboxPool({
      metadataStore: this.sharedMailboxStores.metadataStore,
      secretStore: this.sharedMailboxStores.secretStore
    });
    this.registrationSessionStore = createServerRegistrationSessionStore({
      storageUri: context.globalStorageUri,
      legacyStore: context.globalState
    });
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
      openRegistrationBrowser: typeof this.api?.openRegistrationBrowser === "function"
        ? (options) => this.api.openRegistrationBrowser(options)
        : undefined,
    });
    this.registrationDiagnostics = createRegistrationDiagnostics(vscode, context);
    this.registrationEmailWatchers = new Map();
    this.registrationGptStatusSync = Promise.resolve();
    this.registrationSessionsPersistence = Promise.resolve();
    this.registrationSessionsOperation = Promise.resolve();
    this.registrationClipboardCopied = new Map();
    this.registrationClipboardQueues = new Map();
    const serverRegistrationKeyStore = createLocalRegistrationKeyStore(context.globalStorageUri);
    this.registrationKeyPool = new RegistrationKeyPool({
      secretStore: serverRegistrationKeyStore || context.secrets,
      backupStore: serverRegistrationKeyStore ? context.secrets : undefined
    });
    this.registrationPhoneKeyClaims = new Map();
    this.registrationManager.on("stateChange", (event) => {
      // GPT-only is a browser handoff. Once the external page is actually
      // open, perform one mailbox query; continuous polling remains explicit.
      if (
        event?.state === STATES.AWAITING_MANUAL_REGISTRATION &&
        event.mode === "manual-browser" &&
        event.browserOpened === true
      ) {
        this.startRegistrationEmailQueryOnce(event.sessionId);
      }
      // The original Codex route keeps its watcher. GPT-only never starts a
      // continuous watcher automatically.
      if (event?.state === STATES.STARTING && event.mode !== "manual-browser") {
        this.startRegistrationEmailWatcher(event.sessionId);
      }
      if (
        [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED].includes(event?.state) &&
        !(event?.state === STATES.COMPLETED && event.mode === "manual-browser")
      ) {
        this.stopRegistrationEmailWatcher(event.sessionId);
      }
      if (event?.state === STATES.COMPLETED) {
        this.queueRegistrationGptStatusSync(event.sessionId);
      }
      void this.syncRegistrationPhoneKey(event).catch((error) => {
        this.postPanelMessage({
          type: "toast",
          level: "error",
          action: "registrationPhoneKeyPool",
          message: safeError(error, "接码平台 Key 状态更新失败")
        });
      });
      void this.syncRegistrationClipboard(event).catch((error) => {
        this.postPanelMessage({
          type: "toast",
          level: "warning",
          action: "registrationAutoCopy",
          sessionId: event?.sessionId,
          message: safeError(error, "注册信息自动复制失败，请手动复制")
        });
      });
      void this.persistRegistrationSessions().catch(() => undefined);
      void this.publishPanelState().catch(() => undefined);
    });
    this.registrationManager.on("sessionCreated", () => {
      void this.persistRegistrationSessions().catch(() => undefined);
    });
    this.registrationManager.on("sessionCleaned", ({ sessionId } = {}) => {
      this.clearRegistrationClipboardState(sessionId);
      void this.persistRegistrationSessions().catch(() => undefined);
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
    try {
      await this.sharedMailboxStores.migrateLegacy();
      await this.pool.load();
      this.selectedMailboxId = await this.sharedMailboxStores.metadataStore.get(SELECTED_MAILBOX_KEY);
      if (!this.selectedMailboxId || !this.pool.listMetadata().some((mailbox) => mailbox.id === this.selectedMailboxId)) {
        this.selectedMailboxId = this.pool.listMetadata()[0]?.id;
        await this.sharedMailboxStores.metadataStore.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
      }
      const restored = this.registrationManager.restoreSessions(await this.registrationSessionStore.load());
      if (restored.interrupted > 0) {
        await this.persistRegistrationSessions();
      }
      await this.syncCompletedRegistrationMailboxStates();
    } catch (error) {
      this.loadError = safeError(error, "服务器邮箱池状态不可用");
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
        getDeactivatedMailboxEmails: () => this.getDeactivatedMailboxEmails(),
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

  getDeactivatedMailboxEmails() {
    if (!this.pool.isLoaded()) {
      return [];
    }
    return this.pool
      .listMetadata()
      .filter((mailbox) => mailbox.openaiAccountDeactivated === true)
      .map((mailbox) => mailbox.address);
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
        case "copyText":
          await this.copyText(message.text, message.successMessage);
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
        case "deleteMailboxAndCodex":
          await this.deleteMailboxAndCodex(message.mailboxId);
          return;
        case "deleteDeactivatedMailboxes":
          await this.deleteDeactivatedMailboxes();
          return;
        case "registrationDeleteMailbox":
          await this.deleteMailbox(message.mailboxId);
          return;
        case "query":
          await this.runQuery(message.mailboxId);
          return;
        case "batchQuery":
          await this.runQueryMany(message.mailboxIds);
          return;
        case "queryReauthorizationMailboxes":
          await this.runReauthorizationQueries();
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
        case "registrationStopEmailCode":
          await this.stopRegistrationEmailCode(message.sessionId);
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
        case "registrationCompleteManual":
          await this.completeManualRegistrationSession(message.sessionId);
          return;
        case "registrationCodexImport":
          await this.runRegistrationCodexImport(message.sessionId);
          return;
        case "registrationCancelCodexImport":
          await this.cancelRegistrationCodexImport(message.sessionId);
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
          await this.cleanupRegistrationSession(message.sessionId);
          return;
        case "registrationCleanupAll":
          await this.cleanupAllRegistrationSessions();
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
    await this.sharedMailboxStores.metadataStore.update(SELECTED_MAILBOX_KEY, id);
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
      await this.sharedMailboxStores.metadataStore.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
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
    await this.sharedMailboxStores.metadataStore.update(SELECTED_MAILBOX_KEY, mailbox.id);
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
    await this.cancelRegistrationForMailbox(mailboxId);
    await this.pool.deleteAccount(mailboxId);
    if (this.selectedMailboxId === mailboxId) {
      this.selectedMailboxId = this.pool.listMetadata()[0]?.id;
      await this.sharedMailboxStores.metadataStore.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
    }
    this.postPanelMessage({ type: "toast", level: "success", action: "delete", mailboxId, message: "邮箱已删除" });
    await this.publishPanelState();
    this.publish();
  }

  async deleteMailboxAndCodex(id, { notify = true } = {}) {
    const mailboxId = this.requireMailboxId(id);
    const mailbox = this.pool.listMetadata().find((item) => item.id === mailboxId);
    if (!mailbox?.openaiAccountDeactivated) {
      throw new Error("未检测到 OpenAI account deactivated 邮件，不能执行联删");
    }
    const detail = await this.pool.getDetail(mailboxId);
    if (!hasOpenAiAccountDeactivationMessage(detail)) {
      throw new Error("对应邮箱没有保存的 OpenAI account deactivated 邮件，不能执行联删");
    }
    if (typeof this.api?.getManagedAccountDirectory !== "function" || typeof this.api?.removeManagedAccount !== "function") {
      throw new Error("当前 Manager 未提供删除邮箱与 Codex 账号所需的能力");
    }
    const directory = normalizeManagedAccountDirectory(await this.api.getManagedAccountDirectory());
    const managedAccount = directory.find((account) => normalizeEmail(account.email) === normalizeEmail(mailbox.address));
    if (!managedAccount) {
      throw new Error("未找到与该邮箱匹配的 Codex 账号");
    }
    if (!managedAccount.requiresReauthorization) {
      throw new Error("对应 Codex 账号当前不需要重新授权，已取消联删");
    }

    const result = { mailboxDeleted: false, codexDeleted: false };
    if (this.coordinator.isActive(mailboxId) || this.codexImports.has(mailboxId)) {
      const stopped = await this.stopMailbox(mailboxId);
      if (!stopped && (this.coordinator.isActive(mailboxId) || this.codexImports.has(mailboxId))) {
        throw new Error("请先停止邮箱当前操作");
      }
    }
    await this.cancelRegistrationForMailbox(mailboxId);
    await this.pool.deleteAccount(mailboxId);
    result.mailboxDeleted = true;
    if (this.selectedMailboxId === mailboxId) {
      this.selectedMailboxId = this.pool.listMetadata()[0]?.id;
      await this.sharedMailboxStores.metadataStore.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
    }

    try {
      await this.api.removeManagedAccount(managedAccount.accountId);
    } catch (error) {
      result.error = safeError(error, "未知错误");
      if (notify) {
        this.postPanelMessage({
          type: "toast",
          level: "warning",
          action: "deleteMailboxAndCodex",
          mailboxId,
          message: `邮箱已删除，但 Codex 账号删除失败：${result.error}`
        });
        await this.publishPanelState();
        this.publish();
      }
      return result;
    }

    result.codexDeleted = true;
    if (notify) {
      this.postPanelMessage({
        type: "toast",
        level: "success",
        action: "deleteMailboxAndCodex",
        mailboxId,
        message: "邮箱与 Codex 账号已删除"
      });
      await this.publishPanelState();
      this.publish();
    }
    return result;
  }

  async deleteDeactivatedMailboxes() {
    const candidates = await this.getDeactivatedMailboxCandidates();
    if (candidates.length === 0) {
      throw new Error("当前没有同时满足失效邮件、邮箱匹配和需要重新授权条件的账号");
    }

    const removed = [];
    const failed = [];
    for (const candidate of candidates) {
      try {
        const result = await this.deleteMailboxAndCodex(candidate.mailbox.id, { notify: false });
        if (result.codexDeleted === true) {
          removed.push(candidate.mailbox.id);
        } else {
          failed.push(result.error || "Codex 账号删除失败");
        }
      } catch (error) {
        failed.push(safeError(error, "联删失败"));
      }
    }

    const total = candidates.length;
    const level = failed.length === 0 ? "success" : removed.length > 0 ? "warning" : "error";
    const message = failed.length === 0
      ? `已删除 ${removed.length} 个失效邮箱及对应 Codex 账号`
      : `已完成 ${removed.length}/${total} 个联删，${failed.length} 个失败：${failed[0]}`;
    this.postPanelMessage({
      type: "toast",
      level,
      action: "deleteDeactivatedMailboxes",
      mailboxIds: candidates.map((candidate) => candidate.mailbox.id),
      message
    });
    await this.publishPanelState();
    this.publish();
  }

  async getDeactivatedMailboxCandidates() {
    if (typeof this.api?.getManagedAccountDirectory !== "function" || typeof this.api?.removeManagedAccount !== "function") {
      throw new Error("当前 Manager 未提供删除邮箱与 Codex 账号所需的能力");
    }
    const directory = normalizeManagedAccountDirectory(await this.api.getManagedAccountDirectory());
    const candidates = [];
    for (const mailbox of this.pool.listMetadata()) {
      if (mailbox.openaiAccountDeactivated !== true) {
        continue;
      }
      const detail = await this.pool.getDetail(mailbox.id);
      if (!hasOpenAiAccountDeactivationMessage(detail)) {
        continue;
      }
      const managedAccount = directory.find(
        (account) => normalizeEmail(account.email) === normalizeEmail(mailbox.address) && account.requiresReauthorization
      );
      if (managedAccount) {
        candidates.push({ mailbox, managedAccount });
      }
    }
    return candidates;
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

  async runReauthorizationQueries() {
    if (typeof this.api?.getManagedAccountDirectory !== "function") {
      throw new Error("当前 Manager 未提供需要重新授权账号目录");
    }
    const directory = normalizeManagedAccountDirectory(await this.api.getManagedAccountDirectory());
    const reauthorizationEmails = new Set(
      directory
        .filter((account) => account.requiresReauthorization)
        .map((account) => normalizeEmail(account.email))
        .filter(Boolean)
    );
    const mailboxIds = this.pool
      .listMetadata({ includeDisabled: false })
      .filter((mailbox) => reauthorizationEmails.has(normalizeEmail(mailbox.address)))
      .map((mailbox) => mailbox.id);
    if (mailboxIds.length === 0) {
      throw new Error("没有找到需要重新授权账号对应的邮箱");
    }
    await this.runQueryMany(mailboxIds);
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

  async runRegistrationCodexImport(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const session = this.registrationManager.getSessionState(id);
    if (!session || session.importCodex !== false || session.state !== STATES.COMPLETED) {
      throw new Error("请先完成 GPT 网页注册，再导入 Codex");
    }
    const mailbox = this.findMailboxByEmail(session.email);
    if (!mailbox) {
      throw new Error("该邮箱不在邮箱池中，请先导入邮箱凭据后再导入 Codex");
    }
    await this.runCodexImport(mailbox.id);
  }

  async cancelRegistrationCodexImport(sessionId, { silent = false } = {}) {
    const id = this.requireRegistrationSessionId(sessionId);
    const session = this.registrationManager.getSessionState(id);
    if (!session || session.mode !== "manual-browser" || session.state !== STATES.COMPLETED) {
      if (silent) return false;
      throw new Error("当前没有可终止的 GPT 后续 Codex 导入");
    }
    const mailbox = this.findMailboxByEmail(session.email);
    const operationId = mailbox ? this.codexImports.get(mailbox.id) : undefined;
    if (typeof operationId !== "string" || !operationId) {
      if (silent) return false;
      throw new Error("当前没有正在进行的 Codex 导入");
    }
    if (typeof this.api?.cancelOAuthAccountImport !== "function") {
      if (silent) return false;
      throw new Error("当前 Manager 不支持终止 Codex OAuth 导入");
    }

    this.api.cancelOAuthAccountImport(operationId);
    this.codexImports.delete(mailbox.id);
    if (!silent) {
      this.postPanelMessage({
        type: "toast",
        level: "success",
        action: "registrationCancelCodexImport",
        sessionId: id,
        mailboxId: mailbox.id,
        message: "Codex 导入已终止，可继续取号或稍后重新导入"
      });
    }
    await this.publishPanelState();
    return true;
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
    const importCodex = message.importCodex !== false && message.importCodex !== "false";
    const codexImportState = await this.getCodexImportState();
    if (codexImportState.managedEmailsAvailable && codexImportState.emails.some((item) => normalizeEmail(item) === normalizeEmail(email))) {
      throw new Error("该邮箱已经导入 Codex 账号，请选择其他邮箱");
    }
    const mailbox = this.findMailboxByEmail(email);
    if (!importCodex && mailbox?.gptRegistered) {
      throw new Error("该邮箱已经注册 GPT 账号，请改用“注册并导入 Codex”或选择其他邮箱");
    }
    const sessionId = this.registrationManager.createSession({
      email,
      password: typeof message.password === "string" && message.password ? message.password : "Chatgpt189687",
      name: typeof message.name === "string" && message.name ? message.name : "jdd",
      age: Number.isFinite(message.age) ? message.age : 24,
      importCodex
    });
    // 创建后立即启动对应路线；手机号/验证码仍由用户手动填写。
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
    const completedManualRegistration = session?.mode === "manual-browser" && session.state === STATES.COMPLETED;
    if (!session || ([STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED].includes(session.state) && !completedManualRegistration)) {
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
      .finally(() => this.cleanupRegistrationEmailWatcher(sessionId, watcher));
  }

  startRegistrationEmailQueryOnce(sessionId) {
    if (typeof sessionId !== "string" || this.registrationEmailWatchers.has(sessionId)) {
      return;
    }
    const session = this.registrationManager.getSessionState(sessionId);
    if (!session || session.mode !== "manual-browser" || session.state !== STATES.AWAITING_MANUAL_REGISTRATION) {
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
    const promise = watcher.queryOnce(session.email);
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
      .finally(() => this.cleanupRegistrationEmailWatcher(sessionId, watcher));
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

  cleanupRegistrationEmailWatcher(sessionId, watcher) {
    if (this.registrationEmailWatchers.get(sessionId) === watcher && !watcher.isRunning()) {
      this.registrationEmailWatchers.delete(sessionId);
    }
  }

  async stopRegistrationEmailCode(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const stopped = this.stopRegistrationEmailWatcher(id);
    if (!stopped) {
      return;
    }
    await this.publishPanelState();
  }

  async refreshRegistrationEmailCode(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const session = this.registrationManager.getSessionState(id);
    if (!session) throw new Error("注册会话不存在");
    let watcher = this.registrationEmailWatchers.get(id);
    if (!watcher || !watcher.isRunning()) {
      if (watcher) this.registrationEmailWatchers.delete(id);
      this.startRegistrationEmailWatcher(id);
      await this.publishPanelState();
      return;
    }
    if (session.mode === "manual-browser") {
      this.stopRegistrationEmailWatcher(id);
      this.startRegistrationEmailWatcher(id);
      await this.publishPanelState();
      return;
    }
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
    }).finally(() => this.cleanupRegistrationEmailWatcher(id, watcher));
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
      const session = this.registrationManager.getSessionState(id);
      this.postPanelMessage({
        type: "toast",
        level: "success",
        action: "registrationComplete",
        message: session?.importCodex === false
          ? "GPT 注册表单已提交完成，请在注册页面出现最后继续时确认完成。"
          : "注册表单已提交完成。请使用下方“确认授权并完成”按钮完成注册；如未走 OAuth，之后可再导入 Codex。"
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

  async completeManualRegistrationSession(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const session = this.registrationManager.getSessionState(id);
    if (!session || session.mode !== "manual-browser") {
      throw new Error("当前会话不是 GPT 手动注册会话");
    }
    const result = await this.registrationManager.completeManualRegistration(id);
    this.postPanelMessage({
      type: "toast",
      level: "success",
      action: "registrationCompleteManual",
      sessionId: id,
      message: result?.message || "GPT 注册已完成（未导入 Codex）"
    });
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

  async copyText(value, successMessage = "已复制", { automatic = false, sessionId } = {}) {
    const text = normalizeClipboardText(value);
    if (!text) return false;
    const message = normalizeClipboardMessage(successMessage, "已复制");
    const action = automatic ? "registrationAutoCopy" : "clipboardCopy";
    try {
      await this.writeClipboardWithRetry(text);
      this.postPanelMessage({
        type: "toast",
        level: "success",
        action,
        sessionId: typeof sessionId === "string" ? sessionId : undefined,
        message
      });
      return true;
    } catch {
      this.postPanelMessage({
        type: "toast",
        level: "warning",
        action,
        sessionId: typeof sessionId === "string" ? sessionId : undefined,
        message: automatic ? "自动复制失败，请手动复制" : "复制失败，请手动复制"
      });
      return false;
    }
  }

  async writeClipboardWithRetry(value) {
    const clipboard = this.vscode.env?.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      throw new Error("VS Code 剪贴板不可用");
    }

    let lastError;
    for (const delay of CLIPBOARD_RETRY_DELAYS_MS) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        await clipboard.writeText(value);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("VS Code 剪贴板写入失败");
  }

  syncRegistrationClipboard(event) {
    const sessionId = typeof event?.sessionId === "string" ? event.sessionId : "";
    if (!sessionId) return Promise.resolve();
    if (this.registrationManager.getSessionState(sessionId)?.mode === "manual-browser") {
      // The GPT-only route is intentionally copy-controlled: only the mailbox
      // address is copied when the external registration page opens.
      return Promise.resolve();
    }

    const previous = this.registrationClipboardQueues.get(sessionId) || Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.copyRegistrationClipboardValues(sessionId));
    this.registrationClipboardQueues.set(sessionId, task);
    void task.then(
      () => this.releaseRegistrationClipboardQueue(sessionId, task),
      () => this.releaseRegistrationClipboardQueue(sessionId, task)
    );
    return task;
  }

  async copyRegistrationClipboardValues(sessionId) {
    const session = this.registrationManager.getSessionState(sessionId);
    if (!session) {
      this.clearRegistrationClipboardState(sessionId);
      return;
    }

    const rawPhone = normalizeClipboardText(session.phoneOrder?.order?.phone);
    const values = {
      emailCode: normalizeClipboardText(session.emailCode?.code),
      phone: isCompletePhoneNumber(rawPhone) ? rawPhone : "",
      otp: normalizeClipboardText(session.phoneOrder?.order?.smsCode)
    };
    const copied = { ...(this.registrationClipboardCopied.get(sessionId) || {}) };
    for (const [field, value] of Object.entries(values)) {
      if (!value) {
        delete copied[field];
        continue;
      }
      if (copied[field] === value) continue;
      const success = await this.copyText(value, REGISTRATION_CLIPBOARD_MESSAGES[field], {
        automatic: true,
        sessionId
      });
      if (success) copied[field] = value;
    }
    if (Object.keys(copied).length) {
      this.registrationClipboardCopied.set(sessionId, copied);
    } else {
      this.registrationClipboardCopied.delete(sessionId);
    }
  }

  releaseRegistrationClipboardQueue(sessionId, task) {
    if (this.registrationClipboardQueues.get(sessionId) === task) {
      this.registrationClipboardQueues.delete(sessionId);
    }
  }

  clearRegistrationClipboardState(sessionId) {
    if (!sessionId) return;
    this.registrationClipboardCopied.delete(sessionId);
    this.registrationClipboardQueues.delete(sessionId);
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

  async cleanupRegistrationSession(sessionId) {
    const id = this.requireRegistrationSessionId(sessionId);
    const session = this.registrationManager.getSessionState(id);
    await this.cancelRegistrationCodexImport(id, { silent: true });
    this.stopRegistrationEmailWatcher(id);
    if (session?.phoneOrder?.running) {
      await this.registrationManager.cancelPhoneNumber(id).catch(() => undefined);
    }
    await this.releaseRegistrationPhoneKey(id);
    this.registrationManager.cleanupSession(id);
    await this.publishPanelState();
    this.publish();
  }

  async cleanupAllRegistrationSessions() {
    const sessions = await this.withRegistrationSessionsOperation(async () => {
      const currentSessions = this.registrationManager.getAllSessions();
      for (const session of currentSessions) {
        await this.cancelRegistrationCodexImport(session.id, { silent: true });
        this.stopRegistrationEmailWatcher(session.id);
        await this.registrationManager.cancelSession(session.id);
        await this.releaseRegistrationPhoneKey(session.id);
        this.registrationManager.cleanupSession(session.id);
      }
      await this.persistRegistrationSessions();
      return currentSessions;
    });
    this.postPanelMessage({
      type: "toast",
      level: sessions.length ? "success" : "warning",
      action: "registrationCleanupAll",
      message: sessions.length ? `已删除 ${sessions.length} 条注册记录` : "没有可删除的注册记录"
    });
    await this.publishPanelState();
    this.publish();
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

  async cancelRegistrationForMailbox(mailboxId) {
    const mailbox = this.pool.listMetadata().find((item) => item.id === mailboxId);
    if (!mailbox) {
      return false;
    }

    const terminalStates = [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED];
    const sessions = this.registrationManager
      .getAllSessions()
      .filter(
        (session) =>
          normalizeEmail(session.email) === normalizeEmail(mailbox.address) &&
          !terminalStates.includes(session.state)
      );

    for (const session of sessions) {
      this.stopRegistrationEmailWatcher(session.id);
      await this.registrationManager.cancelSession(session.id);
      await this.releaseRegistrationPhoneKey(session.id);
    }
    return sessions.length > 0;
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
      await this.cancelRegistrationForMailbox(mailboxId);
    }
    for (const mailboxId of mailboxIds) {
      await this.pool.deleteAccount(mailboxId);
    }
    if (mailboxIds.includes(this.selectedMailboxId)) {
      this.selectedMailboxId = this.pool.listMetadata()[0]?.id;
      await this.sharedMailboxStores.metadataStore.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
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

  findMailboxByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized || !this.pool.isLoaded()) {
      return undefined;
    }
    return this.pool.listMetadata().find((mailbox) => normalizeEmail(mailbox.address) === normalized);
  }

  queueRegistrationGptStatusSync(sessionId) {
    this.registrationGptStatusSync = this.registrationGptStatusSync
      .catch(() => undefined)
      .then(() => this.syncRegistrationGptStatus(sessionId))
      .catch((error) => {
        this.postPanelMessage({
          type: "toast",
          level: "warning",
          action: "registrationGptStatus",
          message: safeError(error, "GPT 注册状态保存失败")
        });
      });
  }

  async syncRegistrationGptStatus(sessionId) {
    const session = this.registrationManager.getSessionState(sessionId);
    if (!session || session.state !== STATES.COMPLETED) {
      return false;
    }
    const mailbox = this.findMailboxByEmail(session.email);
    if (!mailbox) {
      return false;
    }
    await this.pool.markGptRegistered(mailbox.id);
    return true;
  }

  async syncCompletedRegistrationMailboxStates() {
    await this.registrationGptStatusSync;
    for (const session of this.registrationManager.getAllSessions()) {
      if (session.state === STATES.COMPLETED) {
        await this.syncRegistrationGptStatus(session.id);
      }
    }
  }

  async getPanelState() {
    if (this.pool.isLoaded()) {
      await this.pool.reload();
    }
    let mailboxes = this.pool.isLoaded() ? this.pool.listMetadata() : [];
    const persistedSelectedMailboxId = await this.sharedMailboxStores.metadataStore.get(SELECTED_MAILBOX_KEY);
    if (typeof persistedSelectedMailboxId === "string" && mailboxes.some((mailbox) => mailbox.id === persistedSelectedMailboxId)) {
      this.selectedMailboxId = persistedSelectedMailboxId;
    } else if (this.selectedMailboxId && mailboxes.some((mailbox) => mailbox.id === this.selectedMailboxId)) {
      await this.sharedMailboxStores.metadataStore.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
    } else {
      this.selectedMailboxId = mailboxes[0]?.id;
      await this.sharedMailboxStores.metadataStore.update(SELECTED_MAILBOX_KEY, this.selectedMailboxId);
    }
    await this.withRegistrationSessionsOperation(async () => {
      const restored = this.registrationManager.restoreSessions(await this.registrationSessionStore.load());
      if (restored.interrupted > 0) {
        await this.persistRegistrationSessions();
      }
    });
    await this.syncCompletedRegistrationMailboxStates();
    mailboxes = this.pool.isLoaded() ? this.pool.listMetadata() : [];
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
      managedAccounts: codexImportState.accounts,
      managedAccountDirectoryAvailable: codexImportState.directoryAvailable,
      managedAccountRemovalAvailable: codexImportState.removalAvailable,
      phoneSources: listRegistrationPhoneSources(),
      registrationKeyPool,
      registrationSessions: this.registrationManager.getAllSessions().map((session) =>
        this.registrationManager.getSessionState(session.id)
      )
    };
  }

  async persistRegistrationSessions() {
    const records = this.registrationManager.getSessionRecords();
    this.registrationSessionsPersistence = this.registrationSessionsPersistence
      .catch(() => undefined)
      .then(() => this.registrationSessionStore.save(records));
    await this.registrationSessionsPersistence;
  }

  async withRegistrationSessionsOperation(operation) {
    const previous = this.registrationSessionsOperation;
    let release;
    this.registrationSessionsOperation = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
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
      if (typeof this.api?.getManagedAccountDirectory !== "function") {
        return {
          available: false,
          managedEmailsAvailable: false,
          emails: [],
          accounts: [],
          directoryAvailable: false,
          removalAvailable: false
        };
      }
    }
    try {
      if (typeof this.api?.getManagedAccountDirectory === "function") {
        const accounts = normalizeManagedAccountDirectory(await this.api.getManagedAccountDirectory());
        return {
          available: typeof this.api.startOAuthAccountImport === "function",
          managedEmailsAvailable: true,
          emails: accounts.map((account) => account.email),
          accounts,
          directoryAvailable: true,
          removalAvailable: typeof this.api.removeManagedAccount === "function"
        };
      }
      const emails = await this.api.getManagedAccountEmails();
      return {
        available: typeof this.api.startOAuthAccountImport === "function",
        managedEmailsAvailable: true,
        emails: Array.isArray(emails) ? emails.filter((email) => typeof email === "string") : [],
        accounts: [],
        directoryAvailable: false,
        removalAvailable: false
      };
    } catch {
      return {
        available: false,
        managedEmailsAvailable: false,
        emails: [],
        accounts: [],
        directoryAvailable: false,
        removalAvailable: false
      };
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
    if (!this.disposed) {
      void this.cancelManualRegistrationSessions();
    }
  }

  async cancelManualRegistrationSessions() {
    const terminalStates = [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED];
    const sessions = this.registrationManager
      .getAllSessions()
      .filter((session) => {
        if (session.mode !== "manual-browser") return false;
        const state = this.registrationManager.getSessionState(session.id);
        const mailbox = this.findMailboxByEmail(session.email);
        return (
          !terminalStates.includes(session.state) ||
          this.registrationEmailWatchers.has(session.id) ||
          state?.phoneOrder?.running === true ||
          Boolean(mailbox && this.codexImports.has(mailbox.id))
        );
      });

    for (const session of sessions) {
      this.stopRegistrationEmailWatcher(session.id);
      try {
        await this.cancelRegistrationCodexImport(session.id, { silent: true });
        if (!terminalStates.includes(session.state)) {
          await this.registrationManager.cancelSession(session.id);
        } else if (this.registrationManager.getSessionState(session.id)?.phoneOrder?.running) {
          await this.registrationManager.cancelPhoneNumber(session.id);
        }
      } catch (error) {
        this.registrationDiagnostics.record({
          level: "error",
          sessionId: session.id,
          msg: `关闭注册助手时取消 GPT 会话失败：${safeError(error, "未知错误")}`
        });
      } finally {
        await this.releaseRegistrationPhoneKey(session.id).catch(() => undefined);
      }
    }
    if (sessions.length > 0) {
      await this.persistRegistrationSessions().catch(() => undefined);
      this.publish();
      await this.publishPanelState();
    }
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

function normalizeManagedAccountDirectory(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      accountId: typeof entry.accountId === "string" ? entry.accountId.trim() : "",
      email: typeof entry.email === "string" ? entry.email.trim() : "",
      requiresReauthorization: entry.requiresReauthorization === true
    }))
    .filter((entry) => Boolean(entry.accountId && entry.email));
}

function hasOpenAiAccountDeactivationMessage(detail) {
  return Array.isArray(detail?.messages) && detail.messages.some(isOpenAiAccountDeactivatedMessage);
}

function normalizeClipboardText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeClipboardMessage(value, fallback) {
  const message = normalizeClipboardText(value);
  return (message || fallback).slice(0, 80);
}

function isCompletePhoneNumber(value) {
  const compact = normalizeClipboardText(value).replace(/[\s()\-]/gu, "");
  if (!/^\+?\d+$/u.test(compact)) return false;
  const digits = compact.replace(/^\+/u, "");
  if (digits.startsWith("86")) return /^861\d{10}$/u.test(digits);
  if (/^1\d{10}$/u.test(digits)) return true;
  return digits.length >= 10 && digits.length <= 15;
}

function safeError(error, fallback) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message || fallback).replace(/[\r\n\t]+/gu, " ").slice(0, 160);
}

module.exports = { INTEGRATION_ID, REGISTRATION_INTEGRATION_ID, MailboxIntegration, safeError };
