"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_ENDPOINT,
  RegistrationExchangeRateStore,
  localDateKey
} = require("../../src/operations/registration-exchange-rate.cjs");

test("registration exchange rate is fetched once per day and the next day replaces the saved value", async () => {
  const values = new Map();
  let now = Date.parse("2026-09-06T12:00:00Z");
  let fetchCalls = 0;
  const store = new RegistrationExchangeRateStore({
    metadataStore: memoryStore(values),
    now: () => now,
    fetchImpl: async (url) => {
      fetchCalls += 1;
      assert.equal(url, DEFAULT_ENDPOINT);
      return response({ date: localDateKey(now), base: "USD", quote: "CNY", rate: fetchCalls === 1 ? 6.8 : 6.9 });
    }
  });

  const first = await store.ensureCurrent();
  assert.equal(first.rate, 6.8);
  assert.equal(first.cached, false);
  assert.equal(fetchCalls, 1);

  const sameDay = await store.ensureCurrent();
  assert.equal(sameDay.rate, 6.8);
  assert.equal(sameDay.cached, true);
  assert.equal(fetchCalls, 1);

  now = Date.parse("2026-09-07T12:00:00Z");
  const nextDay = await store.ensureCurrent();
  assert.equal(nextDay.rate, 6.9);
  assert.equal(nextDay.cached, false);
  assert.equal(fetchCalls, 2);
  assert.equal((await store.get()).date, "2026-09-07");
  assert.equal((await store.get()).rate, 6.9);
  assert.equal(values.size, 1);
});

test("exchange rate lookup does not retain yesterday's value when today's network request fails", async () => {
  let now = Date.parse("2026-09-06T12:00:00Z");
  const values = new Map();
  const store = new RegistrationExchangeRateStore({
    metadataStore: memoryStore(values),
    now: () => now,
    fetchImpl: async () => response({ rate: 6.8, date: "2026-09-06" })
  });
  await store.ensureCurrent();

  now = Date.parse("2026-09-07T12:00:00Z");
  const failedStore = new RegistrationExchangeRateStore({
    metadataStore: memoryStore(values),
    now: () => now,
    fetchImpl: async () => { throw new Error("offline"); }
  });
  const result = await failedStore.ensureCurrent();
  assert.equal(result.rate, null);
  assert.equal(result.stale, true);
  assert.match(result.error, /无法显示人民币换算/u);
  assert.equal(await failedStore.get(), undefined);
  assert.equal(values.size, 0);
});

function memoryStore(values) {
  return {
    async get(key) { return values.get(key); },
    async update(key, value) {
      if (value === undefined) values.delete(key);
      else values.set(key, structuredClone(value));
    }
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); }
  };
}
