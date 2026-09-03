"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { BugTeamIntegration, normalizeShelves, safeError } = require("../src/ui/integration.cjs");

test("BugTeam integration errors redact the configured token", () => {
  assert.equal(
    safeError(new Error("request failed for cfk_secret_value"), "fallback", "cfk_secret_value"),
    "request failed for [redacted]"
  );
});

test("BugTeam panel remains openable when a historical import error exists without a token", async () => {
  const vscode = createVscode();
  const context = createContext();
  await context.globalState.update("codexAccounts.bugteam.order.v1", {
    state: "completed",
    imported: false,
    lastImportError: "账号已导入，但仅 0/1 个启用无感池"
  });
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async importSharedAccountsToBalancePool() { return {}; }
  };
  const integration = new BugTeamIntegration(vscode, context, api);

  await integration.initialize();

  assert.equal(integration.getViewModel().actions.find((action) => action.id === "open")?.enabled, true);
  await integration.runAction("open");
  assert.equal(vscode.panels.length, 1);
  integration.dispose();
});

test("BugTeam normalizes dispatch shelf buckets for the panel", () => {
  assert.deepEqual(
    normalizeShelves({
      buckets: [
        {
          bucket_start: "2026-08-17T06:10:00Z",
          departure_at: "2026-08-17T06:10:00Z",
          available: 3,
          sold: 12,
          minimum_remaining_seconds: 2400,
          maximum_remaining_seconds: 3600
        }
      ]
    }),
    [{
      bucketStart: "2026-08-17T06:10:00Z",
      departureAt: "2026-08-17T06:10:00Z",
      available: 3,
      sold: 12,
      minimumRemainingSeconds: 2400,
      maximumRemainingSeconds: 3600
    }]
  );
});

test("BugTeam submits a selected dispatch shelf and shows a success toast", async () => {
  const vscode = createVscode();
  const context = createContext();
  const creates = [];
  const bucketStart = "2026-08-17T06:10:00Z";
  const client = {
    async getDashboard() { return { products: [{ code: "oauth_1h", name: "1h OAuth", billing_base_seconds: 3600, price_fen: 300 }] }; },
    async getBalance() { return { balance_fen: 1000, held_fen: 0, available_fen: 1000 }; },
    async getInventory(_product, _quantity, expiryBucketStart) {
      return { available: 2, hold_total_fen: expiryBucketStart ? 300 : 300, estimated_total_fen: 300 };
    },
    async getInventoryShelves() {
      return { buckets: [{ bucket_start: bucketStart, departure_at: bucketStart, available: 2, sold: 8, minimum_remaining_seconds: 2400, maximum_remaining_seconds: 3600 }] };
    },
    async createPickupOrder(input) {
      creates.push(input);
      return { order_id: "shelf-order", state: "waiting_inventory", quantity: 1, delivered_quantity: 0 };
    },
    async getPickupOrder() { return { order_id: "shelf-order", state: "waiting_inventory", quantity: 1, delivered_quantity: 0 }; }
  };
  const api = { registerDashboardIntegration() { return { dispose() {} }; }, importSharedAccountsToBalancePool: async () => ({}) };
  const integration = new BugTeamIntegration(vscode, context, api, { clientFactory: () => client, pollIntervalMs: 60_000 });

  await integration.initialize();
  await integration.openPanel();
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "setToken", token: "cfk_test" });
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "purchaseShelf", bucketStart });

  assert.equal(creates.length, 1);
  assert.equal(creates[0].expiryBucketStart, bucketStart);
  assert.equal(integration.getPanelState().shelves[0].available, 2);
  assert.ok(vscode.panels[0].webview.messages.some((message) => message.type === "toast" && message.level === "success"));
  assert.ok(vscode.panels[0].webview.messages.some((message) => message.type === "actionResult" && message.action === "purchaseShelf" && message.level === "success"));
  integration.dispose();
});

test("Tingbai credential validation publishes state without losing the final button result", async () => {
  const vscode = createVscode();
  const context = createContext();
  const clientFactory = () => ({
    authenticated: false,
    async login(username) {
      this.authenticated = true;
      return { csrf_token: "csrf", buyer: { username, balance_fen: 900, currency: "CNY" } };
    },
    async getCatalog() {
      return { products: [{ code: "team-7d", name: "Team 7D", unit_price_fen: 300, available: 0 }] };
    },
    async getWallet() {
      return { buyer: { username: "buyer-one", balance_fen: 900, currency: "CNY" } };
    }
  });
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async importSharedAccountsToBalancePool() { return {}; }
  };
  const integration = new BugTeamIntegration(vscode, context, api, { tingbaiClientFactory: clientFactory });

  await integration.initialize();
  await integration.openPanel();
  await vscode.panels[0].webview.emit({
    type: "bugteam:action",
    action: "tingbaiSetCredentials",
    username: "buyer-one",
    password: "password-one"
  });

  assert.equal(integration.getPanelState().tingbai.credentialsConfigured, true);
  assert.ok(vscode.panels[0].webview.messages.some((message) => message.type === "state" && message.state.tingbai.credentialsConfigured));
  assert.ok(vscode.panels[0].webview.messages.some((message) => message.type === "actionResult" && message.action === "tingbaiSetCredentials" && message.level === "success"));

  await vscode.panels[0].webview.emit({
    type: "bugteam:action",
    action: "tingbaiStartWaitlist",
    minTotalFen: 300,
    maxTotalFen: 450
  });

  assert.equal(integration.getPanelState().tingbai.waitlist.minTotalFen, 300);
  assert.equal(integration.getPanelState().tingbai.waitlist.maxTotalFen, 450);
  assert.ok(vscode.panels[0].webview.messages.some((message) => message.type === "actionResult" && message.action === "tingbaiStartWaitlist" && message.level === "success"));
  integration.dispose();
});

test("Website actions return final button feedback", async () => {
  const vscode = createVscode();
  const context = createContext();
  const opened = [];
  vscode.env.openExternal = async (uri) => { opened.push(uri); return true; };
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async importSharedAccountsToBalancePool() { return {}; }
  };
  const integration = new BugTeamIntegration(vscode, context, api);

  await integration.initialize();
  await integration.openPanel();
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "openWebsite" });
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "tingbaiOpenWebsite" });

  assert.equal(opened.length, 2);
  assert.ok(vscode.panels[0].webview.messages.some((message) => message.type === "actionResult" && message.action === "openWebsite" && message.level === "success"));
  assert.ok(vscode.panels[0].webview.messages.some((message) => message.type === "actionResult" && message.action === "tingbaiOpenWebsite" && message.level === "success"));
  integration.dispose();
});

test("BugTeam creates one idempotent order, downloads Sub2, and imports the account into the pool", async () => {
  const vscode = createVscode();
  const context = createContext();
  const calls = { create: [], imports: [] };
  const client = {
    async getDashboard() {
      return { products: [{ code: "oauth_1h", name: "1h OAuth", billing_base_seconds: 3600, price_fen: 300 }] };
    },
    async getBalance() {
      return { balance_fen: 1000, held_fen: 0, available_fen: 1000, currency: "CNY" };
    },
    async getInventory() {
      return { available: 1, missing: 0, hold_total_fen: 300, estimated_total_fen: 300 };
    },
    async createPickupOrder(input) {
      calls.create.push(input);
      return { order_id: "order-1", status_url: "/api/customer/pickup/orders/order-1" };
    },
    async getPickupOrder() {
      return { order_id: "order-1", state: "completed", quantity: 1, delivered_quantity: 1 };
    },
    async downloadSub2() {
      return { accounts: [{ email: "one@example.test", tokens: { id_token: "id", access_token: "access" } }], proxies: [] };
    }
  };
  const api = {
    registerDashboardIntegration(value) {
      this.registration = value;
      return { dispose() {} };
    },
    async importSharedAccountsToBalancePool(accounts) {
      calls.imports.push(accounts);
      return {
        status: "completed",
        total: accounts.length,
        imported: accounts.length,
        poolEnabled: accounts.length,
        refreshFailed: 0,
        notEligible: 0,
        authFailed: 0,
        importFailed: 0,
        accounts: [{
          accountId: "account-one",
          email: "one@example.test",
          planType: "team",
          hourlyPercentage: 82,
          weeklyPercentage: 94,
          creditsBalance: "12.50",
          poolEnabled: true,
          status: "ready"
        }]
      };
    }
  };
  const integration = new BugTeamIntegration(vscode, context, api, {
    clientFactory: () => client,
    pollIntervalMs: 60_000
  });

  await integration.initialize();
  await integration.openPanel();
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "setToken", token: "cfk_test" });
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "purchase" });

  assert.equal(calls.create.length, 1);
  assert.match(calls.create[0].idempotencyKey, /^bugteam-|^[0-9a-f-]{36}$/u);
  assert.equal(calls.imports.length, 1);
  assert.equal(calls.imports[0][0].tokens.access_token, "access");
  assert.equal(integration.getPanelState().order.imported, true);
  assert.equal(integration.getPanelState().order.importResult.poolEnabled, 1);
  assert.deepEqual(integration.getPanelState().order.importResult.accounts[0], {
    accountId: "account-one",
    email: "one@example.test",
    planType: "team",
    hourlyPercentage: 82,
    weeklyPercentage: 94,
    creditsBalance: "12.50",
    poolEnabled: true,
    status: "ready"
  });
  assert.equal(context.secrets.getValue("codexAccounts.bugteam.apiToken.v1"), "cfk_test");
  await integration.clearToken();
  assert.equal(context.secrets.getValue("codexAccounts.bugteam.apiToken.v1"), undefined);
  integration.dispose();
});

test("BugTeam skips an existing managed account instead of importing it again", async () => {
  const vscode = createVscode();
  const context = createContext();
  let importAttempts = 0;
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async getManagedAccountEmails() { return ["EXISTING-MANAGED@example.test"]; },
    async importSharedAccountsToBalancePool() {
      importAttempts += 1;
      throw new Error("existing account must not be imported again");
    }
  };
  const integration = new BugTeamIntegration(vscode, context, api);

  const summary = await integration.importSharedBundle({
    accounts: [{ email: "existing-managed@example.test", tokens: { id_token: "id", access_token: "access" } }]
  });

  assert.equal(importAttempts, 0);
  assert.equal(summary.status, "completed");
  assert.equal(summary.total, 1);
  assert.equal(summary.imported, 1);
  assert.equal(summary.poolEnabled, 0);
  assert.equal(summary.skippedExisting, 1);
  assert.deepEqual(summary.accounts, [{
    email: "existing-managed@example.test",
    poolEnabled: false,
    status: "already_exists"
  }]);
  integration.dispose();
});

test("BugTeam retries an uncertain create with the same idempotency key", async () => {
  const vscode = createVscode();
  const context = createContext();
  const creates = [];
  const client = {
    async getDashboard() { return { products: [{ code: "oauth_1h", billing_base_seconds: 3600, price_fen: 300 }] }; },
    async getBalance() { return { available_fen: 1000 }; },
    async getInventory() { return { hold_total_fen: 300 }; },
    async createPickupOrder(input) {
      creates.push(input);
      if (creates.length === 1) throw new Error("network timeout");
      return { order_id: "order-recovered", state: "waiting_inventory", quantity: 1, delivered_quantity: 0 };
    },
    async getPickupOrder() { return { order_id: "order-recovered", state: "waiting_inventory", quantity: 1, delivered_quantity: 0 }; }
  };
  const api = { registerDashboardIntegration() { return { dispose() {} }; }, importSharedAccountsToBalancePool: async () => ({}) };
  const integration = new BugTeamIntegration(vscode, context, api, { clientFactory: () => client });
  await integration.initialize();
  await integration.openPanel();
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "setToken", token: "cfk_test" });
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "purchase" });
  const firstKey = context.globalState.getValue("codexAccounts.bugteam.order.v1").idempotencyKey;
  assert.equal(creates.length, 1);
  assert.equal(integration.getPanelState().order.uncertain, true);
  assert.equal(integration.getPanelState().order.state, "uncertain");
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "purchase" });
  assert.equal(creates.length, 2);
  assert.equal(creates[1].idempotencyKey, firstKey);
  assert.equal(integration.getPanelState().order.orderId, "order-recovered");
  assert.equal(integration.getPanelState().order.uncertain, false);
  assert.equal(context.globalState.getValue("codexAccounts.bugteam.order.v1").idempotencyKey, firstKey);
  integration.dispose();
});

test("BugTeam stops automatic retries after import succeeds even when pool enrollment is partial", async () => {
  const vscode = createVscode();
  const context = createContext();
  let importAttempts = 0;
  const client = {
    async getDashboard() { return { products: [{ code: "oauth_1h", billing_base_seconds: 3600, price_fen: 300 }] }; },
    async getBalance() { return { available_fen: 1000 }; },
    async getInventory() { return { hold_total_fen: 300 }; },
    async createPickupOrder() { return { order_id: "order-partial", state: "waiting_inventory", quantity: 1 }; },
    async getPickupOrder() { return { order_id: "order-partial", state: "completed", quantity: 1, delivered_quantity: 1 }; },
    async downloadSub2() { return { accounts: [{ email: "partial@example.test", tokens: { id_token: "id", access_token: "access" } }] }; }
  };
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async getManagedAccountEmails() { return importAttempts > 0 ? ["partial@example.test"] : []; },
    async importSharedAccountsToBalancePool() {
      importAttempts += 1;
      return { status: "partial", total: 1, imported: 1, poolEnabled: 0, refreshFailed: 1, notEligible: 0, authFailed: 1, importFailed: 0 };
    }
  };
  const integration = new BugTeamIntegration(vscode, context, api, { clientFactory: () => client, pollIntervalMs: 60_000 });

  await integration.initialize();
  await integration.openPanel();
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "setToken", token: "cfk_test" });
  await vscode.panels[0].webview.emit({ type: "bugteam:action", action: "purchase" });

  assert.equal(integration.getPanelState().order.imported, true);
  assert.equal(integration.getPanelState().order.importResult.poolEnabled, 0);
  assert.match(integration.getPanelState().order.lastImportError, /仅 0\/1 个启用无感池/u);
  assert.equal(integration.pollTimer, undefined);

  integration.lastImportAttemptAt = 0;
  await integration.pollOrder();

  assert.equal(importAttempts, 1);
  await integration.processCompletedOrder(true);

  assert.equal(importAttempts, 1);
  assert.equal(integration.getPanelState().order.imported, true);
  assert.equal(integration.getPanelState().order.importResult.skippedExisting, 1);
  assert.equal(integration.getPanelState().order.lastImportError, undefined);
  assert.equal(integration.pollTimer, undefined);
  integration.dispose();
});

test("BugTeam resolves a persisted completed order by skipping its existing account", async () => {
  const vscode = createVscode();
  const context = createContext();
  await context.secrets.store("codexAccounts.bugteam.apiToken.v1", "cfk_test");
  await context.globalState.update("codexAccounts.bugteam.order.v1", {
    orderId: "order-resume",
    state: "completed",
    imported: false,
    lastImportError: "账号已导入，但仅 0/1 个启用无感池"
  });
  let releaseDashboard;
  const dashboardReady = new Promise((resolve) => { releaseDashboard = resolve; });
  const client = {
    async getDashboard() {
      await dashboardReady;
      return { products: [{ code: "oauth_1h", billing_base_seconds: 3600, price_fen: 300 }] };
    },
    async getBalance() { return { available_fen: 1000 }; },
    async getInventory() { return { hold_total_fen: 300 }; },
    async getPickupOrder() { return { order_id: "order-resume", state: "completed", quantity: 1, delivered_quantity: 1 }; },
    async downloadSub2() { return { accounts: [{ email: "resume@example.test", tokens: { id_token: "id", access_token: "access" } }] }; }
  };
  let importAttempts = 0;
  const api = {
    registerDashboardIntegration() { return { dispose() {} }; },
    async getManagedAccountEmails() { return ["resume@example.test"]; },
    async importSharedAccountsToBalancePool() {
      importAttempts += 1;
      throw new Error("existing account must not be imported again");
    }
  };
  const integration = new BugTeamIntegration(vscode, context, api, { clientFactory: () => client, pollIntervalMs: 60_000 });

  await integration.initialize();

  assert.match(integration.getViewModel().statusMessage, /仅 0\/1 个启用无感池/u);
  assert.notEqual(integration.pollTimer, undefined);
  releaseDashboard();
  await waitFor(() => integration.getPanelState().order.imported === true);

  assert.equal(importAttempts, 0);
  assert.equal(integration.getPanelState().order.imported, true);
  assert.equal(integration.getPanelState().order.importResult.skippedExisting, 1);
  assert.equal(integration.pollTimer, undefined);
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
    Uri: { parse(value) { return value; } },
    env: { async openExternal() {} },
    panels: [],
    commands: { registerCommand(_id, handler) { vscode.commandHandler = handler; return { dispose() {} }; } },
    window: {
      createWebviewPanel(_viewType, _title, options) {
        const panel = createPanel(vscode, options.viewColumn);
        vscode.panels.push(panel);
        return panel;
      }
    }
  };
  return vscode;
}

function createPanel(_vscode, column) {
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
      async update(key, value) { state.set(key, structuredClone(value)); },
      getValue(key) { return state.get(key); }
    },
    secrets: {
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); },
      getValue(key) { return secrets.get(key); }
    }
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
