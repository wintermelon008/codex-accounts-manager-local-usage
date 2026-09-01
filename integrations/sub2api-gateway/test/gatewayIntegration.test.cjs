"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSub2ApiGatewayConfigTemplate } = require("../src/config.cjs");
const {
  Sub2ApiGatewayIntegration,
  checkGatewayHealth,
  normalizeDownstreamCredential
} = require("../src/gatewayIntegration.cjs");

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
  assert.deepEqual(
    card.details.map((entry) => entry.label),
    ["配置", "下游", "模型", "下游密钥"]
  );
  assert.deepEqual(
    card.actions.map((entry) => entry.id),
    ["configureCredential", "refresh", "openConfig"]
  );
  assert.equal(Object.hasOwn(card, "usage"), false);
  assert.deepEqual(
    card.metrics.map((entry) => entry.label),
    ["今日 Token", "7 天 Token"]
  );
  assert.equal(card.metrics.some((entry) => entry.label.includes("5 小时")), false);
  assert.equal(
    card.details.some((entry) => entry.label.includes("上游") || entry.label.includes("库存")),
    false
  );
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

test("the Manager setting defaults card visibility off and never changes the Gateway route", async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-integration-"));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const api = createApi();
  const context = createContext(storage);
  const integration = new Sub2ApiGatewayIntegration(createVscode(), context, api);
  await integration.initialize();

  const setting = api.virtualRegistrations[0].setting;
  assert.equal(setting.id, "sub2api-gateway-card-visible");
  assert.equal(setting.getEnabled(), false);
  await setting.setEnabled(true);

  assert.equal(setting.getEnabled(), true);
  assert.equal(context.globalState.get("sub2apiGateway.cardVisibility.v1"), true);
  assert.equal(api.gatewayActivateCalls, 0);
  assert.equal(api.gatewayDeactivateCalls, 0);
  integration.dispose();
});

test("offers a card action to return from an active Gateway to ChatGPT Auth", async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-integration-"));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const api = createApi();
  const integration = new Sub2ApiGatewayIntegration(createVscode(), createContext(storage), api);
  await integration.initialize();

  assert.equal(action(integration.getCardViewModel(), "deactivate"), undefined);
  integration.selection = "active";
  assert.equal(action(integration.getCardViewModel(), "deactivate").label, "使用 ChatGPT Auth");

  await integration.runAction("deactivate");

  assert.equal(api.gatewayDeactivateCalls, 1);
  assert.equal(integration.selection, "inactive");
  assert.equal(action(integration.getCardViewModel(), "deactivate"), undefined);
  integration.dispose();
});

test("returns the runtime result through the registered virtual account deactivation callback", async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-integration-"));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const api = createApi();
  const integration = new Sub2ApiGatewayIntegration(createVscode(), createContext(storage), api);
  await integration.initialize();

  integration.selection = "active";
  assert.deepEqual(await api.virtualRegistrations[0].deactivate(), {
    enabled: false,
    configured: false,
    requiresReload: false
  });

  integration.dispose();
});

test("exposes and selects external profiles from the account card without a QuickPick", async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-integration-"));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const template = createSub2ApiGatewayConfigTemplate();
  await fs.writeFile(
    path.join(storage, "sub2api-gateway.json"),
    `${JSON.stringify(
      {
        ...template,
        profiles: [
          {
            id: "external",
            displayName: "External Gateway",
            sub2api: {
              baseUrl: "https://external.example.invalid/v1",
              model: "gpt-5.5",
              credentialRef: "external"
            }
          }
        ]
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  const api = createApi();
  const vscode = createVscode();
  const integration = new Sub2ApiGatewayIntegration(vscode, createContext(storage), api);
  await integration.initialize();
  const initialCard = integration.getCardViewModel();
  assert.equal(action(initialCard, "selectProfile:default").enabled, false);
  assert.equal(action(initialCard, "selectProfile:external").label, "External Gateway");

  await integration.runAction("selectProfile:external");

  assert.equal(detail(integration.getCardViewModel(), "配置").value, "External Gateway");
  assert.equal(detail(integration.getCardViewModel(), "下游").value, "https://external.example.invalid/v1");
  assert.equal(action(integration.getCardViewModel(), "selectProfile:external").enabled, false);
  assert.equal(vscode.quickPickCalls, 0);
  assert.equal(api.virtualRegistrations.at(-1).descriptor.baseUrl, "https://external.example.invalid/v1");
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
  const vscode = {
    quickPickCalls: 0,
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
    window: {
      showTextDocument: async () => undefined,
      showInformationMessage: async () => undefined,
      showQuickPick: async () => {
        vscode.quickPickCalls += 1;
        throw new Error("Profile selection must stay inside the account card.");
      }
    },
    commands: { executeCommand: async () => undefined }
  };
  return vscode;
}
