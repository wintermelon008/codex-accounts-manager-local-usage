"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FiveSimClient,
  FiveSimPhoneOrderSession,
  flattenCatalog,
  normalizeSuccessRate
} = require("../../src/operations/fivesim-phone-order.cjs");

test("5SIM client reads balance and flattens country/operator offers", async () => {
  const requests = [];
  const client = new FiveSimClient({
    token: "five-sim-secret-token",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ url, options, path: parsed.pathname, query: parsed.search });
      if (parsed.pathname === "/v1/user/profile") {
        return response({ balance: 12.5, frozen_balance: 0.25, rating: 96 });
      }
      if (parsed.pathname === "/v1/guest/prices") {
        return response({ openai: { england: { any: { cost: 0.29, count: 12, rate: 98.5 }, vodafone: { cost: 0.42, count: 3, rate: 99.1 }, lowrate: { cost: 0.01, count: 10, rate: 0.5 }, zeropercent: { cost: 0.02, count: 10, rate: "0%" }, missingrate: { cost: 0.03, count: 10 } } } });
      }
      if (parsed.pathname === "/v1/guest/countries") {
        return response({ england: { text_en: "England", iso: { gb: 1 }, prefix: { "+44": 1 } } });
      }
      throw new Error(`unexpected request ${url}`);
    }
  });

  const profile = await client.profile();
  const catalog = await client.catalog("openai");

  assert.equal(profile.balance, 12.5);
  assert.deepEqual(catalog, [
    {
      country: "england",
      countryName: "England",
      iso: "gb",
      prefix: "+44",
      operator: "any",
      product: "openai",
      price: 0.29,
      count: 12,
      successRate: 98.5
    },
    {
      country: "england",
      countryName: "England",
      iso: "gb",
      prefix: "+44",
      operator: "vodafone",
      product: "openai",
      price: 0.42,
      count: 3,
      successRate: 99.1
    }
  ]);
  assert.equal(requests[0].options.headers.authorization, "Bearer five-sim-secret-token");
  assert.equal(requests[1].options.headers.authorization, undefined);
  assert.match(requests[1].query, /product=openai/u);
  assert.equal(normalizeSuccessRate("98.5%"), 98.5);
  assert.equal(normalizeSuccessRate(0.5), 0.5);
  assert.equal(catalog.some((offer) => offer.operator === "lowrate"), false);
  assert.equal(catalog.some((offer) => offer.operator === "zeropercent"), false);
  assert.equal(catalog.some((offer) => offer.operator === "missingrate"), false);
});

test("5SIM client handles plain-text purchase errors", async () => {
  const client = new FiveSimClient({
    token: "token",
    fetchImpl: async () => response("no free phones")
  });

  await assert.rejects(() => client.buyActivation("england", "any", "openai"), /no free phones/u);
});

test("5SIM order session polls, finishes, and exposes no token", async () => {
  const calls = [];
  let checkCount = 0;
  const fakeClient = {
    async profile() {
      calls.push("profile");
      return { balance: 3, frozen_balance: 0, rating: 96 };
    },
    async catalog() {
      calls.push("catalog");
      return [{ country: "england", countryName: "England", prefix: "+44", operator: "any", product: "openai", price: 0.29, count: 4, successRate: 98 }];
    },
    async buyActivation(country, operator, product) {
      calls.push(["buy", country, operator, product]);
      return { id: 42, country, operator, product, phone: "+447000000000", price: 0.29, status: "PENDING", sms: null };
    },
    async checkOrder() {
      calls.push("check");
      checkCount += 1;
      return checkCount === 1
        ? { id: 42, country: "england", operator: "any", product: "openai", phone: "+447000000000", status: "PENDING", sms: null }
        : { id: 42, country: "england", operator: "any", product: "openai", phone: "+447000000000", status: "RECEIVED", sms: [{ code: "123456" }] };
    },
    async finishOrder() {
      calls.push("finish");
      return { id: 42, phone: "+447000000000", status: "FINISHED", sms: [{ code: "123456" }] };
    }
  };
  const session = new FiveSimPhoneOrderSession({
    clientFactory: () => fakeClient,
    pollIntervalMs: 5,
    orderTimeoutMs: 1000
  });

  const started = await session.start("five-sim-secret-token", { country: "england", operator: "any" });
  assert.equal(started.order.phone, "+447000000000");
  assert.doesNotMatch(JSON.stringify(started), /five-sim-secret-token/u);
  await waitFor(() => session.snapshot().phase === "received");
  assert.equal(session.snapshot().order.smsCode, "123456");
  assert.equal(calls.includes("finish"), true);
  await session.dispose();
});

test("5SIM number replacement cancels the old order before buying the next one", async () => {
  const calls = [];
  let orderNumber = 0;
  const fakeClient = {
    async profile() { return { balance: 3, rating: 96 }; },
    async catalog() { return [{ country: "england", countryName: "England", operator: "any", product: "openai", price: 0.29, count: 4, successRate: 98 }]; },
    async buyActivation() {
      orderNumber += 1;
      calls.push(`buy-${orderNumber}`);
      return { id: orderNumber, country: "england", operator: "any", product: "openai", phone: `+44700000000${orderNumber}`, status: "PENDING", sms: null };
    },
    async checkOrder(orderId) {
      calls.push(`check-${orderId}`);
      return { id: orderId, status: "PENDING", sms: null };
    },
    async cancelOrder(orderId) {
      calls.push(`cancel-${orderId}`);
      return { id: orderId, status: "CANCELED", sms: null };
    }
  };
  const session = new FiveSimPhoneOrderSession({ clientFactory: () => fakeClient, pollIntervalMs: 1000 });

  await session.start("token", { country: "england", operator: "any" });
  const replaced = await session.replaceNumber();

  const cancelIndex = calls.indexOf("cancel-1");
  const secondBuyIndex = calls.indexOf("buy-2");
  assert.equal(calls.includes("buy-1"), true);
  assert.equal(cancelIndex >= 0, true);
  assert.equal(secondBuyIndex > cancelIndex, true);
  assert.equal(replaced.order.phone, "+447000000002");
  assert.equal(replaced.replacements, 1);
  await session.dispose();
});

test("flattenCatalog supports country-first price responses", () => {
  const catalog = flattenCatalog(
    { england: { openai: { any: { cost: 1, count: 2, rate: 99 } } } },
    { england: { text_en: "England" } },
    "openai"
  );
  assert.equal(catalog[0].countryName, "England");
  assert.equal(catalog[0].price, 1);
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return typeof body === "string" ? body : JSON.stringify(body); }
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
