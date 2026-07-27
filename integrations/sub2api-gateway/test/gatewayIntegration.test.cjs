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

  const integration = new Sub2ApiGatewayIntegration(createVscode(), createContext(storage), createApi());
  await integration.initialize();
  const view = integration.getViewModel();

  assert.equal(detail(view, "下游").value, "https://gateway.example.invalid/v1");
  assert.equal(detail(view, "模型").value, "gpt-5");
  assert.match(detail(view, "只读库存观察").value, /^配置有误：Observer admin base URL must not include a path\./u);
  assert.equal(action(view, "configureCredential").enabled, true);
  assert.equal(action(view, "configureObserverCredential"), undefined);
  assert.equal(action(view, "refresh").enabled, true);

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
  return {
    globalStorageUri: { fsPath: storage },
    globalState: {
      get: () => undefined,
      update: async () => undefined
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined
    }
  };
}

function createApi() {
  return {
    registerGateway: () => ({
      dispose() {},
      isActive: () => false,
      isConfigured: () => false,
      activate: async () => ({ enabled: true, configured: true, requiresReload: false }),
      deactivate: async () => ({ enabled: false, configured: false, requiresReload: false }),
      configureCredential: async () => ({ active: false, ready: false }),
      getStatus: async () => ({ active: false, ready: false }),
      fallbackToChatGpt: async () => ({ status: "unavailable" })
    }),
    registerDashboardIntegration: () => ({ dispose() {} })
  };
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
