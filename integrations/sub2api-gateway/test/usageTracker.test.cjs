"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { GatewayUsageTracker } = require("../src/usageTracker.cjs");

test("usage tracker stores only token aggregates and computes rolling windows", async () => {
  let now = Date.parse("2026-01-02T10:00:00.000Z");
  const saved = new Map();
  const state = { get: (key) => saved.get(key), update: async (key, value) => saved.set(key, value) };
  const tracker = new GatewayUsageTracker(state, () => now);
  tracker.load();
  await tracker.observe(status(3, 30));
  now += 60_000;
  await tracker.observe(status(4, 55));

  const snapshot = tracker.snapshot(now);
  assert.equal(snapshot.fiveHour.totalTokens, 25);
  assert.equal(snapshot.sevenDay.totalTokens, 25);
  assert.equal(snapshot.today.totalTokens, 25);
  const serialized = JSON.stringify(saved.get("sub2apiGateway.usage.v1"));
  assert.doesNotMatch(serialized, /credential|authorization|account@example/u);
});

test("usage tracker ignores a reset counter instead of fabricating a negative delta", async () => {
  const state = { get: () => undefined, update: async () => undefined };
  const tracker = new GatewayUsageTracker(state, () => Date.parse("2026-01-02T10:00:00.000Z"));
  await tracker.observe(status(3, 30));
  await tracker.observe(status(1, 5));
  assert.equal(tracker.snapshot().sevenDay.totalTokens, 0);
});

function status(requestCount, totalTokens) {
  return {
    instanceId: "runtime-a",
    usageDay: "2026-01-02",
    requestCount,
    successfulRequestCount: requestCount,
    failedRequestCount: 0,
    inputTokens: totalTokens,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens
  };
}
