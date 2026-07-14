import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardLocalUsageViewModel } from "../src/domain/dashboard/types";
import {
  LOCAL_USAGE_CACHE_TTL_MS,
  LocalUsageAnalyticsService,
  scanLocalUsageSessions
} from "../src/services/localUsageAnalytics";
import type { LocalUsageScanner } from "../src/services/localUsageAnalytics";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const TIME_ZONE = "Asia/Shanghai";
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("scanLocalUsageSessions", () => {
  it("attributes incremental token events to the most recent session model", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    await writeSession(sessionsPath, "2026/07/14/rollout.jsonl", [
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      {
        type: "event_msg",
        timestamp: "2026-07-13T00:10:00.000Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 40,
              reasoning_output_tokens: 8,
              total_tokens: 140
            },
            total_token_usage: { total_tokens: 140 }
          }
        }
      },
      { type: "turn_context", payload: { model: "gpt-5.6-luna" } },
      {
        type: "event_msg",
        timestamp: "2026-07-14T01:10:00.000Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 5,
              output_tokens: 20,
              reasoning_output_tokens: 3,
              total_tokens: 70
            },
            total_token_usage: { total_tokens: 210 }
          }
        }
      }
    ]);

    const result = await scanLocalUsageSessions({
      sessionsPath,
      periodDays: 3,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(result.status).toBe("ready");
    expect(result.eventCount).toBe(2);
    expect(result.sourceFileCount).toBe(1);
    expect(result.total).toMatchObject({
      inputTokens: 150,
      cachedInputTokens: 15,
      outputTokens: 60,
      reasoningOutputTokens: 11,
      totalTokens: 210
    });
    expect(result.byModel).toEqual([
      expect.objectContaining({ model: "gpt-5.6-sol", totalTokens: 140 }),
      expect.objectContaining({ model: "gpt-5.6-luna", totalTokens: 70 })
    ]);
    expect(result.byDay.find((day) => day.date === "2026-07-13")?.totalTokens).toBe(140);
    expect(result.byDay.find((day) => day.date === "2026-07-14")?.totalTokens).toBe(70);
    expect(result.byDay.find((day) => day.date === "2026-07-13")?.eventCount).toBe(1);
    expect(result.byDay.find((day) => day.date === "2026-07-14")?.eventCount).toBe(1);
    expect(result.byDayAndModel).toEqual([
      expect.objectContaining({ date: "2026-07-13", model: "gpt-5.6-sol", totalTokens: 140 }),
      expect.objectContaining({ date: "2026-07-14", model: "gpt-5.6-luna", totalTokens: 70 })
    ]);
  });
});

describe("LocalUsageAnalyticsService", () => {
  it("uses the persisted aggregate for 15 minutes and only starts one refresh after expiry", async () => {
    const root = await createTempDirectory();
    const storagePath = path.join(root, "storage");
    let now = NOW;
    let refreshCount = 0;
    const scanner: LocalUsageScanner = vi.fn(async ({ periodDays, now: scannedAt }) => {
      refreshCount += 1;
      return readySnapshot(periodDays, scannedAt, refreshCount * 100);
    });
    const service = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      sessionsPath: path.join(root, "sessions"),
      timeZone: TIME_ZONE,
      now: () => now,
      scanner
    });

    const initialRefresh = waitForRefresh();
    const initial = await service.getSnapshot(initialRefresh.resolve);
    expect(initial.status).toBe("loading");
    await initialRefresh.promise;

    const firstCached = await service.getSnapshot();
    expect(firstCached.total.totalTokens).toBe(100);
    expect(scanner).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(storagePath, "local-usage-analytics-v2.json"), "utf8")).resolves.toContain(
      '"totalTokens":100'
    );

    now += LOCAL_USAGE_CACHE_TTL_MS - 1;
    await service.getSnapshot();
    await service.getSnapshot();
    expect(scanner).toHaveBeenCalledTimes(1);

    now += 2;
    const expiredRefresh = waitForRefresh();
    const stale = await service.getSnapshot(expiredRefresh.resolve);
    expect(stale.isRefreshing).toBe(true);
    await service.getSnapshot();
    await expiredRefresh.promise;
    expect(scanner).toHaveBeenCalledTimes(2);

    const restored = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      sessionsPath: path.join(root, "sessions"),
      timeZone: TIME_ZONE,
      now: () => now,
      scanner: vi.fn(async () => {
        throw new Error("a fresh cache must not scan");
      })
    });
    expect((await restored.getSnapshot()).total.totalTokens).toBe(200);
  });
});

function readySnapshot(periodDays: number, calculatedAt: number, totalTokens: number): DashboardLocalUsageViewModel {
  return {
    status: "ready",
    isRefreshing: false,
    periodDays,
    calculatedAt,
    nextRefreshAt: calculatedAt + LOCAL_USAGE_CACHE_TTL_MS,
    sourceFileCount: 1,
    eventCount: 1,
    total: {
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens
    },
    byDay: [],
    byModel: [],
    byDayAndModel: []
  };
}

function waitForRefresh(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-local-usage-"));
  tempDirectories.push(directory);
  return directory;
}

async function writeSession(sessionsPath: string, relativePath: string, records: unknown[]): Promise<void> {
  const filePath = path.join(sessionsPath, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}
