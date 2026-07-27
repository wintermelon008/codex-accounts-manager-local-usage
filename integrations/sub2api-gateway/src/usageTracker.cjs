"use strict";

const USAGE_STATE_KEY = "sub2apiGateway.usage.v1";
const MAX_RUNTIME_CHECKPOINTS = 8;
const BUCKET_MS = 5 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BUCKETS = Math.ceil(SEVEN_DAY_MS / BUCKET_MS) + 4;

class GatewayUsageTracker {
  constructor(globalState, now = () => Date.now()) {
    this.globalState = globalState;
    this.now = now;
    this.checkpoints = {};
    this.buckets = [];
  }

  load() {
    const stored = this.globalState.get(USAGE_STATE_KEY);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      return;
    }
    this.checkpoints = sanitizeCheckpoints(stored.checkpoints);
    this.buckets = sanitizeBuckets(stored.buckets, this.now());
  }

  async observe(status) {
    const instanceId = typeof status?.instanceId === "string" && status.instanceId ? status.instanceId : undefined;
    if (!instanceId) {
      return false;
    }
    const current = checkpointFromStatus(status);
    if (!current) {
      return false;
    }
    const previous = this.checkpoints[instanceId];
    this.checkpoints[instanceId] = current;
    this.trimCheckpoints();
    const delta = previous ? usageDelta(previous, current) : undefined;
    if (delta && delta.totalTokens > 0) {
      this.addBucket(delta, this.now());
    }
    this.buckets = sanitizeBuckets(this.buckets, this.now());
    await this.persist();
    return Boolean(delta && delta.totalTokens > 0);
  }

  snapshot(now = this.now()) {
    const buckets = sanitizeBuckets(this.buckets, now);
    const fiveHour = aggregateBuckets(buckets, now - FIVE_HOUR_MS, now);
    const sevenDay = aggregateBuckets(buckets, now - SEVEN_DAY_MS, now);
    const todayStart = startOfLocalDay(now);
    const today = aggregateBuckets(buckets, todayStart, now);
    return { fiveHour, sevenDay, today };
  }

  addBucket(delta, now) {
    const startAt = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const existing = this.buckets.find((bucket) => bucket.startAt === startAt);
    if (existing) {
      addUsage(existing, delta);
      return;
    }
    this.buckets.push({ startAt, ...zeroUsage(), ...delta });
  }

  trimCheckpoints() {
    const entries = Object.entries(this.checkpoints).sort(([, left], [, right]) => right.observedAt - left.observedAt);
    this.checkpoints = Object.fromEntries(entries.slice(0, MAX_RUNTIME_CHECKPOINTS));
  }

  persist() {
    return this.globalState.update(USAGE_STATE_KEY, { checkpoints: this.checkpoints, buckets: this.buckets });
  }
}

function checkpointFromStatus(status) {
  const requestCount = nonNegativeInteger(status.requestCount);
  const successfulRequestCount = nonNegativeInteger(status.successfulRequestCount);
  const failedRequestCount = nonNegativeInteger(status.failedRequestCount);
  const totalTokens = nonNegativeInteger(status.totalTokens);
  if ([requestCount, successfulRequestCount, failedRequestCount, totalTokens].some((value) => value === undefined)) {
    return undefined;
  }
  const inputTokens = nonNegativeInteger(status.inputTokens) ?? 0;
  const outputTokens = nonNegativeInteger(status.outputTokens) ?? 0;
  const cachedInputTokens = nonNegativeInteger(status.cachedInputTokens) ?? 0;
  const reasoningTokens = nonNegativeInteger(status.reasoningTokens) ?? 0;
  return {
    observedAt: Date.now(),
    usageDay: typeof status.usageDay === "string" ? status.usageDay : "",
    requestCount,
    successfulRequestCount,
    failedRequestCount,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens
  };
}

function usageDelta(previous, current) {
  if (previous.usageDay !== current.usageDay || current.totalTokens < previous.totalTokens) {
    return undefined;
  }
  const delta = {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - previous.reasoningTokens),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens)
  };
  return delta.totalTokens > 0 ? delta : undefined;
}

function sanitizeCheckpoints(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [id, checkpoint] of Object.entries(value)) {
    if (typeof id !== "string" || !id || !checkpoint || typeof checkpoint !== "object") {
      continue;
    }
    const normalized = checkpointFromStatus(checkpoint);
    const observedAt = nonNegativeInteger(checkpoint.observedAt);
    if (normalized && observedAt !== undefined) {
      result[id] = { ...normalized, observedAt };
    }
  }
  return result;
}

function sanitizeBuckets(value, now) {
  if (!Array.isArray(value)) {
    return [];
  }
  const minimum = now - SEVEN_DAY_MS - BUCKET_MS;
  const byStart = new Map();
  for (const candidate of value) {
    const startAt = nonNegativeInteger(candidate?.startAt);
    if (startAt === undefined || startAt < minimum || startAt > now + BUCKET_MS) {
      continue;
    }
    const normalized = { startAt, ...zeroUsage() };
    for (const key of Object.keys(zeroUsage())) {
      normalized[key] = nonNegativeInteger(candidate?.[key]) ?? 0;
    }
    const existing = byStart.get(startAt);
    if (existing) {
      addUsage(existing, normalized);
    } else {
      byStart.set(startAt, normalized);
    }
  }
  return [...byStart.values()].sort((left, right) => left.startAt - right.startAt).slice(-MAX_BUCKETS);
}

function aggregateBuckets(buckets, minimum, maximum) {
  const totals = { ...zeroUsage(), observedSince: undefined };
  for (const bucket of buckets) {
    if (bucket.startAt < minimum || bucket.startAt > maximum) {
      continue;
    }
    addUsage(totals, bucket);
    totals.observedSince = totals.observedSince === undefined ? bucket.startAt : Math.min(totals.observedSince, bucket.startAt);
  }
  return totals;
}

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function addUsage(target, source) {
  for (const key of Object.keys(zeroUsage())) {
    target[key] += nonNegativeInteger(source[key]) ?? 0;
  }
}

function startOfLocalDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

module.exports = { GatewayUsageTracker, USAGE_STATE_KEY };
