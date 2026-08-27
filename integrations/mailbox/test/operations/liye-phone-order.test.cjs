"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LIYEClient,
  LIYEOrderError,
  LIYEPhoneOrderSession,
  extractSuccessRate,
  normalizeSuccessRate,
} = require("../../src/operations/liye-phone-order.cjs");

test("LIYE success rate is read from the platform profile only", () => {
  assert.equal(normalizeSuccessRate("85%"), 85);
  assert.equal(normalizeSuccessRate(0.85), 85);
  assert.equal(extractSuccessRate({ card: { successRate: "92.5%" } }), 92.5);
  assert.equal(extractSuccessRate({ stats: { successCount: 8, totalCount: 10 } }), 80);
  assert.equal(extractSuccessRate({ card: { status: "available" } }), null);
});

test("LIYE client sends the same-origin headers required by the platform", async () => {
  let request;
  const client = new LIYEClient({
    baseUrl: "https://liye.5x20.cn",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, async json() { return {}; } };
    }
  });

  await client.request("GET", "/api/orders");

  assert.equal(request.options.headers.origin, "https://liye.5x20.cn");
  assert.equal(request.options.headers.referer, "https://liye.5x20.cn/");
});

test("LIYE client reports the endpoint and redacts the card code in response diagnostics", async () => {
  const logs = [];
  const client = new LIYEClient({
    onLog: (level, message) => logs.push({ level, message }),
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: {},
      async json() { return { error: "请求来源无效 CARD-SECRET-1234" }; }
    })
  });

  await assert.rejects(() => client.login("CARD-SECRET-1234"), /请求来源无效/u);
  assert.match(logs[0].message, /POST https:\/\/liye\.5x20\.cn\/api\/card\/login/u);
  assert.match(logs[1].message, /HTTP 403/u);
  assert.match(logs[1].message, /请求来源无效/u);
  assert.doesNotMatch(logs[1].message, /CARD-SECRET-1234/u);
});

test("LIYE client carries the login cookie into card and order requests", async () => {
  const requests = [];
  const client = new LIYEClient({
    fetchImpl: async (url, options) => {
      requests.push({ path: new URL(url).pathname, cookie: options.headers.cookie || "" });
      const path = new URL(url).pathname;
      return {
        ok: true,
        status: 200,
        headers: {
          getSetCookie: () => path === "/api/card/login" ? ["liye_session=session-value; Path=/"] : []
        },
        async json() {
          if (path === "/api/card/me") return { authenticated: true, card: { status: "available" } };
          return {};
        }
      };
    }
  });

  await client.login("card-secret");
  await client.cardMe();
  await client.orders();

  assert.equal(requests[0].cookie, "");
  assert.equal(requests[1].cookie, "liye_session=session-value");
  assert.equal(requests[2].cookie, "liye_session=session-value");
});

test("LIYE order starts polling automatically after showing the phone", async () => {
  const client = fakeClient({
    order: { id: "order-1", status: "waiting", phone: "+8613800000000" },
    statuses: [{ id: "order-1", status: "received", phone: "+8613800000000", smsCode: "123456" }]
  });
  const session = new LIYEPhoneOrderSession({ clientFactory: () => client, pollIntervalMs: 250 });

  const initial = await session.start("card-secret");
  assert.equal(["polling", "received"].includes(initial.phase), true);
  assert.equal(initial.order.phone, "+8613800000000");
  assert.doesNotMatch(JSON.stringify(initial), /card-secret/u);

  await waitFor(() => session.snapshot().phase === "received");
  assert.equal(session.snapshot().order.smsCode, "123456");
  assert.equal(client.actionCalls.length, 1);
  assert.equal(client.actionCalls[0].action, "cancel");
  assert.equal(client.statusCalls > 0, true);
});

test("a new LIYE session does not reuse an old order that already has a code", async () => {
  const client = fakeClient({
    order: { id: "order-new", status: "waiting", phone: "+8613911111111" },
    existingOrders: [{ id: "order-old", status: "waiting", phone: "+8613800000000", smsCode: "123456" }]
  });
  const session = new LIYEPhoneOrderSession({ clientFactory: () => client, pollIntervalMs: 1000 });

  const result = await session.start("card-secret");

  assert.equal(result.order.id, "order-new");
  assert.equal(client.createCalls, 1);
  await session.dispose();
});

test("a failed LIYE order stops polling and exposes the upstream error", async () => {
  const client = fakeClient({
    order: { id: "order-failed", status: "waiting", phone: "+8613800000000" },
    statuses: [{ id: "order-failed", status: "failed", phone: "+8613800000000", error: "订单上游缺失" }]
  });
  const session = new LIYEPhoneOrderSession({ clientFactory: () => client, pollIntervalMs: 250 });

  await session.start("card-secret");
  await waitFor(() => session.snapshot().phase === "error");

  const result = session.snapshot();
  assert.equal(result.running, false);
  assert.match(result.error, /订单上游缺失/u);
  assert.equal(client.statusCalls, 1);
  await session.dispose();
});

test("a used LIYE card does not revive a historical failed order", async () => {
  const client = fakeClient({
    cardStatus: "processing",
    order: { id: "order-new", status: "waiting", phone: "+8613911111111" },
    existingOrders: [{ id: "order-failed", status: "failed", error: "订单上游缺失" }]
  });
  const session = new LIYEPhoneOrderSession({ clientFactory: () => client, pollIntervalMs: 250 });

  const result = await session.start("card-secret");

  assert.equal(result.phase, "error");
  assert.match(result.error, /没有可恢复的订单/u);
  assert.equal(result.order, null);
  assert.equal(client.createCalls, 0);
  await session.dispose();
});

test("number replacement is performed only by the explicit replace action and resumes polling", async () => {
  const client = fakeClient({
    order: { id: "order-2", status: "waiting", phone: "+8613900000000" },
    replacement: { id: "order-2", status: "waiting", phone: "+8613911111111" }
  });
  const session = new LIYEPhoneOrderSession({ clientFactory: () => client });

  await session.start("card-secret");
  assert.equal(client.actionCalls.length, 0);
  const result = await session.replaceNumber();

  assert.equal(client.actionCalls.length, 1);
  assert.equal(client.actionCalls[0].action, "replace");
  assert.equal(result.order.phone, "+8613911111111");
  assert.equal(result.phase, "polling");
  assert.equal(result.humanConfirmed, true);
  await session.dispose();
});

test("a replace race after SMS arrival recovers the current code instead of stopping polling", async () => {
  const client = fakeClient({
    order: { id: "order-race", status: "waiting", phone: "+8613900000000" },
    statuses: [
      { id: "order-race", status: "waiting", phone: "+8613900000000" },
      { id: "order-race", status: "received", phone: "+8613900000000", smsCode: "654321" }
    ],
    replacementError: new LIYEOrderError("验证码已到达，当前号码不可再操作", { status: 409 })
  });
  const session = new LIYEPhoneOrderSession({ clientFactory: () => client, pollIntervalMs: 1000 });

  await session.start("card-secret");
  const result = await session.replaceNumber();

  assert.equal(client.actionCalls.length, 2);
  assert.equal(client.actionCalls.map((item) => item.action).join(","), "replace,cancel");
  assert.equal(client.statusCalls >= 2, true);
  assert.equal(result.phase, "received");
  assert.equal(result.running, false);
  assert.equal(result.order.smsCode, "654321");
  await session.dispose();
});

test("cancel action stops the order without an automatic timeout cancellation", async () => {
  const client = fakeClient({
    order: { id: "order-3", status: "waiting", phone: "+8613700000000" }
  });
  const session = new LIYEPhoneOrderSession({ clientFactory: () => client, orderTimeoutMs: 10000 });

  await session.start("card-secret");
  await session.cancelNumber();

  assert.equal(client.actionCalls.length, 1);
  assert.equal(client.actionCalls[0].action, "cancel");
  assert.equal(session.snapshot().phase, "cancelled");
  assert.equal(session.snapshot().running, false);
});

function fakeClient({ order, statuses = [], replacement, replacementError, existingOrders = [], cardStatus = "available" } = {}) {
  let statusIndex = 0;
  return {
    statusCalls: 0,
    actionCalls: [],
    createCalls: 0,
    async login(code) {
      assert.equal(code, "card-secret");
    },
    async cardMe() {
      return { authenticated: true, card: { status: cardStatus } };
    },
    async orders() {
      return existingOrders.map((item) => ({ ...item }));
    },
    async createOrder() {
      this.createCalls += 1;
      return { ...order };
    },
    async orderStatus() {
      this.statusCalls += 1;
      return { ...(statuses[Math.min(statusIndex++, statuses.length - 1)] || order) };
    },
    async orderAction(current, action) {
      this.actionCalls.push({ current, action });
      if (action === "replace") {
        if (replacementError) throw replacementError;
        return { ...replacement };
      }
      return { ...current, status: "cancelled" };
    },
    async logout() {},
    async close() {}
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
