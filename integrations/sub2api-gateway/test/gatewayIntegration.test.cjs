"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSub2ApiGatewayConfigTemplate } = require("../src/config.cjs");
const { Sub2ApiGatewayIntegration, checkGatewayHealth, normalizeDownstreamCredential } = require("../src/gatewayIntegration.cjs");

test("an invalid optional observer keeps the downstream Gateway configurable", async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-integration-"));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const template = createSub2ApiGatewayConfigTemplate();
  await fs.writeFile(
    path.join(storage, "sub2api-gateway.json"),
    `${JSON.stringify(
      {
        ...template,
        inventoryObserver: {
          ...template.inventoryObserver,
          adminBaseUrl: "https://gateway.example.invalid/v1"
        }
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  const api = createApi();
  const integration = new Sub2ApiGatewayIntegration(createVscode(), createContext(storage), api);
  await integration.initialize();
  const card = integration.getCardViewModel();

  assert.equal(detail(card, "下游").value, "https://gateway.example.invalid/v1");
  assert.equal(detail(card, "模型").value, "gpt-5");
  assert.equal(action(card, "configureCredential").enabled, true);
  assert.equal(action(card, "refresh").enabled, true);
  assert.equal(api.dashboardRegistrations, 0);
  assert.deepEqual(card.details.map((entry) => entry.label), ["下游", "模型", "下游密钥"]);
  assert.deepEqual(card.actions.map((entry) => entry.id), ["configureCredential", "refresh", "openConfig"]);
  assert.equal(card.usage.range, "5h");
  assert.equal(card.usage.status, "waiting");
  assert.equal(card.usage.byModel[0].model, "gpt-5");
  assert.equal(card.details.some((entry) => entry.label.includes("上游") || entry.label.includes("库存")), false);
  assert.deepEqual(api.virtualRegistrations[0].descriptor, {
    integrationId: "sub2api-gateway",
    baseUrl: "https://gateway.example.invalid/v1",
    model: "gpt-5",
    credentialRef: "primary"
  });
  assert.equal(Object.hasOwn(api.virtualRegistrations[0].descriptor, "apiKey"), false);

  integration.dispose();
});

test("normalizes a pasted Bearer prefix and sends a single downstream authorization scheme", async () => {
  assert.equal(normalizeDownstreamCredential("  Bearer downstream-key  "), "downstream-key");
  let request;
  const health = await checkGatewayHealth(
    { sub2api: { baseUrl: "https://gateway.example.invalid/v1" } },
    normalizeDownstreamCredential("Bearer downstream-key"),
    {
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response("{}", { status: 200 });
      }
    }
  );
  assert.equal(request.url, "https://gateway.example.invalid/v1/models");
  assert.equal(request.options.headers.authorization, "Bearer downstream-key");
  assert.deepEqual(health, { kind: "healthy", message: "下游健康检查成功。" });
});

test("the Manager setting only persists card visibility and never changes the Gateway route", async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-integration-"));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const api = createApi();
  const context = createContext(storage);
  const integration = new Sub2ApiGatewayIntegration(createVscode(), context, api);
  await integration.initialize();

  const setting = api.virtualRegistrations[0].setting;
  assert.equal(setting.id, "sub2api-gateway-card-visible");
  assert.equal(setting.getEnabled(), true);
  await setting.setEnabled(false);

  assert.equal(setting.getEnabled(), false);
  assert.equal(context.globalState.get("sub2apiGateway.cardVisibility.v1"), false);
  assert.equal(api.gatewayActivateCalls, 0);
  assert.equal(api.gatewayDeactivateCalls, 0);
  integration.dispose();
});

test("explains that an administrator login token cannot satisfy a downstream 401", async () => {
  const health = await checkGatewayHealth(
    { sub2api: { baseUrl: "https://gateway.example.invalid/v1" } },
    "rejected-key",
    { fetchImpl: async () => new Response("{}", { status: 401 }) }
  );
  assert.equal(health.kind, "warning");
  assert.match(health.message, /普通 API Key/u);
  assert.match(health.message, /管理端登录令牌/u);
});

function detail(view, label) {
  return view.details.find((entry) => entry.label === label);
}

function action(view, id) {
  return view.actions.find((entry) => entry.id === id);
}

function createContext(storage) {
  const values = new Map();
  return {
    globalStorageUri: { fsPath: storage },
    globalState: {
      get: (key) => values.get(key),
      update: async (key, value) => values.set(key, value)
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined
    }
  };
}

function createApi() {
  const virtualRegistrations = [];
  const api = {
    virtualRegistrations,
    dashboardRegistrations: 0,
    gatewayActivateCalls: 0,
    gatewayDeactivateCalls: 0,
    registerVirtualAccount: async (registration) => {
      virtualRegistrations.push(registration);
      return { dispose() {} };
    },
    registerGateway: () => ({
      dispose() {},
      isActive: () => false,
      isConfigured: () => false,
      activate: async () => {
        api.gatewayActivateCalls += 1;
        return { enabled: true, configured: true, requiresReload: false };
      },
      deactivate: async () => {
        api.gatewayDeactivateCalls += 1;
        return { enabled: false, configured: false, requiresReload: false };
      },
      configureCredential: async () => ({ active: false, ready: false }),
      getStatus: async () => ({ active: false, ready: false }),
      fallbackToChatGpt: async () => ({ status: "unavailable" })
    }),
    registerDashboardIntegration: () => {
      api.dashboardRegistrations += 1;
      return { dispose() {} };
    }
  };
  return api;
}

function createVscode() {
  return {
    EventEmitter: class {
      constructor() {
        this.listeners = new Set();
        this.event = (listener) => {
          this.listeners.add(listener);
          return { dispose: () => this.listeners.delete(listener) };
        };
      }

      fire() {
        for (const listener of this.listeners) listener();
      }

      dispose() {
        this.listeners.clear();
      }
    },
    workspace: { openTextDocument: async () => undefined },
    Uri: { file: (value) => value },
    window: { showTextDocument: async () => undefined, showInformationMessage: async () => undefined },
    commands: { executeCommand: async () => undefined }
  };
}
