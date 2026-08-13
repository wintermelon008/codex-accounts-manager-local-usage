"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MailboxIntegration, INTEGRATION_ID } = require("../../src/ui/integration.cjs");

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

test("Manager card opens a parallel editor panel and panel messages select/query without QuickPick", async () => {
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
  assert.equal(vscode.panels[0].column, vscode.ViewColumn.Beside);

  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "import", providerId: "mock", input: "one@example.com|credential" });
  const mailboxId = integration.pool.listMetadata()[0].id;
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "select", mailboxId });
  await vscode.panels[0].webview.emit({ type: "mailbox:action", action: "query", mailboxId });
  await waitFor(() => integration.coordinator.isActive() === false);

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

function createVscode() {
  class EventEmitter {
    constructor() { this.listeners = new Set(); this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
    fire() { for (const listener of this.listeners) listener(); }
    dispose() { this.listeners.clear(); }
  }
  const vscode = {
    EventEmitter,
    ViewColumn: { Beside: 2 },
    panels: [],
    commands: { registerCommand(_id, handler) { vscode.commandHandler = handler; return { dispose() {} }; } },
    window: {
      createWebviewPanel(_viewType, _title, options) {
        const panel = createPanel(vscode, options.viewColumn);
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
