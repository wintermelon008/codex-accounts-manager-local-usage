"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TingbaiApiError, TingbaiClient } = require("../src/api/tingbaiClient.cjs");
const { BugTeamStorage } = require("../src/storage.cjs");
const {
  DEFAULT_TINGBAI_POLL_INTERVAL_MS,
  TINGBAI_POLL_JITTER_MS,
  TingbaiSource,
  calculateEstimatedExplosionAt,
  calculatePollDelayMs,
  normalizeCatalog,
  normalizeQuote
} = require("../src/tingbaiSource.cjs");

test("Tingbai waitlist polls every 3 seconds with less than 1 second of jitter", () => {
  assert.equal(DEFAULT_TINGBAI_POLL_INTERVAL_MS, 3_000);
  assert.equal(TINGBAI_POLL_JITTER_MS, 1_000);
  assert.equal(calculatePollDelayMs(DEFAULT_TINGBAI_POLL_INTERVAL_MS, 0), 3_000);
  assert.equal(calculatePollDelayMs(DEFAULT_TINGBAI_POLL_INTERVAL_MS, 0.9999), 3_999);
});

test("Tingbai client keeps the HttpOnly session cookie and sends CSRF plus idempotency headers", async () => {
  const requests = [];
  const client = new TingbaiClient({
    baseUrl: "https://tingbai.example.test",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/buyer/login")) {
        return jsonResponse(
          { csrf_token: "csrf-token", buyer: { username: "buyer-one", balance_fen: 900 } },
          200,
          { "set-cookie": "buyer_session=session-value; Path=/; HttpOnly; Secure; SameSite=Strict" }
        );
      }
      return jsonResponse({ order: { order_id: "order-one", status: "processing" } }, 201);
    }
  });

  await client.login("buyer-one", "password-one");
  await client.createOrder({
    product: "team-7d",
    quantity: 1,
    expectedUnitPriceFen: 300,
    expectedTotalFen: 300,
    quoteId: "quote-one",
    idempotencyKey: "request-one"
  });

  const headers = requests[1].options.headers;
  assert.equal(headers.get("Cookie"), "buyer_session=session-value");
  assert.equal(headers.get("X-CSRF-Token"), "csrf-token");
  assert.equal(headers.get("Idempotency-Key"), "request-one");
  assert.equal(JSON.parse(requests[1].options.body).expected_total_fen, 300);
});

test("Tingbai catalog retries one transient network failure and reports a readable error", async () => {
  let calls = 0;
  const client = new TingbaiClient({
    baseUrl: "https://tingbai.example.test",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse({ products: [{ code: "team-7d", available: 0 }] });
    }
  });

  const payload = await client.getCatalog();
  assert.equal(calls, 2);
  assert.equal(payload.products[0].code, "team-7d");

  const failingClient = new TingbaiClient({
    baseUrl: "https://tingbai.example.test",
    fetchImpl: async () => { throw new TypeError("fetch failed"); }
  });
  await assert.rejects(
    failingClient.getCatalog(),
    (error) => error instanceof TingbaiApiError
      && error.code === "network_error"
      && error.message.includes("网络请求失败")
      && !error.message.includes("fetch failed")
  );
});

test("Tingbai catalog calculates the displayed estimated explosion time", () => {
  const products = normalizeCatalog(catalogPayload({ available: 2 }));
  assert.equal(products[0].estimatedExplosionAt, "2026-08-18T02:00:00.000Z");
  assert.equal(calculateEstimatedExplosionAt("2026-08-18T01:00:00.000Z", 3600), "2026-08-18T02:00:00.000Z");
});

test("Tingbai honors explicit purchasable and quote can-buy signals", () => {
  const products = normalizeCatalog({ products: [{
    code: "team-low",
    name: "低价 Team",
    unit_price_fen: 199,
    available: 0,
    purchasable: true
  }] });
  assert.equal(products[0].purchasable, true);
  const quote = normalizeQuote({ quote: {
    estimated_unit_price_fen: 199,
    estimated_total_fen: 199,
    can_buy: true
  } }, products[0], 1);
  assert.equal(quote.canBuy, true);
  assert.equal(quote.totalFen, 199);
});

test("Tingbai submits a low-price product when the API marks it purchasable", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  const requests = [];
  const client = createFakeClient(requests, [{ products: [{
    code: "team-low",
    name: "低价 Team",
    unit_price_fen: 199,
    available: 0,
    purchasable: true
  }] }], 199, { omitQuoteAvailable: true });
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => ({ status: "completed", total: 1, imported: 1, poolEnabled: 1 })
  });

  await source.initialize();
  await source.setCredentials("buyer-one", "password-one");
  await source.startWaitlist({ maxTotalFen: 199 });

  assert.equal(requests.find((request) => request.type === "create").product, "team-low");
  source.dispose();
});

test("Tingbai waitlist includes both amount boundaries when buying and imports the result", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  const requests = [];
  const client = createFakeClient(requests, [catalogPayload({ available: 0 }), catalogPayload({ available: 1 })]);
  const imports = [];
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async (bundle) => {
      imports.push(bundle);
      return { status: "completed", total: 1, imported: 1, poolEnabled: 1, refreshFailed: 0, notEligible: 0, authFailed: 0, importFailed: 0 };
    }
  });

  await source.initialize();
  await source.setCredentials("buyer-one", "password-one");
  await source.startWaitlist({ minTotalFen: 300, maxTotalFen: 300 });
  await waitFor(() => source.getViewModel().order?.imported === true);

  const state = source.getViewModel();
  assert.equal(requests.filter((request) => request.type === "create").length, 1);
  assert.match(requests.find((request) => request.type === "create").idempotencyKey, /^manager-[0-9a-f-]{36}$/u);
  assert.equal(imports.length, 1);
  assert.equal(state.order.imported, true);
  assert.equal(state.records[0].estimatedExplosionAt, "2026-08-18T02:00:00.000Z");
  assert.equal(state.records[0].amountFen, 300);
  assert.equal(context.secrets.getValue("codexAccounts.bugteam.tingbai.password.v1"), "password-one");
  source.dispose();
});

test("Tingbai waitlist skips a quote above its upper amount boundary and keeps polling", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  const requests = [];
  const client = createFakeClient(requests, [catalogPayload({ available: 0 }), catalogPayload({ available: 1 })], 400);
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => { throw new Error("must not import"); }
  });

  await source.initialize();
  await source.setCredentials("buyer-one", "password-one");
  await source.startWaitlist({ maxTotalFen: 300 });

  assert.equal(requests.some((request) => request.type === "create"), false);
  assert.equal(source.getViewModel().waitlist.active, true);
  assert.equal(source.getViewModel().lastError, undefined);
  source.dispose();
});

test("Tingbai waitlist skips a quote below its lower amount boundary and keeps polling", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  const requests = [];
  const client = createFakeClient(requests, [catalogPayload({ available: 0 }), catalogPayload({ available: 1 })], 299);
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => { throw new Error("must not import"); }
  });

  await source.initialize();
  await source.setCredentials("buyer-one", "password-one");
  await source.startWaitlist({ minTotalFen: 300 });

  assert.equal(requests.some((request) => request.type === "create"), false);
  assert.equal(source.getViewModel().waitlist.active, true);
  source.dispose();
});

test("Tingbai waitlist does not restrict the quote amount when both boundaries are omitted", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  const requests = [];
  const client = createFakeClient(requests, [catalogPayload({ available: 0 }), catalogPayload({ available: 1 })], 400);
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => ({ status: "completed", total: 1, imported: 1, poolEnabled: 1, refreshFailed: 0, notEligible: 0, authFailed: 0, importFailed: 0 })
  });

  await source.initialize();
  await source.setCredentials("buyer-one", "password-one");
  await source.startWaitlist();
  await waitFor(() => source.getViewModel().order?.imported === true);

  const create = requests.find((request) => request.type === "create");
  assert.equal(create.expectedTotalFen, 400);
  assert.equal(source.getViewModel().order.imported, true);
  source.dispose();
});

test("Tingbai waitlist follows the stocked product when the catalog product changes", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  const requests = [];
  const catalogs = [
    catalogPayload({ available: 0 }),
    catalogPayload({ available: 0 }),
    {
      products: [
        catalogPayload({ available: 0 }).products[0],
        catalogPayload({ available: 1, code: "team-live" }).products[0]
      ]
    }
  ];
  const client = createFakeClient(requests, catalogs);
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => ({ status: "completed", total: 1, imported: 1, poolEnabled: 1 })
  });

  await source.initialize();
  await source.setCredentials("buyer-one", "password-one");
  await source.startWaitlist();

  assert.equal(requests.some((request) => request.type === "create"), false);
  assert.ok(source.getViewModel().nextPollAt > Date.now());
  await source.runCycle();
  await waitFor(() => source.getViewModel().order?.imported === true);

  const create = requests.find((request) => request.type === "create");
  assert.equal(create.product, "team-live");
  assert.equal(source.getViewModel().order.imported, true);
  source.dispose();
});

test("Tingbai waitlist starts and persists when the catalog is temporarily empty", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  const requests = [];
  const client = createFakeClient(requests, [{ products: [] }]);
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => { throw new Error("must not import"); }
  });

  await source.initialize();
  await source.setCredentials("buyer-one", "password-one");
  await source.startWaitlist();

  const view = source.getViewModel();
  assert.equal(view.waitlist.active, true);
  assert.equal(view.product, undefined);
  assert.ok(view.nextPollAt > Date.now());
  source.dispose();
});

test("Tingbai does not treat a failed historical order as an active waitlist", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  await storage.setTingbaiCredentials("buyer-one", "password-one");
  await context.globalState.update("codexAccounts.bugteam.tingbai.state.v1", {
    waitlist: { active: false, productCode: "team-old", startedAt: "2026-08-17T01:00:00.000Z" },
    order: { orderId: "old-order", state: "failed", imported: false },
    records: [{ orderId: "old-order", state: "failed", imported: false }]
  });
  const client = createFakeClient([], [catalogPayload({ available: 0 })]);
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => ({ status: "completed", total: 1, imported: 1, poolEnabled: 1 })
  });

  await source.initialize();
  const view = source.getViewModel();
  assert.equal(view.waitlist.active, false);
  assert.equal(view.attemptPending, false);
  assert.equal(view.nextPollAt, undefined);
  assert.equal(source.shouldContinuePolling(), false);
  source.dispose();
});

test("Tingbai keeps the waitlist running while a completed order import is stuck", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  await storage.setTingbaiCredentials("buyer-one", "password-one");
  await context.globalState.update("codexAccounts.bugteam.tingbai.state.v1", {
    waitlist: { active: false },
    order: { orderId: "old-order", state: "completed", imported: false },
    records: [{ orderId: "old-order", state: "completed", imported: false }]
  });
  const requests = [];
  let importStarted;
  const importStartedPromise = new Promise((resolve) => { importStarted = resolve; });
  const client = createFakeClient(requests, [catalogPayload({ available: 1 })]);
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => {
      importStarted();
      return new Promise(() => {});
    }
  });

  await source.initialize();
  await Promise.race([
    importStartedPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("stuck import did not start")), 1_000))
  ]);
  await source.startWaitlist();

  assert.equal(requests.filter((request) => request.type === "create").length, 1);
  assert.equal(source.getViewModel().order.orderId, "order-one");
  source.dispose();
});

test("Tingbai stops automatic retries once account import succeeds with a pool warning", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  await storage.setTingbaiCredentials("buyer-one", "password-one");
  let importAttempts = 0;
  const client = createFakeClient([], [catalogPayload({ available: 0 })]);
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => {
      importAttempts += 1;
      return { status: "partial", total: 1, imported: 1, poolEnabled: 0, refreshFailed: 1, notEligible: 0, authFailed: 1, importFailed: 0 };
    }
  });

  await source.initialize();
  source.data.order = { orderId: "order-pool-warning", state: "completed", imported: false };
  await source.processCompletedOrder(true);

  assert.equal(importAttempts, 1);
  assert.equal(source.getViewModel().order.imported, true);
  assert.match(source.getViewModel().order.lastImportError, /仅 0\/1 个启用无感池/u);
  assert.equal(source.shouldContinuePolling(), false);
  assert.equal(source.pollTimer, undefined);

  await source.processCompletedOrder(false);
  assert.equal(importAttempts, 1);
  source.dispose();
});

test("Tingbai waitlist rejects an inverted amount range", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  const requests = [];
  const client = createFakeClient(requests, [catalogPayload({ available: 0 })]);
  const source = new TingbaiSource({
    storage,
    clientFactory: () => client,
    pollIntervalMs: 60_000,
    importBundle: async () => { throw new Error("must not import"); }
  });

  await source.initialize();
  await source.setCredentials("buyer-one", "password-one");
  await assert.rejects(source.startWaitlist({ minTotalFen: 400, maxTotalFen: 300 }), /下限不能大于上限/u);
  source.dispose();
});

test("Tingbai resumes an uncertain purchase with the persisted idempotency key", async () => {
  const context = createContext();
  const storage = new BugTeamStorage(context);
  const requests = [];
  const client = createFakeClient(requests, [catalogPayload({ available: 0 }), catalogPayload({ available: 1 })]);
  const createOrder = client.createOrder.bind(client);
  let createAttempts = 0;
  client.createOrder = async (input) => {
    createAttempts += 1;
    if (createAttempts === 1) {
      requests.push({ type: "create", ...input });
      throw new Error("network timeout");
    }
    return createOrder(input);
  };
  const importBundle = async () => ({ status: "completed", total: 1, imported: 1, poolEnabled: 1, refreshFailed: 0, notEligible: 0, authFailed: 0, importFailed: 0 });
  const first = new TingbaiSource({ storage, clientFactory: () => client, pollIntervalMs: 60_000, importBundle });
  await first.initialize();
  await first.setCredentials("buyer-one", "password-one");
  await assert.rejects(first.startWaitlist(), /network timeout/u);
  first.dispose();

  const second = new TingbaiSource({ storage, clientFactory: () => client, pollIntervalMs: 60_000, importBundle });
  await second.initialize();
  await waitFor(() => second.getViewModel().order?.imported === true);

  const creates = requests.filter((request) => request.type === "create");
  assert.equal(creates.length, 2);
  assert.equal(creates[1].idempotencyKey, creates[0].idempotencyKey);
  second.dispose();
});

function createFakeClient(requests, catalogs, quoteTotalFen = 300, options = {}) {
  return {
    authenticated: false,
    async login(username) {
      this.authenticated = true;
      requests.push({ type: "login", username });
      return { csrf_token: "csrf", buyer: { username, balance_fen: 900, currency: "CNY" } };
    },
    clearSession() { this.authenticated = false; },
    async getCatalog() {
      requests.push({ type: "catalog" });
      return catalogs.length > 1 ? catalogs.shift() : catalogs[0];
    },
    async getWallet() {
      requests.push({ type: "wallet" });
      return { buyer: { username: "buyer-one", balance_fen: 900, currency: "CNY" } };
    },
    async getQuote() {
      requests.push({ type: "quote" });
      const quote = { estimated_unit_price_fen: quoteTotalFen, estimated_total_fen: quoteTotalFen, can_buy: true, quote_id: "quote-one" };
      if (!options.omitQuoteAvailable) quote.available = 1;
      return { quote };
    },
    async createOrder(input) {
      requests.push({ type: "create", ...input });
      return { order: { order_id: "order-one", status: "completed", total_fen: input.expectedTotalFen, created_at: "2026-08-18T01:01:00.000Z", completed_at: "2026-08-18T01:01:05.000Z" } };
    },
    async getOrder() {
      requests.push({ type: "order" });
      return { order: { order_id: "order-one", status: "completed", total_fen: 300 } };
    },
    async downloadSub2() {
      requests.push({ type: "download" });
      return { accounts: [{ tokens: { id_token: "id", access_token: "access" } }] };
    }
  };
}

function catalogPayload({ available, code = "team-7d" }) {
  return {
    products: [{
      code,
      name: "普通 Team · 7D",
      unit_price_fen: 300,
      available,
      purchasable: available > 0,
      currency: "CNY",
      supply: {
        refreshed_at: "2026-08-18T01:00:00.000Z",
        minimum_remaining_seconds: 3600,
        maximum_remaining_seconds: 7200,
        departure_time: "2026-08-18T01:00:00.000Z"
      }
    }]
  };
}

function createContext() {
  const state = new Map();
  const secrets = new Map();
  return {
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

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
