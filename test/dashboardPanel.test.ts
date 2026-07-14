import { describe, expect, it, vi } from "vitest";
import type { DashboardState } from "../src/domain/dashboard/types";

const { buildDashboardStateMock, backfillMissingResetCreditExpiriesMock } = vi.hoisted(() => ({
  buildDashboardStateMock: vi.fn(),
  backfillMissingResetCreditExpiriesMock: vi.fn()
}));

vi.mock("../src/application/dashboard/buildDashboardState", () => ({
  buildDashboardState: buildDashboardStateMock
}));

vi.mock("../src/presentation/dashboard/resetCreditsBackfill", () => ({
  backfillMissingResetCreditExpiries: backfillMissingResetCreditExpiriesMock
}));

import { publishDashboardSnapshot } from "../src/presentation/dashboard/panel";

const localUsage = {
  status: "ready" as const,
  isRefreshing: false,
  periodDays: 7,
  calculatedAt: 1,
  nextRefreshAt: 2,
  sourceFileCount: 1,
  eventCount: 1,
  total: {
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 1,
    totalTokens: 15
  },
  byDay: [],
  byModel: [],
  byDayAndModel: [],
  byThreeHour: [],
  byThreeHourAndModel: []
};

function createState(): DashboardState {
  return {
    lang: "en",
    panelTitle: "Quota Summary",
    brandSub: "sub",
    logoUri: "logo",
    settings: {
      dashboardTheme: "dark",
      localUsageDefaultRange: "7d",
      localUsageShowEquivalentPrice: true,
      displayLanguage: "en",
      autoRefreshMinutes: 0,
      backgroundTokenRefreshEnabled: true,
      autoSwitchEnabled: false,
      hourlyQuotaControlEnabled: false,
      autoSwitchReloadWindowEnabled: false,
      autoSwitchHourlyThreshold: 20,
      autoSwitchWeeklyThreshold: 20,
      autoSwitchLockMinutes: 0,
      quotaWarningEnabled: false,
      quotaWarningThreshold: 20,
      quotaGreenThreshold: 60,
      quotaYellowThreshold: 20,
      codexAppRestartEnabled: false,
      codexAppRestartMode: "manual",
      codexAppPath: "",
      resolvedCodexAppPath: ""
    },
    copy: {} as DashboardState["copy"],
    tokenAutomation: {
      enabled: true
    },
    announcements: {
      announcements: [],
      unreadIds: []
    },
    indexHealth: {
      status: "healthy",
      availableBackups: 0
    },
    accounts: [
      {
        id: "account-1",
        email: "dev@example.com",
        displayName: "dev@example.com",
        tags: [],
        planTypeLabel: "Plus",
        isActive: true,
        showInStatusBar: false,
        healthKind: "healthy",
        dismissedHealth: false,
        metrics: [],
        resetCreditsAvailable: 1
      } as DashboardState["accounts"][number]
    ]
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    })
  ]);
}

describe("publishDashboardSnapshot", () => {
  it("includes the sanitized local usage snapshot without delaying the dashboard", async () => {
    const state = createState();
    buildDashboardStateMock.mockResolvedValue(state);
    backfillMissingResetCreditExpiriesMock.mockResolvedValue(false);
    const usageAnalytics = {
      getSnapshot: vi.fn(async () => localUsage)
    };

    await publishDashboardSnapshot({
      repo: {} as never,
      settingsStore: {} as never,
      logoUri: "logo",
      announcementsState: state.announcements,
      setPanelTitle: vi.fn(),
      postMessage: vi.fn(async () => true),
      schedulePublishState: vi.fn(),
      usageAnalytics: usageAnalytics as never
    });

    expect(usageAnalytics.getSnapshot).toHaveBeenCalledTimes(1);
    expect(buildDashboardStateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "logo",
      state.announcements,
      localUsage
    );
  });

  it("publishes the current snapshot without waiting for reset credits backfill", async () => {
    const state = createState();
    let resolveBackfill: (value: boolean) => void = () => undefined;

    buildDashboardStateMock.mockResolvedValue(state);
    backfillMissingResetCreditExpiriesMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveBackfill = resolve;
        })
    );

    const setPanelTitle = vi.fn();
    const postMessage = vi.fn(async () => true);
    const schedulePublishState = vi.fn();

    const result = await withTimeout(
      publishDashboardSnapshot({
        repo: {} as never,
        settingsStore: {} as never,
        logoUri: "logo",
        announcementsState: state.announcements,
        setPanelTitle,
        postMessage,
        schedulePublishState
      }),
      50
    );

    expect(result).not.toBe("timeout");
    expect(setPanelTitle).toHaveBeenCalledWith("Quota Summary");
    expect(postMessage).toHaveBeenCalledWith({
      type: "dashboard:snapshot",
      state
    });
    expect(schedulePublishState).not.toHaveBeenCalled();

    resolveBackfill(true);
  });

  it("schedules a follow-up publish after backfill updates the repository", async () => {
    const state = createState();
    buildDashboardStateMock.mockResolvedValue(state);
    backfillMissingResetCreditExpiriesMock.mockImplementation(async (_repo, _accounts, onUpdated) => {
      onUpdated();
      return true;
    });

    const schedulePublishState = vi.fn();

    await publishDashboardSnapshot({
      repo: {} as never,
      settingsStore: {} as never,
      logoUri: "logo",
      announcementsState: state.announcements,
      setPanelTitle: vi.fn(),
      postMessage: vi.fn(async () => true),
      schedulePublishState
    });

    await Promise.resolve();

    expect(schedulePublishState).toHaveBeenCalledTimes(1);
  });
});
