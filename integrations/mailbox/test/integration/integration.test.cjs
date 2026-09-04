"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MailboxIntegration, INTEGRATION_ID, REGISTRATION_INTEGRATION_ID } = require("../../src/ui/integration.cjs");

test("activation loads local state, registers a generic Manager card, and does not query a provider", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  let fetchCalls = 0;
  const api = {
    registerDashboardIntegration(value) {
      registration = value;
      return { dispose() {} };
    }
  };
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport() { return { entries: [], failed: [] }; },
    async query() { fetchCalls += 1; return { ok: true, providerId: "mock", messages: [], codes: [] }; }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();

  assert.equal(fetchCalls, 0);
  assert.equal(registration.id, INTEGRATION_ID);
  assert.equal(registration.getViewModel().title, "Mailbox");
  assert.equal(registration.getViewModel().actions.some((action) => action.id === "open"), true);
  integration.dispose();
});

test("Manager account directory changes refresh the open Mailbox panel", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  let notifyManagerChange;
  let managedAccounts = [
    { accountId: "account-1", email: "current@example.com", requiresReauthorization: false }
  ];
  const api = {
    onDidChange(listener) {
      notifyManagerChange = listener;
      return { dispose() {} };
    },
    registerDashboardIntegration(value) {
      registration = value;
      return { dispose() {} };
    },
    async getManagedAccountDirectory() {
      return managedAccounts;
    }
  };
  const integration = new MailboxIntegration(vscode, context, api);
  await integration.initialize();
  await registration.runAction("open");

  assert.equal(
    vscode.panels[0].webview.messages.at(-1).state.managedAccounts[0].requiresReauthorization,
    false
  );
  managedAccounts = [
    { accountId: "account-1", email: "current@example.com", requiresReauthorization: true }
  ];
  notifyManagerChange();
  await waitFor(() => vscode.panels[0].webview.messages.some(
    (message) => message.type === "state" && message.state.managedAccounts[0]?.requiresReauthorization === true
  ));
  integration.dispose();
});

test("registration assistant is a separate Dashboard entry in the main editor group and shares the mailbox state", async () => {
  const vscode = createVscode();
  const context = createContext();
  const registrations = [];
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query() { return { ok: true, providerId: "mock", messages: [], codes: [] }; }
  };
  const api = {
    registerDashboardIntegration(value) {
      registrations.push(value);
      return { dispose() {} };
    }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();

  assert.deepEqual(registrations.map((value) => value.id), [REGISTRATION_INTEGRATION_ID, INTEGRATION_ID]);
  assert.equal(registrations[0].getViewModel().title, "注册助手");
  assert.equal(registrations[0].getViewModel().topButton.label, "注册助手");
  await registrations[0].runAction("open");
  assert.equal(vscode.panels.length, 1);
  assert.equal(vscode.panels[0].viewType, "codexAccounts.mailboxRegistration");
  assert.equal(vscode.panels[0].column, vscode.ViewColumn.Active);
  assert.match(vscode.panels[0].webview.html, /registrationMailboxSearch/u);

  await integration.pool.importProvider({ provider, input: "register@example.com|credential" });
  const sessionId = integration.registrationManager.createSession({ email: "register@example.com", password: "manual-password" });
  await integration.publishPanelState();
  const state = vscode.panels[0].webview.messages.filter((message) => message.type === "state").at(-1).state;
  assert.equal(state.mailboxes[0].address, "register@example.com");
  assert.equal(state.registrationSessions[0].id, sessionId);
  integration.dispose();
});

test("registration assistant uses the Manager Codex OAuth flow when it is available", async () => {
  const vscode = createVscode();
  const context = createContext();
  let oauthOptions;
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async startOAuthAccountImport(options) {
      oauthOptions = options;
      return { accountId: "account-1", email: options.expectedEmail, quotaRefreshed: true };
    },
    cancelOAuthAccountImport() {}
  };
  const integration = new MailboxIntegration(vscode, context, api);
  await integration.initialize();

  const sessionId = integration.registrationManager.createSession({
    email: "oauth@example.com",
    password: "manual-password"
  });
  await integration.registrationManager.startSession(sessionId);

  const state = integration.registrationManager.getSessionState(sessionId);
  assert.equal(state.mode, "oauth");
  assert.equal(state.state, "completed");
  assert.equal(state.result.accountId, "account-1");
  assert.equal(oauthOptions.expectedEmail, "oauth@example.com");
  integration.dispose();
});

test("registration assistant starts the GPT-only route without OAuth and queries email once after browser entry", async () => {
  const vscode = createVscode();
  const context = createContext();
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query(account) {
      queryCalls += 1;
      return {
        ok: true,
        providerId: "mock",
        address: account.address,
        messages: [{
          id: "gpt-registration-email-message",
          subject: "OpenAI verification code",
          receivedAt: new Date().toISOString(),
          codes: ["246810"]
        }],
        codes: ["246810"]
      };
    }
  };
  let oauthCalls = 0;
  let queryCalls = 0;
  let browserOptions;
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async startOAuthAccountImport() {
      oauthCalls += 1;
      throw new Error("GPT-only route must not call OAuth");
    },
    async openRegistrationBrowser(options) {
      browserOptions = options;
      return { opened: true };
    }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await integration.pool.importProvider({ provider, input: "gpt-only@example.com|credential" });

  const sessionId = await integration.createRegistrationSession({
    email: "gpt-only@example.com",
    importCodex: false
  });
  await waitFor(() => integration.registrationManager.getSessionState(sessionId)?.state === "awaiting_manual_registration");
  const session = integration.registrationManager.getSessionState(sessionId);
  assert.equal(session.importCodex, false);
  assert.equal(session.mode, "manual-browser");
  assert.equal(oauthCalls, 0);
  assert.deepEqual(browserOptions, { clipboardText: "gpt-only@example.com" });
  await waitFor(() => integration.registrationManager.getSessionState(sessionId)?.emailCode?.phase === "received");
  assert.equal(queryCalls, 1);
  assert.equal(integration.registrationManager.getSessionState(sessionId).emailCode.code, "246810");
  assert.equal(integration.registrationEmailWatchers.has(sessionId), false);

  await integration.completeManualRegistrationSession(sessionId);
  const state = await integration.getPanelState();
  assert.equal(state.mailboxes[0].gptRegistered, true);
  assert.equal(typeof state.mailboxes[0].gptRegisteredAt, "number");
  integration.dispose();
});

test("closing the registration panel cancels GPT-only sessions but leaves the original OAuth route alone", async () => {
  const vscode = createVscode();
  const context = createContext();
  let rejectOAuth;
  let cancelledOperationId;
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async openRegistrationBrowser() { return { opened: true }; },
    startOAuthAccountImport() {
      return new Promise((_resolve, reject) => { rejectOAuth = reject; });
    },
    cancelOAuthAccountImport(operationId) {
      cancelledOperationId = operationId;
      rejectOAuth?.(new Error("OAuth login cancelled by user."));
    }
  };
  const integration = new MailboxIntegration(vscode, context, api);
  await integration.initialize();
  await integration.openRegistrationPanel();

  const gptSessionId = integration.registrationManager.createSession({
    email: "close-gpt@example.com",
    importCodex: false
  });
  const oauthSessionId = integration.registrationManager.createSession({
    email: "close-oauth@example.com",
    password: "manual-password"
  });
  const gptStarted = integration.registrationManager.startSession(gptSessionId);
  const oauthStarted = integration.registrationManager.startSession(oauthSessionId);
  await waitFor(() => integration.registrationManager.getSessionState(gptSessionId)?.state === "awaiting_manual_registration");
  await waitFor(() => integration.registrationManager.getSessionState(oauthSessionId)?.state === "awaiting_oauth");

  vscode.panels[0].dispose();
  await waitFor(() => integration.registrationManager.getSessionState(gptSessionId)?.state === "cancelled");
  assert.equal(integration.registrationManager.getSessionState(oauthSessionId).state, "awaiting_oauth");
  assert.equal(cancelledOperationId, undefined);

  await integration.registrationManager.cancelSession(oauthSessionId);
  await Promise.all([gptStarted, oauthStarted]);
  integration.dispose();
});

test("completed GPT-only registration can hand off the same mailbox to Codex import", async () => {
  const vscode = createVscode();
  const context = createContext();
  let importOptions;
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query() { return { ok: true, providerId: "mock", messages: [], codes: [] }; }
  };
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async getManagedAccountEmails() { return []; },
    async openRegistrationBrowser() { return { opened: true }; },
    async startOAuthAccountImport(options) {
      importOptions = options;
      return { accountId: "account-after-gpt", email: options.expectedEmail, quotaRefreshed: true };
    }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await integration.pool.importProvider({ provider, input: "handoff@example.com|credential" });
  const sessionId = await integration.createRegistrationSession({ email: "handoff@example.com", importCodex: false });
  await waitFor(() => integration.registrationManager.getSessionState(sessionId)?.state === "awaiting_manual_registration");

  await integration.completeManualRegistrationSession(sessionId);
  await waitFor(() => integration.pool.listMetadata()[0]?.gptRegistered === true);
  await integration.runRegistrationCodexImport(sessionId);
  await waitFor(() => importOptions && integration.codexImports.size === 0);

  assert.equal(importOptions.expectedEmail, "handoff@example.com");
  assert.match(importOptions.operationId, /^mailbox-codex-import:/u);
  integration.dispose();
});

test("registration assistant can terminate an in-flight Codex handoff without cancelling the completed GPT session", async () => {
  const vscode = createVscode();
  const context = createContext();
  let startedOptions;
  let cancelledOperationId;
  let rejectImport;
  const importGate = new Promise((_resolve, reject) => { rejectImport = reject; });
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query() { return { ok: true, providerId: "mock", messages: [], codes: [] }; }
  };
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async getManagedAccountEmails() { return []; },
    async openRegistrationBrowser() { return { opened: true }; },
    async startOAuthAccountImport(options) {
      startedOptions = options;
      return importGate;
    },
    cancelOAuthAccountImport(operationId) {
      cancelledOperationId = operationId;
      rejectImport(new Error("OAuth login cancelled by user."));
    }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await integration.openRegistrationPanel();
  await integration.pool.importProvider({ provider, input: "cancel-handoff@example.com|credential" });
  const sessionId = await integration.createRegistrationSession({ email: "cancel-handoff@example.com", importCodex: false });
  await waitFor(() => integration.registrationManager.getSessionState(sessionId)?.state === "awaiting_manual_registration");
  await integration.completeManualRegistrationSession(sessionId);
  await integration.runRegistrationCodexImport(sessionId);
  await waitFor(() => integration.codexImports.size === 1);

  await vscode.panels[0].webview.emit({
    type: "mailbox:action",
    action: "registrationCancelCodexImport",
    sessionId
  });
  await waitFor(() => integration.codexImports.size === 0);

  assert.equal(cancelledOperationId, startedOptions.operationId);
  assert.equal(integration.registrationManager.getSessionState(sessionId).state, "completed");
  assert.equal(
    vscode.panels[0].webview.messages.some(
      (message) => message.type === "toast" && message.action === "registrationCancelCodexImport" && message.level === "success"
    ),
    true
  );
  assert.equal(
    vscode.panels[0].webview.messages.some(
      (message) => message.type === "toast" && message.action === "codexImport" && message.level === "error"
    ),
    false
  );
  integration.dispose();
});

test("deleting a mailbox cancels its active registration OAuth flow", async () => {
  const vscode = createVscode();
  const context = createContext();
  const registrations = [];
  let rejectOAuth;
  let cancelledOperationId;
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query() { return { ok: true, providerId: "mock", messages: [], codes: [] }; }
  };
  const api = {
    registerDashboardIntegration(value) {
      registrations.push(value);
      return { dispose() {} };
    },
    startOAuthAccountImport() {
      return new Promise((resolve, reject) => {
        rejectOAuth = reject;
      });
    },
    cancelOAuthAccountImport(operationId) {
      cancelledOperationId = operationId;
      rejectOAuth?.(new Error("OAuth login cancelled by user."));
    }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registrations[0].runAction("open");
  await integration.pool.importProvider({ provider, input: "oauth-delete@example.com|credential" });
  const mailboxId = integration.pool.listMetadata()[0].id;
  const sessionId = integration.registrationManager.createSession({
    email: "oauth-delete@example.com",
    password: "manual-password"
  });
  const started = integration.registrationManager.startSession(sessionId);

  await waitFor(() => integration.registrationManager.getSessionState(sessionId)?.state === "awaiting_oauth");
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "registrationDeleteMailbox", mailboxId });
  await started;

  assert.match(cancelledOperationId, /^registration-oauth:/u);
  assert.equal(integration.registrationManager.getSessionState(sessionId).state, "cancelled");
  assert.equal(integration.pool.listMetadata().length, 0);
  integration.dispose();
});

test("registration assistant deletes a mailbox directly and clears all registration records", async () => {
  const vscode = createVscode();
  const context = createContext();
  const registrations = [];
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query() { return { ok: true, providerId: "mock", messages: [], codes: [] }; }
  };
  const api = {
    registerDashboardIntegration(value) {
      registrations.push(value);
      return { dispose() {} };
    }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registrations[0].runAction("open");
  await integration.pool.importProvider({ provider, input: "registered@example.com|credential" });
  const mailboxId = integration.pool.listMetadata()[0].id;
  integration.registrationManager.createSession({ email: "registered@example.com", password: "manual-password" });

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "registrationDeleteMailbox", mailboxId });
  assert.equal(integration.pool.listMetadata().length, 0);

  integration.registrationManager.createSession({ email: "another@example.com", password: "manual-password" });
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "registrationCleanupAll" });
  assert.equal(integration.registrationManager.getAllSessions().length, 0);
  assert.equal((await integration.getPanelState()).registrationSessions.length, 0);
  assert.equal(
    vscode.panels[0].webview.messages.some((message) => message.type === "toast" && message.action === "registrationCleanupAll" && /已删除 2 条注册记录/u.test(message.message || "")),
    true
  );
  integration.dispose();
});

test("default integration registers the built-in 8t92, boya and cdns providers", async () => {
  const vscode = createVscode();
  const context = createContext();
  const api = { registerDashboardIntegration() { return { dispose() {} }; } };
  const integration = new MailboxIntegration(vscode, context, api);
  await integration.initialize();

  const providers = await integration.getPanelState();
  assert.deepEqual(providers.providers.map((provider) => provider.id), ["8t92", "boya", "cdns"]);
  assert.equal(providers.providers.find((provider) => provider.id === "boya").displayName, "boya");
  assert.equal(providers.providers.find((provider) => provider.id === "cdns").displayName, "cdns");
  integration.dispose();
});

test("registration start automatically watches the matching imported mailbox and keeps OTP manual", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  let queryCalls = 0;
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query(account) {
      queryCalls += 1;
      return {
        ok: true,
        providerId: "mock",
        address: account.address,
        messages: [{
          id: "registration-email-message",
          subject: "OpenAI verification code",
          receivedAt: new Date().toISOString(),
          body: "Use 123456 to continue",
          codes: ["123456"]
        }],
        codes: ["123456"]
      };
    }
  };
  const api = { registerDashboardIntegration(value) { registration = value; return { dispose() {} }; } };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registration.runAction("open");
  await integration.pool.importProvider({ provider, input: "register@example.com|credential" });

  const sessionId = integration.registrationManager.createSession({
    email: "register@example.com",
    password: "manual-password"
  });
  integration.registrationManager.startSession = async (id) => {
    integration.registrationManager.sessions.get(id).setState("starting");
  };
  await integration.startRegistrationSession(sessionId);
  await waitFor(() => integration.registrationManager.getSessionState(sessionId)?.emailCode?.phase === "received");

  const state = integration.registrationManager.getSessionState(sessionId);
  assert.equal(queryCalls, 1);
  assert.equal(state.emailCode.code, "123456");
  assert.equal(state.emailCode.receivedAt.length > 0, true);
  assert.equal(integration.registrationEmailWatchers.has(sessionId), false);
  assert.equal(state.state, "starting");
  assert.equal(typeof integration.submitRegistrationOtp, "function");
  integration.dispose();
});

test("Manager card opens a main-editor-group panel and panel messages select/query without QuickPick", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query(account) {
      assert.equal(account.address, "one@example.com");
      return {
        ok: true,
        providerId: "mock",
        address: account.address,
        messages: [{ id: "message", subject: "Code 123456", from: "sender@example.com", codes: ["123456"], body: "Use 123456" }],
        codes: ["123456"]
      };
    }
  };
  const api = { registerDashboardIntegration(value) { registration = value; return { dispose() {} }; } };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registration.runAction("open");
  assert.equal(vscode.panels.length, 1);
  assert.equal(vscode.panels[0].column, vscode.ViewColumn.Active);

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "import", providerId: "mock", input: "one@example.com|credential" });
  const mailboxId = integration.pool.listMetadata()[0].id;
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "select", mailboxId });
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "query", mailboxId });
  await waitFor(() => {
    const latestState = vscode.panels[0].webview.messages.filter((message) => message.type === "state").at(-1)?.state;
    return integration.pool.listMetadata().find((mailbox) => mailbox.id === mailboxId)?.latestCode === "123456" && latestState?.selected?.detail?.codes?.[0] === "123456";
  });

  const stateMessage = vscode.panels[0].webview.messages.filter((message) => message.type === "state").at(-1);
  assert.equal(stateMessage.state.selected.mailbox.address, "one@example.com");
  assert.equal(stateMessage.state.selected.detail.codes[0], "123456");
  assert.equal(stateMessage.state.selected.detail.messages[0].from, "sender@example.com");
  assert.equal(
    vscode.panels[0].webview.messages.some(
      (message) => message.type === "toast" && /查询邮件完成/u.test(message.message || "")
    ),
    false
  );
  assert.equal(
    vscode.panels[0].webview.messages.some(
      (message) => message.type === "operation-complete" && message.action === "query" && message.mailboxId === mailboxId
    ),
    true
  );
  integration.dispose();
});

test("selected mailbox ids support a parallel batch query and batch delete", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  const queried = [];
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      return {
        entries: String(input).split("\n").filter(Boolean).map((line) => ({
          address: line.split("|")[0],
          credentials: { credential: line.split("|")[1] }
        })),
        failed: []
      };
    },
    async query(account) {
      queried.push(account.address);
      return { ok: true, providerId: "mock", address: account.address, messages: [], codes: [] };
    }
  };
  const api = { registerDashboardIntegration(value) { registration = value; return { dispose() {} }; } };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registration.runAction("open");
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "import", providerId: "mock", input: "one@example.com|credential\ntwo@example.com|credential" });
  const ids = integration.pool.listMetadata().map((mailbox) => mailbox.id);

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "batchQuery", mailboxIds: ids });
  await waitFor(() => integration.coordinator.isActive() === false && queried.length === 2);
  assert.deepEqual(queried.sort(), ["one@example.com", "two@example.com"]);

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "batchDelete", mailboxIds: ids });
  assert.equal(integration.pool.listMetadata().length, 0);
  integration.dispose();
});

test("provider failures remain visible as safe mailbox status details", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  const provider = {
    apiVersion: 1,
    id: "mock-error",
    displayName: "Mock error provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query(account) {
      return {
        ok: false,
        providerId: "mock-error",
        address: account.address,
        messages: [],
        codes: [],
        error: { stage: "auth", code: "invalid_credentials", message: "固定安全错误", retryable: false }
      };
    }
  };
  const api = { registerDashboardIntegration(value) { registration = value; return { dispose() {} }; } };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registration.runAction("open");
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "import", providerId: "mock-error", input: "error@example.com|opaque-secret" });
  const mailboxId = integration.pool.listMetadata()[0].id;
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "query", mailboxId });
  await waitFor(() => integration.coordinator.isActive() === false);

  const state = await integration.getPanelState();
  assert.equal(state.mailboxes[0].lastError.code, "invalid_credentials");
  assert.equal(state.mailboxes[0].lastError.message, "固定安全错误");
  assert.doesNotMatch(JSON.stringify(state), /opaque-secret/u);
  integration.dispose();
});

test("query can be stopped and an active mailbox can be deleted", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "recent", maxMessages: 10, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query(_account, { signal }) {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
      });
      return { ok: true, providerId: "mock", messages: [], codes: [] };
    }
  };
  const api = { registerDashboardIntegration(value) { registration = value; return { dispose() {} }; } };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registration.runAction("open");
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "import", providerId: "mock", input: "active@example.com|credential" });
  const mailboxId = integration.pool.listMetadata()[0].id;
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "query", mailboxId });
  await waitFor(() => integration.coordinator.isActive(mailboxId));

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "stop", mailboxId });
  await waitFor(() => integration.coordinator.isActive(mailboxId) === false);
  assert.equal(
    vscode.panels[0].webview.messages.some((message) => message.type === "toast" && message.action === "stop" && /已停止/u.test(message.message)),
    true
  );

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "delete", mailboxId });
  assert.equal(integration.pool.listMetadata().length, 0);
  assert.equal(
    vscode.panels[0].webview.messages.some((message) => message.type === "toast" && message.action === "delete" && /已删除/u.test(message.message)),
    true
  );
  integration.dispose();
});

test("Codex import is offered only for an unlinked mailbox and uses the optional Manager API", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  const imported = [];
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query() { return { ok: true, providerId: "mock", messages: [], codes: [] }; }
  };
  const api = {
    registerDashboardIntegration(value) { registration = value; return { dispose() {} }; },
    async getManagedAccountEmails() { return ["linked@example.com"]; },
    async startOAuthAccountImport(options) { imported.push(options); return { accountId: "account-1", email: options.expectedEmail, quotaRefreshed: true }; }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registration.runAction("open");
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "import", providerId: "mock", input: "new@example.com|credential" });
  const mailboxId = integration.pool.listMetadata()[0].id;
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "select", mailboxId });

  const linkedMessage = vscode.panels[0].webview.messages.filter((message) => message.type === "state").at(-1);
  assert.equal(linkedMessage.state.selectedMailboxId, mailboxId);
  assert.equal(linkedMessage.state.codexImportAvailable, true);
  assert.equal(linkedMessage.state.managedAccountEmails[0], "linked@example.com");

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "codexImport", mailboxId });
  await waitFor(() => imported.length === 1);
  assert.match(imported[0].operationId, /^mailbox-codex-import:/u);
  assert.deepEqual(imported[0], {
    operationId: imported[0].operationId,
    expectedEmail: "new@example.com",
    clipboardText: "new@example.com"
  });
  integration.dispose();
});

test("an OpenAI-deactivated mailbox can remove its reauthorization-required Codex account", async () => {
  const vscode = createVscode();
  const context = createContext();
  const removedAccountIds = [];
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query(account) {
      return {
        ok: true,
        providerId: "mock",
        address: account.address,
        messages: [{
          id: "deactivated-message",
          subject: "Your account has been deactivated",
          from: ["no-reply", "openai.com"].join("@"),
          body: "Your account has been deactivated."
        }],
        codes: []
      };
    }
  };
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async getManagedAccountEmails() { return ["deactivated@example.com"]; },
    async getManagedAccountDirectory() {
      return [{ accountId: "codex-account-1", email: "deactivated@example.com", requiresReauthorization: true }];
    },
    async removeManagedAccount(accountId) { removedAccountIds.push(accountId); }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await integration.openPanel();
  await vscode.panels[0].webview.emit({
    type: "mailbox:action",
    action: "import",
    providerId: "mock",
    input: "deactivated@example.com|credential"
  });
  const mailboxId = integration.pool.listMetadata()[0].id;
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "query", mailboxId });
  await waitFor(() => integration.coordinator.isActive(mailboxId) === false && integration.pool.listMetadata()[0].openaiAccountDeactivated === true);

  const state = await integration.getPanelState();
  assert.deepEqual(state.managedAccounts, [{
    accountId: "codex-account-1",
    email: "deactivated@example.com",
    requiresReauthorization: true
  }]);
  assert.equal(state.managedAccountRemovalAvailable, true);

  await vscode.panels[0].webview.emit({
    type: "mailbox:action",
    action: "deleteMailboxAndCodex",
    mailboxId
  });
  assert.deepEqual(removedAccountIds, ["codex-account-1"]);
  assert.equal(integration.pool.listMetadata().length, 0);
  assert.equal(
    vscode.panels[0].webview.messages.some(
      (message) => message.type === "toast" && message.action === "deleteMailboxAndCodex" && message.level === "success"
    ),
    true
  );
  integration.dispose();
});

test("bulk deactivated cleanup only removes matched accounts that require reauthorization", async () => {
  const vscode = createVscode();
  const context = createContext();
  const removedAccountIds = [];
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      return {
        entries: String(input).split("\n").filter(Boolean).map((address) => ({ address, credentials: { credential: address } })),
        failed: []
      };
    },
    async query() {
      return { ok: true, messages: [], codes: [] };
    }
  };
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async getManagedAccountDirectory() {
      return [
        { accountId: "codex-eligible", email: "eligible@example.com", requiresReauthorization: true },
        { accountId: "codex-healthy", email: "healthy@example.com", requiresReauthorization: false },
        { accountId: "codex-unflagged", email: "unflagged@example.com", requiresReauthorization: true }
      ];
    },
    async removeManagedAccount(accountId) { removedAccountIds.push(accountId); }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  const imported = await integration.pool.importProvider({
    provider,
    input: "eligible@example.com\nhealthy@example.com\nunflagged@example.com"
  });
  const ids = new Map(imported.imported.map((mailbox) => [mailbox.address, mailbox.id]));
  const deactivationMessage = {
    subject: "Your account has been deactivated",
    from: ["no-reply", "openai.com"].join("@"),
    body: "Your account has been deactivated."
  };
  await integration.pool.recordQueryResult(ids.get("eligible@example.com"), { ok: true, messages: [{ id: "eligible", ...deactivationMessage }] });
  await integration.pool.recordQueryResult(ids.get("healthy@example.com"), { ok: true, messages: [{ id: "healthy", ...deactivationMessage }] });

  await integration.deleteDeactivatedMailboxes();

  assert.deepEqual(removedAccountIds, ["codex-eligible"]);
  assert.deepEqual(integration.pool.listMetadata().map((mailbox) => mailbox.address).sort(), [
    "healthy@example.com",
    "unflagged@example.com"
  ]);
  integration.dispose();
});

test("deactivated cleanup rechecks the matching mailbox message before deleting", async () => {
  const vscode = createVscode();
  const context = createContext();
  const removedAccountIds = [];
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query() { return { ok: true, messages: [], codes: [] }; }
  };
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async getManagedAccountDirectory() {
      return [{ accountId: "codex-stale", email: "stale@example.com", requiresReauthorization: true }];
    },
    async removeManagedAccount(accountId) { removedAccountIds.push(accountId); }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  const [{ id }] = (await integration.pool.importProvider({
    provider,
    input: "stale@example.com|credential"
  })).imported;
  const deactivationMessage = {
    id: "stale-deactivated",
    subject: "Your account has been deactivated",
    from: ["no-reply", "openai.com"].join("@"),
    body: "Your account has been deactivated."
  };
  await integration.pool.recordQueryResult(id, { ok: true, messages: [deactivationMessage] });
  // Simulate a legacy stale summary marker after replacing the saved detail
  // with an ordinary result. A marker alone must not authorize a destructive action.
  await integration.pool.recordQueryResult(id, { ok: true, messages: [] });
  integration.pool.metadata.accounts[0].openaiAccountDeactivated = true;
  assert.equal(integration.pool.listMetadata()[0].openaiAccountDeactivated, true);

  await assert.rejects(
    () => integration.deleteMailboxAndCodex(id),
    /对应邮箱没有保存的 OpenAI account deactivated 邮件/u
  );
  await assert.rejects(
    () => integration.deleteDeactivatedMailboxes(),
    /当前没有同时满足失效邮件、邮箱匹配和需要重新授权条件的账号/u
  );
  assert.deepEqual(removedAccountIds, []);
  assert.equal(integration.pool.listMetadata().length, 1);
  integration.dispose();
});

test("registration rejects an email that is already imported into Codex", async () => {
  const vscode = createVscode();
  const context = createContext();
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async getManagedAccountEmails() { return ["Linked@example.com"]; },
    async startOAuthAccountImport() { throw new Error("should not start"); }
  };
  const integration = new MailboxIntegration(vscode, context, api);
  await integration.initialize();

  await assert.rejects(
    () => integration.createRegistrationSession({ email: " linked@example.com " }),
    /已经导入 Codex 账号/u
  );
  assert.equal(integration.registrationManager.getAllSessions().length, 0);
  const state = await integration.getPanelState();
  assert.equal(state.managedAccountEmailsAvailable, true);
  assert.deepEqual(state.managedAccountEmails, ["Linked@example.com"]);
  integration.dispose();
});

test("Codex OAuth import does not block mailbox query for the same mailbox", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  let releaseImport;
  const importGate = new Promise((resolve) => { releaseImport = resolve; });
  let queryCalls = 0;
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query() {
      queryCalls += 1;
      return { ok: true, providerId: "mock", messages: [], codes: [] };
    }
  };
  const api = {
    registerDashboardIntegration(value) { registration = value; return { dispose() {} }; },
    async getManagedAccountEmails() { return []; },
    async startOAuthAccountImport(options) {
      await importGate;
      return { accountId: "account-1", email: options.expectedEmail, quotaRefreshed: true };
    }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registration.runAction("open");
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "import", providerId: "mock", input: "parallel@example.com|credential" });
  const mailboxId = integration.pool.listMetadata()[0].id;
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "codexImport", mailboxId });
  await waitFor(() => integration.codexImports.has(mailboxId));

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "query", mailboxId });
  await waitFor(() => queryCalls === 1 && integration.coordinator.isActive() === false);
  releaseImport();
  await waitFor(() => integration.codexImports.has(mailboxId) === false);
  integration.dispose();
});

test("shared Stop cancels an in-flight Codex OAuth import", async () => {
  const vscode = createVscode();
  const context = createContext();
  let registration;
  let startedOptions;
  let rejectImport;
  const importGate = new Promise((_resolve, reject) => { rejectImport = reject; });
  const provider = {
    apiVersion: 1,
    id: "mock",
    displayName: "Mock provider",
    capabilities: { history: "latest", maxMessages: 1, manualRenewal: false },
    importSchema: { label: "Mock row", placeholder: "address|credential" },
    parseImport(input) {
      const [address, credential] = String(input).split("|");
      return { entries: [{ address, credentials: { credential } }], failed: [] };
    },
    async query() { return { ok: true, providerId: "mock", messages: [], codes: [] }; }
  };
  const api = {
    registerDashboardIntegration(value) { registration = value; return { dispose() {} }; },
    async getManagedAccountEmails() { return []; },
    async startOAuthAccountImport(options) {
      startedOptions = options;
      return importGate;
    },
    cancelOAuthAccountImport(operationId) {
      assert.equal(operationId, startedOptions.operationId);
      rejectImport(new Error("OAuth login cancelled by user."));
    }
  };
  const integration = new MailboxIntegration(vscode, context, api, { providers: [provider] });
  await integration.initialize();
  await registration.runAction("open");
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "import", providerId: "mock", input: "cancel@example.com|credential" });
  const mailboxId = integration.pool.listMetadata()[0].id;
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "codexImport", mailboxId });
  await waitFor(() => integration.codexImports.has(mailboxId));

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "stop", mailboxId });
  await waitFor(() => integration.codexImports.has(mailboxId) === false);
  assert.match(startedOptions.operationId, /^mailbox-codex-import:/u);
  assert.equal(
    vscode.panels[0].webview.messages.some(
      (message) => message.type === "toast" && message.action === "codexImport" && message.level === "error"
    ),
    false
  );
  assert.equal(
    vscode.panels[0].webview.messages.some(
      (message) => message.type === "toast" && message.action === "stop" && message.level === "success"
    ),
    true
  );
  integration.dispose();
});

test("Mailbox copy requests use the VS Code clipboard and retry transient failures", async () => {
  const vscode = createVscode();
  const context = createContext();
  const api = { registerDashboardIntegration() { return { dispose() {} }; } };
  const integration = new MailboxIntegration(vscode, context, api);
  await integration.initialize();
  await integration.openRegistrationPanel();

  let attempts = 0;
  vscode.env.clipboard.writeText = async (value) => {
    attempts += 1;
    if (attempts < 3) throw new Error("transient clipboard error");
    vscode.clipboardWrites.push(value);
  };

  await vscode.panels[0].webview.emit({
    type: "mailbox:action",
    action: "copyText",
    text: "retry-code",
    successMessage: "验证码已复制"
  });

  assert.equal(attempts, 3);
  assert.deepEqual(vscode.clipboardWrites, ["retry-code"]);
  assert.equal(
    vscode.panels[0].webview.messages.some(
      (message) => message.type === "toast" && message.action === "clipboardCopy" && message.level === "success"
    ),
    true
  );
  integration.dispose();
});

test("registration email, phone, and SMS codes are auto-copied by the host clipboard", async () => {
  const vscode = createVscode();
  const context = createContext();
  const api = { registerDashboardIntegration() { return { dispose() {} }; } };
  const integration = new MailboxIntegration(vscode, context, api);
  await integration.initialize();
  await integration.openRegistrationPanel();

  const sessionId = integration.registrationManager.createSession({
    email: "clipboard@example.com",
    password: "manual-password"
  });
  const session = integration.registrationManager._get(sessionId);
  session.phoneOrder = {
    snapshot() {
      return {
        phase: "received",
        order: { phone: "+8613800000000", smsCode: "123456" }
      };
    }
  };
  integration.registrationManager.setEmailCodeState(sessionId, {
    phase: "received",
    code: "email-123"
  });
  await waitFor(() => vscode.clipboardWrites.length === 3);

  assert.deepEqual(vscode.clipboardWrites, ["email-123", "+8613800000000", "123456"]);
  await integration.syncRegistrationClipboard({ sessionId });
  assert.deepEqual(vscode.clipboardWrites, ["email-123", "+8613800000000", "123456"]);
  integration.dispose();
});

test("registration phone keys are claimed for取号, consumed on SMS, and released otherwise", async () => {
  const vscode = createVscode();
  const context = createContext();
  const api = { registerDashboardIntegration() { return { dispose() {} }; } };
  const integration = new MailboxIntegration(vscode, context, api);
  await integration.initialize();
  await integration.openRegistrationPanel();
  const sessionId = integration.registrationManager.createSession({ email: "phone-key@example.com", password: "password" });
  let acquired;
  integration.registrationManager.acquirePhoneNumber = async (_id, code, options) => {
    acquired = { code, options };
    return { phase: "polling", running: true };
  };

  await integration.addRegistrationPhoneKeys("POOL-KEY-1\nPOOL-KEY-2");
  const before = await integration.getPanelState();
  assert.equal(before.phoneSources[0].id, "liye");
  const keyId = before.registrationKeyPool.keys[0].id;
  await integration.acquireRegistrationPhone(sessionId, { sourceId: "liye", keyId });
  assert.equal(acquired.code, "POOL-KEY-1");
  assert.equal(acquired.options.cardKeyId, keyId);
  assert.equal((await integration.getPanelState()).registrationKeyPool.inUse, 1);

  await integration.syncRegistrationPhoneKey({
    sessionId,
    phoneOrder: { phase: "received", order: { phone: "+8613800000000", smsCode: "123456" } }
  });
  const afterCode = await integration.getPanelState();
  assert.equal(afterCode.registrationKeyPool.count, 1);
  assert.equal(afterCode.registrationKeyPool.inUse, 0);
  assert.equal(
    vscode.panels.flatMap((panel) => panel.webview.messages).some((message) => message.action === "registrationPhoneCodeReceived" && message.level === "success"),
    true
  );

  const nextKeyId = afterCode.registrationKeyPool.keys[0].id;
  await integration.acquireRegistrationPhone(sessionId, { sourceId: "liye", keyId: nextKeyId });
  await integration.releaseRegistrationPhoneKey(sessionId);
  assert.equal((await integration.getPanelState()).registrationKeyPool.available, 1);
  integration.dispose();
});

function createVscode() {
  class EventEmitter {
    constructor() { this.listeners = new Set(); this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
    fire() { for (const listener of this.listeners) listener(); }
    dispose() { this.listeners.clear(); }
  }
  const vscode = {
    EventEmitter,
    ViewColumn: { Active: 1, Beside: 2 },
    panels: [],
    clipboardWrites: [],
    env: {
      clipboard: {
        async writeText(value) {
          vscode.clipboardWrites.push(value);
        }
      }
    },
    commands: { registerCommand(_id, handler) { vscode.commandHandler = handler; return { dispose() {} }; } },
    window: {
      createWebviewPanel(viewType, title, options) {
        const panel = createPanel(vscode, options.viewColumn);
        panel.viewType = viewType;
        panel.title = title;
        vscode.panels.push(panel);
        return panel;
      },
      showWarningMessage() {}
    }
  };
  return vscode;
}

function createPanel(vscode, column) {
  const listeners = new Set();
  const panel = {
    column,
    webview: {
      messages: [],
      html: "",
      onDidReceiveMessage(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
      async postMessage(message) { this.messages.push(message); return true; },
      async emit(message) { for (const listener of listeners) await listener(message); }
    },
    onDidDispose(listener) { panel.disposeListener = listener; return { dispose() {} }; },
    reveal() {},
    dispose() { panel.disposeListener?.(); }
  };
  return panel;
}

function createContext() {
  const state = new Map();
  const secrets = new Map();
  return {
    subscriptions: [],
    globalState: {
      async get(key) { return state.get(key); },
      async update(key, value) { state.set(key, structuredClone(value)); }
    },
    secrets: {
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); }
    }
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for operation");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
