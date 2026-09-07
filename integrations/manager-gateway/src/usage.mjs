import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const USAGE_SCHEMA_VERSION = 1;
const USAGE_FILE_NAME = "usage-ledger-v1.json";
const MAX_DAYS = 31;
const UNKNOWN_MODEL = "unknown";

/**
 * Best-effort token accounting owned by the Gateway process. It is
 * intentionally independent from the Manager control API so a Gateway can
 * still account for sessions on devices where the Manager integration is not
 * installed or is not reachable.
 */
export class GatewayUsageLedger {
  #days = new Map();
  #writeChain = Promise.resolve();

  constructor({ stateDir, now = () => Date.now(), timeZone } = {}) {
    this.stateDir = typeof stateDir === "string" && stateDir.trim() ? stateDir.trim() : undefined;
    this.now = now;
    this.timeZone = typeof timeZone === "string" && timeZone.trim()
      ? timeZone.trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    this.filePath = this.stateDir ? path.join(this.stateDir, USAGE_FILE_NAME) : undefined;
  }

  async init() {
    if (!this.filePath) {
      return;
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.#days = sanitizeDays(JSON.parse(raw));
      this.#prune();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[manager-gateway] usage ledger ignored:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  async record(value) {
    const usage = normalizeTokenUsage(value);
    if (!usage || usage.totalTokens <= 0) {
      return false;
    }

    const date = localDateKey(this.now(), this.timeZone);
    const day = this.#days.get(date) ?? createDay(date);
    addUsage(day.total, usage);
    const model = day.byModel[usage.model] ?? { model: usage.model, ...zeroUsage() };
    addUsage(model, usage);
    day.byModel[usage.model] = model;
    day.eventCount += 1;
    day.calculatedAt = this.now();
    this.#days.set(date, day);
    this.#prune();

    try {
      await this.#persist();
    } catch (error) {
      // Accounting must never turn a successful provider session into a
      // failed user request. The in-memory value remains available until the
      // process exits and the next write can retry.
      console.warn("[manager-gateway] usage ledger write failed:", error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  snapshot(now = this.now()) {
    const date = localDateKey(now, this.timeZone);
    const day = this.#days.get(date);
    if (!day) {
      return {
        status: "unavailable",
        date,
        timeZone: this.timeZone,
        calculatedAt: undefined,
        eventCount: 0,
        total: zeroUsage(),
        byModel: []
      };
    }
    return {
      status: day.eventCount > 0 ? "ready" : "unavailable",
      date,
      timeZone: this.timeZone,
      calculatedAt: day.calculatedAt,
      eventCount: day.eventCount,
      total: { ...day.total },
      byModel: Object.values(day.byModel)
        .map((usage) => ({ ...usage }))
        .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model))
    };
  }

  #prune() {
    const dates = [...this.#days.keys()].sort().slice(-MAX_DAYS);
    this.#days = new Map(dates.map((date) => [date, this.#days.get(date)]));
  }

  #persist() {
    if (!this.filePath) {
      return Promise.resolve();
    }
    const value = JSON.stringify({
      schemaVersion: USAGE_SCHEMA_VERSION,
      days: [...this.#days.values()]
    }) + "\n";
    this.#writeChain = this.#writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      });
    return this.#writeChain;
  }
}

/** Normalize OpenAI/Codex usage envelopes into one token-only shape. */
export function normalizeTokenUsage(value, modelHint) {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = readTokenCount(value.input_tokens ?? value.inputTokens ?? value.prompt_tokens);
  const outputTokens = readTokenCount(value.output_tokens ?? value.outputTokens ?? value.completion_tokens);
  const total = readTokenCount(value.total_tokens ?? value.totalTokens);
  const inputDetails = firstRecord(value.input_tokens_details, value.inputTokensDetails, value.prompt_tokens_details);
  const outputDetails = firstRecord(value.output_tokens_details, value.outputTokensDetails, value.completion_tokens_details);
  const cachedInputTokens = Math.min(
    inputTokens ?? 0,
    readTokenCount(
      inputDetails?.cached_tokens ??
        inputDetails?.cachedTokens ??
        value.cached_input_tokens ??
        value.cachedInputTokens ??
        value.cached_tokens
    ) ?? 0
  );
  const reasoningOutputTokens =
    readTokenCount(
      outputDetails?.reasoning_tokens ??
        outputDetails?.reasoningTokens ??
        value.reasoning_output_tokens ??
        value.reasoningOutputTokens ??
        value.reasoning_tokens ??
        value.reasoningTokens
    ) ?? 0;
  if (inputTokens === undefined && outputTokens === undefined && total === undefined) {
    return undefined;
  }

  const normalizedInputTokens = inputTokens ?? 0;
  const normalizedOutputTokens = outputTokens ?? 0;
  return {
    model: normalizeModel(value.model ?? value.model_id ?? modelHint),
    inputTokens: normalizedInputTokens,
    cachedInputTokens,
    outputTokens: normalizedOutputTokens,
    reasoningOutputTokens,
    totalTokens: total ?? normalizedInputTokens + normalizedOutputTokens
  };
}

function createDay(date) {
  return { date, calculatedAt: undefined, eventCount: 0, total: zeroUsage(), byModel: {} };
}

function sanitizeDays(value) {
  if (!isRecord(value) || value.schemaVersion !== USAGE_SCHEMA_VERSION || !Array.isArray(value.days)) {
    return new Map();
  }
  const days = new Map();
  for (const candidate of value.days) {
    if (!isRecord(candidate) || !/^\d{4}-\d{2}-\d{2}$/u.test(candidate.date)) {
      continue;
    }
    const day = createDay(candidate.date);
    day.calculatedAt = readTokenCount(candidate.calculatedAt);
    day.eventCount = readTokenCount(candidate.eventCount) ?? 0;
    day.total = sanitizeUsageTotals(candidate.total);
    if (isRecord(candidate.byModel)) {
      for (const [key, modelValue] of Object.entries(candidate.byModel)) {
        const usage = normalizeTokenUsage(modelValue, key);
        if (usage && usage.totalTokens >= 0) {
          day.byModel[usage.model] = usage;
        }
      }
    }
    days.set(day.date, day);
  }
  return new Map([...days.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(-MAX_DAYS));
}

function sanitizeUsageTotals(value) {
  const totals = zeroUsage();
  if (!isRecord(value)) {
    return totals;
  }
  for (const key of Object.keys(totals)) {
    totals[key] = readTokenCount(value[key]) ?? 0;
  }
  totals.cachedInputTokens = Math.min(totals.inputTokens, totals.cachedInputTokens);
  return totals;
}

function addUsage(target, source) {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
}

function zeroUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function firstRecord(...values) {
  return values.find(isRecord);
}

function readTokenCount(value) {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function normalizeModel(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : UNKNOWN_MODEL;
}

function localDateKey(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
