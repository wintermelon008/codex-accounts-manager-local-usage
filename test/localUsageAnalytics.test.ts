import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardLocalUsageViewModel } from "../src/domain/dashboard/types";
import {
  ACCOUNT_TOKEN_USAGE_CACHE_FILE_NAME,
  LOCAL_USAGE_CACHE_TTL_MS,
  LOCAL_USAGE_SCAN_LEASE_FILE_NAME,
  LocalUsageAnalyticsService,
  findAccountTokenUsageWindow,
  isSnapshotFresh,
  scanLocalUsageAndAccountTokenUsage,
  scanLocalUsageSessions
} from "../src/services/localUsageAnalytics";
import type { LocalUsageScanner } from "../src/services/localUsageAnalytics";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");
const TIME_ZONE = "Asia/Shanghai";
const tempDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

  it("assigns recent usage to local three-hour boundaries and preserves model buckets", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    await writeSession(sessionsPath, "2026/07/14/three-hour.jsonl", [
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      tokenCountEvent("2026-07-14T09:59:00.000Z", 10),
      { type: "turn_context", payload: { model: "gpt-5.6-luna" } },
      tokenCountEvent("2026-07-14T10:00:00.000Z", 20),
      tokenCountEvent("2026-07-14T12:00:00.000Z", 30)
    ]);

    const result = await scanLocalUsageSessions({
      sessionsPath,
      periodDays: 4,
      shortPeriodDays: 4,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(result.by3Hour).toHaveLength(31);
    expect(result.by3Hour.find((row) => row.startAt === Date.parse("2026-07-14T07:00:00.000Z"))).toMatchObject({
      eventCount: 1,
      totalTokens: 10
    });
    expect(result.by3Hour.find((row) => row.startAt === Date.parse("2026-07-14T10:00:00.000Z"))).toMatchObject({
      eventCount: 2,
      totalTokens: 50
    });
    expect(result.by3HourAndModel).toEqual([
      expect.objectContaining({ startAt: Date.parse("2026-07-14T07:00:00.000Z"), model: "gpt-5.6-sol", totalTokens: 10 }),
      expect.objectContaining({ startAt: Date.parse("2026-07-14T10:00:00.000Z"), model: "gpt-5.6-luna", totalTokens: 50 })
    ]);
  });

  it("keeps the short-range start at local midnight across a DST transition", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    const now = Date.parse("2026-03-09T16:00:00.000Z");
    await writeSession(sessionsPath, "2026/03/09/dst.jsonl", [
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      tokenCountEvent("2026-03-06T04:30:00.000Z", 10),
      tokenCountEvent("2026-03-06T05:00:00.000Z", 20),
      tokenCountEvent("2026-03-09T15:00:00.000Z", 30)
    ]);

    const result = await scanLocalUsageSessions({
      sessionsPath,
      periodDays: 1,
      shortPeriodDays: 4,
      timeZone: "America/New_York",
      now
    });

    expect(result.eventCount).toBe(1);
    expect(result.total.totalTokens).toBe(30);
    expect(result.by3Hour.find((row) => row.startAt === Date.parse("2026-03-06T05:00:00.000Z"))).toMatchObject({
      eventCount: 1,
      totalTokens: 20
    });
  });

  it("uses cumulative high-water deltas instead of repeated last-token reports", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    await writeSession(sessionsPath, "2026/07/14/root.jsonl", [
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      cumulativeTokenCountEvent("2026-07-13T01:00:00.000Z", {
        inputTokens: 80,
        cachedInputTokens: 60,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 100
      }),
      cumulativeTokenCountEvent("2026-07-14T01:00:00.000Z", {
        inputTokens: 80,
        cachedInputTokens: 60,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 100
      }),
      cumulativeTokenCountEvent("2026-07-14T01:01:00.000Z", {
        inputTokens: 72,
        cachedInputTokens: 54,
        outputTokens: 18,
        reasoningOutputTokens: 4,
        totalTokens: 90
      }),
      cumulativeTokenCountEvent(
        "2026-07-14T01:02:00.000Z",
        {
          inputTokens: 120,
          cachedInputTokens: 90,
          outputTokens: 30,
          reasoningOutputTokens: 7,
          totalTokens: 150
        },
        {
          inputTokens: 40,
          cachedInputTokens: 30,
          outputTokens: 10,
          reasoningOutputTokens: 2,
          totalTokens: 50
        }
      ),
      cumulativeTokenCountEvent(
        "2026-07-14T01:03:00.000Z",
        {
          inputTokens: 120,
          cachedInputTokens: 90,
          outputTokens: 30,
          reasoningOutputTokens: 7,
          totalTokens: 150
        },
        {
          inputTokens: 40,
          cachedInputTokens: 30,
          outputTokens: 10,
          reasoningOutputTokens: 2,
          totalTokens: 50
        }
      ),
      cumulativeTokenCountEvent(
        "2026-07-14T12:00:01.000Z",
        {
          inputTokens: 160,
          cachedInputTokens: 120,
          outputTokens: 40,
          reasoningOutputTokens: 9,
          totalTokens: 200
        },
        {
          inputTokens: 40,
          cachedInputTokens: 30,
          outputTokens: 10,
          reasoningOutputTokens: 2,
          totalTokens: 50
        }
      )
    ]);

    const result = await scanLocalUsageSessions({
      sessionsPath,
      periodDays: 1,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(result.eventCount).toBe(1);
    expect(result.total).toEqual({
      inputTokens: 40,
      cachedInputTokens: 30,
      outputTokens: 10,
      reasoningOutputTokens: 2,
      totalTokens: 50
    });
  });

  it("expires the current-day aggregate at the next local midnight", async () => {
    const root = await createTempDirectory();
    const beforeMidnight = Date.parse("2026-07-14T15:59:00.000Z");
    const result = await scanLocalUsageSessions({
      sessionsPath: path.join(root, "sessions"),
      periodDays: 1,
      timeZone: TIME_ZONE,
      now: beforeMidnight
    });

    const midnight = Date.parse("2026-07-14T16:00:00.000Z");
    expect(result.nextRefreshAt).toBe(midnight);
    expect(isSnapshotFresh(result, midnight - 1)).toBe(true);
    expect(isSnapshotFresh(result, midnight)).toBe(false);
  });

  it("does not count inherited history copied into a spawned subagent rollout", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    await writeSession(sessionsPath, "2026/07/14/subagent.jsonl", [
      {
        type: "session_meta",
        timestamp: "2026-07-14T01:00:00.000Z",
        payload: {
          id: "child-thread",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1
              }
            }
          }
        }
      },
      {
        type: "session_meta",
        timestamp: "2026-07-14T01:00:00.001Z",
        payload: { id: "parent-thread", source: "vscode" }
      },
      { type: "turn_context", payload: { model: "parent-model" } },
      { type: "inter_agent_communication_metadata", payload: { trigger_turn: false } },
      cumulativeTokenCountEvent("2026-07-14T01:00:00.010Z", {
        inputTokens: 80,
        cachedInputTokens: 60,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 100
      }),
      cumulativeTokenCountEvent("2026-07-14T01:00:00.020Z", {
        inputTokens: 120,
        cachedInputTokens: 90,
        outputTokens: 30,
        reasoningOutputTokens: 7,
        totalTokens: 150
      }),
      { type: "turn_context", payload: { model: "child-model" } },
      { type: "inter_agent_communication_metadata", payload: { trigger_turn: true } },
      cumulativeTokenCountEvent(
        "2026-07-14T01:01:00.000Z",
        {
          inputTokens: 145,
          cachedInputTokens: 110,
          outputTokens: 35,
          reasoningOutputTokens: 9,
          totalTokens: 180
        },
        {
          inputTokens: 25,
          cachedInputTokens: 20,
          outputTokens: 5,
          reasoningOutputTokens: 2,
          totalTokens: 30
        }
      ),
      cumulativeTokenCountEvent(
        "2026-07-14T01:02:00.000Z",
        {
          inputTokens: 175,
          cachedInputTokens: 135,
          outputTokens: 45,
          reasoningOutputTokens: 11,
          totalTokens: 220
        },
        {
          inputTokens: 30,
          cachedInputTokens: 25,
          outputTokens: 10,
          reasoningOutputTokens: 2,
          totalTokens: 40
        }
      )
    ]);

    const result = await scanLocalUsageSessions({
      sessionsPath,
      periodDays: 1,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(result.eventCount).toBe(2);
    expect(result.sourceFileCount).toBe(1);
    expect(result.total).toEqual({
      inputTokens: 55,
      cachedInputTokens: 45,
      outputTokens: 15,
      reasoningOutputTokens: 4,
      totalTokens: 70
    });
    expect(result.byModel).toEqual([expect.objectContaining({ model: "child-model", totalTokens: 70 })]);
  });

  it("skips session files that cannot contain records in the requested period", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    const oldFile = await writeSession(sessionsPath, "old.jsonl", [
      { type: "turn_context", payload: { model: "old-model" } },
      tokenCountEvent("2026-07-14T01:00:00.000Z", 900)
    ]);
    await utimes(oldFile, new Date(NOW - 6 * 24 * 60 * 60 * 1000), new Date(NOW - 6 * 24 * 60 * 60 * 1000));
    await writeSession(sessionsPath, "recent.jsonl", [
      { type: "turn_context", payload: { model: "recent-model" } },
      tokenCountEvent("2026-07-14T01:00:00.000Z", 100)
    ]);

    const result = await scanLocalUsageSessions({
      sessionsPath,
      periodDays: 3,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(result.sourceFileCount).toBe(1);
    expect(result.eventCount).toBe(1);
    expect(result.total.totalTokens).toBe(100);
    expect(result.byModel).toEqual([expect.objectContaining({ model: "recent-model", totalTokens: 100 })]);
  });

  it("parses only records that can affect usage aggregation", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    await writeSession(sessionsPath, "mixed.jsonl", [
      { type: "event_msg", payload: { type: "user_message", message: "large conversation payload" } },
      { type: "response_item", payload: { type: "function_call_output", output: "large tool payload" } },
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      tokenCountEvent("2026-07-14T01:00:00.000Z", 100)
    ]);
    const parseSpy = vi.spyOn(JSON, "parse");

    const result = await scanLocalUsageSessions({
      sessionsPath,
      periodDays: 3,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(result.eventCount).toBe(1);
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });

  it("assigns token deltas to the latest Manager-attributed account and quota window", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    const attributionDirectory = path.join(root, "usage-attribution");
    await writeSession(sessionsPath, "2026/07/14/attributed.jsonl", [
      { type: "session_meta", payload: { id: "thread-a", session_id: "thread-a" } },
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      cumulativeTokenCountEvent(
        "2026-07-14T01:00:00.000Z",
        {
          inputTokens: 70,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 4,
          totalTokens: 100
        },
        undefined,
        {
          primary: { resets_at: 1_800_000_000 },
          secondary: { resets_at: 1_800_604_800 }
        }
      ),
      { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
      cumulativeTokenCountEvent(
        "2026-07-14T01:01:00.000Z",
        {
          inputTokens: 105,
          cachedInputTokens: 30,
          outputTokens: 45,
          reasoningOutputTokens: 6,
          totalTokens: 150
        },
        {
          inputTokens: 35,
          cachedInputTokens: 10,
          outputTokens: 15,
          reasoningOutputTokens: 2,
          totalTokens: 50
        },
        {
          primary: { resets_at: 1_800_001_000 },
          secondary: { resets_at: 1_800_605_000 }
        }
      )
    ]);
    await writeUsageAttribution(attributionDirectory, [
      { v: 1, t: Date.parse("2026-07-14T00:59:00.000Z"), th: "thread-a", a: "local-account-a" },
      { v: 1, t: Date.parse("2026-07-14T01:00:30.000Z"), th: "thread-a", a: "local-account-b" }
    ]);

    const result = await scanLocalUsageAndAccountTokenUsage({
      sessionsPath,
      usageAttributionDirectory: attributionDirectory,
      periodDays: 1,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(result.localUsage.total.totalTokens).toBe(150);
    expect(result.accountTokenUsage.status).toBe("ready");
    expect(result.accountTokenUsage.windowsByAccount["local-account-a"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          window: "hourly",
          resetAt: 1_800_000_000,
          totalTokens: 100,
          byModel: [expect.objectContaining({ model: "gpt-5.6-sol", totalTokens: 100 })]
        }),
        expect.objectContaining({ window: "weekly", resetAt: 1_800_604_800, totalTokens: 100 })
      ])
    );
    expect(result.accountTokenUsage.windowsByAccount["local-account-b"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          window: "hourly",
          resetAt: 1_800_001_000,
          totalTokens: 50,
          byModel: [expect.objectContaining({ model: "gpt-5.6-terra", totalTokens: 50 })]
        }),
        expect.objectContaining({ window: "weekly", resetAt: 1_800_605_000, totalTokens: 50 })
      ])
    );
    expect(
      findAccountTokenUsageWindow(result.accountTokenUsage, "local-account-b", "hourly", 1_800_001_000)
    ).toMatchObject({ totalTokens: 50 });
    expect(
      findAccountTokenUsageWindow(result.accountTokenUsage, "local-account-b", "hourly", 1_800_001_600)
    ).toBeUndefined();
  });

  it("treats a lone long primary quota window as the long-term account window", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    const attributionDirectory = path.join(root, "usage-attribution");
    await writeSession(sessionsPath, "2026/07/14/long-window.jsonl", [
      { type: "session_meta", payload: { id: "thread-long-window" } },
      cumulativeTokenCountEvent(
        "2026-07-14T01:00:00.000Z",
        {
          inputTokens: 70,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 4,
          totalTokens: 100
        },
        undefined,
        {
          primary: {
            resets_at: 1_800_604_800,
            window_minutes: 43_200
          }
        }
      )
    ]);
    await writeUsageAttribution(attributionDirectory, [
      { v: 1, t: Date.parse("2026-07-14T00:59:00.000Z"), th: "thread-long-window", a: "local-account-plus" }
    ]);

    const result = await scanLocalUsageAndAccountTokenUsage({
      sessionsPath,
      usageAttributionDirectory: attributionDirectory,
      periodDays: 1,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(result.accountTokenUsage.windowsByAccount["local-account-plus"]).toEqual([
      expect.objectContaining({ window: "weekly", resetAt: 1_800_604_800, totalTokens: 100 })
    ]);
    expect(
      findAccountTokenUsageWindow(result.accountTokenUsage, "local-account-plus", "weekly", 1_800_604_800)
    ).toMatchObject({ totalTokens: 100 });
  });

  it("uses an explicit five-hour duration before the provider window slot name", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    const attributionDirectory = path.join(root, "usage-attribution");
    await writeSession(sessionsPath, "2026/07/14/restored-five-hour.jsonl", [
      { type: "session_meta", payload: { id: "thread-restored-five-hour" } },
      cumulativeTokenCountEvent(
        "2026-07-14T01:00:00.000Z",
        {
          inputTokens: 70,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 4,
          totalTokens: 100
        },
        undefined,
        {
          secondary: {
            resets_at: 1_800_000_000,
            window_minutes: 300
          }
        }
      )
    ]);
    await writeUsageAttribution(attributionDirectory, [
      { v: 1, t: Date.parse("2026-07-14T00:59:00.000Z"), th: "thread-restored-five-hour", a: "local-account" }
    ]);

    const result = await scanLocalUsageAndAccountTokenUsage({
      sessionsPath,
      usageAttributionDirectory: attributionDirectory,
      periodDays: 1,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(result.accountTokenUsage.windowsByAccount["local-account"]).toEqual([
      expect.objectContaining({ window: "hourly", resetAt: 1_800_000_000, totalTokens: 100 })
    ]);
  });

  it("keeps per-model totals when one account uses multiple models in one quota window", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    const attributionDirectory = path.join(root, "usage-attribution");
    const rateLimits = {
      primary: { resets_at: 1_800_000_000 },
      secondary: { resets_at: 1_800_604_800 }
    };
    await writeSession(sessionsPath, "2026/07/14/multi-model.jsonl", [
      { type: "session_meta", payload: { id: "thread-multi-model" } },
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      cumulativeTokenCountEvent(
        "2026-07-14T01:00:00.000Z",
        {
          inputTokens: 80,
          cachedInputTokens: 20,
          outputTokens: 20,
          reasoningOutputTokens: 3,
          totalTokens: 100
        },
        undefined,
        rateLimits
      ),
      { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
      cumulativeTokenCountEvent(
        "2026-07-14T01:01:00.000Z",
        {
          inputTokens: 120,
          cachedInputTokens: 30,
          outputTokens: 30,
          reasoningOutputTokens: 5,
          totalTokens: 150
        },
        {
          inputTokens: 40,
          cachedInputTokens: 10,
          outputTokens: 10,
          reasoningOutputTokens: 2,
          totalTokens: 50
        },
        rateLimits
      )
    ]);
    await writeUsageAttribution(attributionDirectory, [
      { v: 1, t: Date.parse("2026-07-14T00:59:00.000Z"), th: "thread-multi-model", a: "local-account" }
    ]);

    const result = await scanLocalUsageAndAccountTokenUsage({
      sessionsPath,
      usageAttributionDirectory: attributionDirectory,
      periodDays: 1,
      timeZone: TIME_ZONE,
      now: NOW
    });

    expect(
      findAccountTokenUsageWindow(result.accountTokenUsage, "local-account", "hourly", 1_800_000_000)
    ).toMatchObject({
      totalTokens: 150,
      byModel: [
        expect.objectContaining({ model: "gpt-5.6-sol", totalTokens: 100 }),
        expect.objectContaining({ model: "gpt-5.6-terra", totalTokens: 50 })
      ]
    });
  });

  it("keeps the full current account quota window despite local-range trimming and reset timestamp jitter", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    const attributionDirectory = path.join(root, "usage-attribution");
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    const resetAt = 1_900_000_000;
    await writeSession(sessionsPath, "2026/07/31/long-window-history.jsonl", [
      { type: "session_meta", payload: { id: "thread-long-window-history" } },
      cumulativeTokenCountEvent(
        "2026-07-01T12:00:00.000Z",
        {
          inputTokens: 70,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 4,
          totalTokens: 100
        },
        undefined,
        {
          primary: { resets_at: resetAt - 18, window_minutes: 43_200 }
        }
      ),
      cumulativeTokenCountEvent(
        "2026-07-31T01:00:00.000Z",
        {
          inputTokens: 105,
          cachedInputTokens: 30,
          outputTokens: 45,
          reasoningOutputTokens: 6,
          totalTokens: 150
        },
        {
          inputTokens: 35,
          cachedInputTokens: 10,
          outputTokens: 15,
          reasoningOutputTokens: 2,
          totalTokens: 50
        },
        {
          primary: { resets_at: resetAt + 1, window_minutes: 43_200 }
        }
      )
    ]);
    await writeUsageAttribution(attributionDirectory, [
      { v: 1, t: Date.parse("2026-07-01T11:59:00.000Z"), th: "thread-long-window-history", a: "local-account" }
    ]);

    const result = await scanLocalUsageAndAccountTokenUsage({
      sessionsPath,
      usageAttributionDirectory: attributionDirectory,
      periodDays: 1,
      timeZone: TIME_ZONE,
      now
    });

    expect(result.localUsage.total.totalTokens).toBe(50);
    expect(
      findAccountTokenUsageWindow(result.accountTokenUsage, "local-account", "weekly", resetAt)
    ).toMatchObject({
      resetAt,
      inputTokens: 105,
      cachedInputTokens: 30,
      outputTokens: 45,
      reasoningOutputTokens: 6,
      totalTokens: 150,
      eventCount: 2
    });
    expect(findAccountTokenUsageWindow(result.accountTokenUsage, "local-account", "weekly", resetAt + 62)).toBeUndefined();
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
    await expect(readFile(path.join(storagePath, "local-usage-analytics-v7.json"), "utf8")).resolves.toContain(
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

  it("forces a fresh scan when local usage is manually refreshed inside the cache window", async () => {
    const root = await createTempDirectory();
    const storagePath = path.join(root, "storage");
    let scanCount = 0;
    const scanner: LocalUsageScanner = vi.fn(async ({ periodDays, now: scannedAt }) => {
      scanCount += 1;
      return readySnapshot(periodDays, scannedAt, scanCount * 100);
    });
    const service = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      sessionsPath: path.join(root, "sessions"),
      timeZone: TIME_ZONE,
      now: () => NOW,
      scanner
    });

    const initialRefresh = waitForRefresh();
    await service.getSnapshot(initialRefresh.resolve);
    await initialRefresh.promise;
    expect(scanner).toHaveBeenCalledTimes(1);

    await service.refresh();

    expect(scanner).toHaveBeenCalledTimes(2);
    expect((await service.getSnapshot()).total.totalTokens).toBe(200);
  });

  it("backfills a long range once and reuses daily coverage on later refreshes", async () => {
    const root = await createTempDirectory();
    const storagePath = path.join(root, "storage");
    let now = NOW;
    const periods: number[] = [];
    const scanner: LocalUsageScanner = vi.fn(async ({ periodDays, now: scannedAt }) => {
      periods.push(periodDays);
      return readySnapshotWithDailyCoverage(periodDays, scannedAt);
    });
    const service = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      sessionsPath: path.join(root, "sessions"),
      timeZone: TIME_ZONE,
      now: () => now,
      scanner,
      enabledRanges: ["7m"],
      backgroundRefreshEnabled: false
    });

    await service.refresh();
    await service.refresh();
    now += 24 * 60 * 60 * 1000;
    await service.refresh();

    expect(periods[0]).toBeGreaterThan(180);
    expect(periods[1]).toBe(4);
    expect(periods[2]).toBe(4);
    expect((await service.getSnapshot()).byDay.some((row) => row.date === "2026-01-01")).toBe(true);
  });

  it("keeps the Dashboard cache read-only until an explicit refresh", async () => {
    const root = await createTempDirectory();
    const storagePath = path.join(root, "storage");
    let scanCount = 0;
    const scanner: LocalUsageScanner = vi.fn(async ({ periodDays, now: scannedAt }) => {
      scanCount += 1;
      return readySnapshot(periodDays, scannedAt, scanCount * 100);
    });
    const service = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      sessionsPath: path.join(root, "sessions"),
      timeZone: TIME_ZONE,
      now: () => NOW,
      scanner,
      backgroundRefreshEnabled: false
    });

    expect((await service.getSnapshot()).status).toBe("loading");
    expect(scanner).not.toHaveBeenCalled();

    await service.refresh();
    expect(scanner).toHaveBeenCalledOnce();
    expect((await service.getSnapshot()).total.totalTokens).toBe(100);

    const stale = await new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      sessionsPath: path.join(root, "sessions"),
      timeZone: TIME_ZONE,
      now: () => NOW + LOCAL_USAGE_CACHE_TTL_MS + 1,
      scanner,
      backgroundRefreshEnabled: false
    }).getSnapshot();
    expect(stale.isRefreshing).toBe(false);
    expect(scanner).toHaveBeenCalledOnce();
  });

  it("adopts a newer shared cache snapshot after its first in-memory load", async () => {
    const root = await createTempDirectory();
    const storagePath = path.join(root, "storage");
    let now = NOW;
    let primaryScanCount = 0;
    const primary = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      timeZone: TIME_ZONE,
      now: () => now,
      scanner: vi.fn(async ({ periodDays, now: scannedAt }) => {
        primaryScanCount += 1;
        return readySnapshot(periodDays, scannedAt, primaryScanCount * 100);
      })
    });
    const secondaryScanner: LocalUsageScanner = vi.fn(async () => {
      throw new Error("the secondary host should adopt the shared aggregate");
    });
    const secondary = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      timeZone: TIME_ZONE,
      now: () => now,
      scanner: secondaryScanner
    });

    const initialRefresh = waitForRefresh();
    await primary.getSnapshot(initialRefresh.resolve);
    await initialRefresh.promise;
    expect((await secondary.getSnapshot()).total.totalTokens).toBe(100);

    now += LOCAL_USAGE_CACHE_TTL_MS + 1;
    const nextRefresh = waitForRefresh();
    await primary.getSnapshot(nextRefresh.resolve);
    await nextRefresh.promise;

    expect((await secondary.getSnapshot()).total.totalTokens).toBe(200);
    expect(secondaryScanner).not.toHaveBeenCalled();
  });

  it("serializes scans across hosts and reaps an expired scan lease", async () => {
    const root = await createTempDirectory();
    const storagePath = path.join(root, "storage");
    let now = NOW;
    const scanStarted = waitForRefresh();
    const allowScanToFinish = waitForRefresh();
    const firstScanner: LocalUsageScanner = vi.fn(async ({ periodDays, now: scannedAt }) => {
      scanStarted.resolve();
      await allowScanToFinish.promise;
      return readySnapshot(periodDays, scannedAt, 100);
    });
    const secondScanner: LocalUsageScanner = vi.fn(async ({ periodDays, now: scannedAt }) =>
      readySnapshot(periodDays, scannedAt, 200)
    );
    const first = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      timeZone: TIME_ZONE,
      now: () => now,
      scanner: firstScanner
    });
    const second = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      timeZone: TIME_ZONE,
      now: () => now,
      scanner: secondScanner
    });

    const firstRefresh = waitForRefresh();
    await first.getSnapshot(firstRefresh.resolve);
    await scanStarted.promise;
    const secondRefresh = waitForRefresh();
    await second.getSnapshot(secondRefresh.resolve);
    allowScanToFinish.resolve();
    await Promise.all([firstRefresh.promise, secondRefresh.promise]);

    expect(firstScanner).toHaveBeenCalledTimes(1);
    expect(secondScanner).not.toHaveBeenCalled();
    expect((await second.getSnapshot()).total.totalTokens).toBe(100);

    now += LOCAL_USAGE_CACHE_TTL_MS + 1;
    const leasePath = path.join(storagePath, LOCAL_USAGE_SCAN_LEASE_FILE_NAME);
    await mkdir(leasePath, { recursive: true });
    await writeFile(
      path.join(leasePath, "owner.json"),
      JSON.stringify({ token: "expired", pid: -1, expiresAt: Date.now() - 1 }),
      "utf8"
    );
    const recoveryScanner: LocalUsageScanner = vi.fn(async ({ periodDays, now: scannedAt }) =>
      readySnapshot(periodDays, scannedAt, 300)
    );
    const recovery = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      timeZone: TIME_ZONE,
      now: () => now,
      scanner: recoveryScanner
    });
    const recoveredRefresh = waitForRefresh();
    await recovery.getSnapshot(recoveredRefresh.resolve);
    await recoveredRefresh.promise;

    expect(recoveryScanner).toHaveBeenCalledTimes(1);
    expect((await recovery.getSnapshot()).total.totalTokens).toBe(300);
  });

  it("persists sanitized aggregate and account-window caches without session content or thread identifiers", async () => {
    const root = await createTempDirectory();
    const sessionsPath = path.join(root, "sessions");
    const storagePath = path.join(root, "storage");
    const attributionDirectory = path.join(root, "usage-attribution");
    const secretMessage = "private-conversation-marker";
    const secretAccountId = "account-sensitive-marker";
    const secretCredential = "credential-sensitive-marker";
    const secretPathMarker = "private-session-path-marker";
    const secretThreadId = "private-thread-marker";
    const localAccountId = "local-account-marker";
    await writeSession(sessionsPath, `2026/07/14/${secretPathMarker}.jsonl`, [
      { type: "session_meta", payload: { id: secretThreadId, session_id: secretThreadId } },
      {
        type: "event_msg",
        timestamp: "2026-07-14T01:00:00.000Z",
        payload: { type: "user_message", message: secretMessage }
      },
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      {
        type: "event_msg",
        timestamp: "2026-07-14T01:10:00.000Z",
        payload: {
          type: "token_count",
          account_id: secretAccountId,
          access_token: secretCredential,
          rate_limits: {
            primary: { resets_at: 1_800_000_000 },
            secondary: { resets_at: 1_800_604_800 }
          },
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 3,
              reasoning_output_tokens: 1,
              total_tokens: 13
            }
          }
        }
      }
    ]);
    await writeUsageAttribution(attributionDirectory, [
      { v: 1, t: Date.parse("2026-07-14T01:00:00.000Z"), th: secretThreadId, a: localAccountId }
    ]);
    const service = new LocalUsageAnalyticsService({
      globalStoragePath: storagePath,
      sessionsPath,
      timeZone: TIME_ZONE,
      now: () => NOW,
      usageAttributionDirectory: attributionDirectory
    });
    const refreshed = waitForRefresh();
    await service.getSnapshot(refreshed.resolve);
    await refreshed.promise;

    const persisted = await readFile(path.join(storagePath, "local-usage-analytics-v7.json"), "utf8");
    expect(persisted).toContain('"totalTokens":13');
    expect(persisted).not.toContain(secretMessage);
    expect(persisted).not.toContain(secretAccountId);
    expect(persisted).not.toContain(secretCredential);
    expect(persisted).not.toContain(secretPathMarker);
    expect(persisted).not.toContain(secretThreadId);
    expect(persisted).not.toContain(localAccountId);

    const accountWindowCache = await readFile(path.join(storagePath, ACCOUNT_TOKEN_USAGE_CACHE_FILE_NAME), "utf8");
    expect(accountWindowCache).toContain(localAccountId);
    expect(accountWindowCache).toContain('"totalTokens":13');
    expect(accountWindowCache).not.toContain(secretMessage);
    expect(accountWindowCache).not.toContain(secretAccountId);
    expect(accountWindowCache).not.toContain(secretCredential);
    expect(accountWindowCache).not.toContain(secretPathMarker);
    expect(accountWindowCache).not.toContain(secretThreadId);
  });
});

function readySnapshot(periodDays: number, calculatedAt: number, totalTokens: number): DashboardLocalUsageViewModel {
  return {
    status: "ready",
    isRefreshing: false,
    periodDays,
    timeZone: TIME_ZONE,
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
    by3Hour: [],
    by3HourAndModel: [],
    byDay: [],
    byModel: [],
    byDayAndModel: []
  };
}

function readySnapshotWithDailyCoverage(periodDays: number, calculatedAt: number): DashboardLocalUsageViewModel {
  const today = new Date(calculatedAt + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [year, month, day] = today.split("-").map(Number);
  const dates = Array.from({ length: Math.max(1, Math.floor(periodDays)) }, (_, index) => {
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) - (periodDays - index - 1)));
    return date.toISOString().slice(0, 10);
  });
  const byDay = dates.map((date) => ({
    date,
    eventCount: date === today ? 1 : 0,
    ...testTotals(date === today ? 1 : 0)
  }));
  const activeModel = {
    model: "gpt-5.6-sol",
    ...testTotals(1)
  };
  return {
    status: "ready",
    isRefreshing: false,
    periodDays,
    timeZone: TIME_ZONE,
    calculatedAt,
    nextRefreshAt: calculatedAt + LOCAL_USAGE_CACHE_TTL_MS,
    sourceFileCount: 1,
    eventCount: 1,
    total: testTotals(1),
    by3Hour: [],
    by3HourAndModel: [],
    byDay,
    byModel: [activeModel],
    byDayAndModel: [{ date: today, ...activeModel }]
  };
}

function testTotals(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens
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

async function writeSession(sessionsPath: string, relativePath: string, records: unknown[]): Promise<string> {
  const filePath = path.join(sessionsPath, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return filePath;
}

async function writeUsageAttribution(directory: string, records: unknown[]): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "test.jsonl");
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return filePath;
}

function tokenCountEvent(timestamp: string, totalTokens: number): unknown {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: totalTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalTokens
        }
      }
    }
  };
}

type TestTokenTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

function cumulativeTokenCountEvent(
  timestamp: string,
  cumulative: TestTokenTotals,
  last: TestTokenTotals = cumulative,
  rateLimits?: unknown
): unknown {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      ...(rateLimits ? { rate_limits: rateLimits } : {}),
      info: {
        total_token_usage: {
          input_tokens: cumulative.inputTokens,
          cached_input_tokens: cumulative.cachedInputTokens,
          output_tokens: cumulative.outputTokens,
          reasoning_output_tokens: cumulative.reasoningOutputTokens,
          total_tokens: cumulative.totalTokens
        },
        last_token_usage: {
          input_tokens: last.inputTokens,
          cached_input_tokens: last.cachedInputTokens,
          output_tokens: last.outputTokens,
          reasoning_output_tokens: last.reasoningOutputTokens,
          total_tokens: last.totalTokens
        }
      }
    }
  };
}
