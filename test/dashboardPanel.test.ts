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

import {
  DASHBOARD_LOCAL_USAGE_MIN_REFRESH_DELAY_MS,
  getDashboardLocalUsageRefreshDelay,
  publishDashboardSnapshot
} from "../src/presentation/dashboard/panel";
import { getLowWeeklyQuotaAccountIds } from "../webview-src/dashboard/helpers";
import { createInitialState, reducer } from "../webview-src/dashboard/state";

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
      hotSwitchEnabled: false,
      seamlessSwitchEnabled: false,
      seamlessSwitchQuotaBandsEnabled: false,
      seamlessSwitchQuotaBandSize: 20,
      seamlessSwitchReserveThreshold: 3,
      seamlessSwitchEmergencySwitchEnabled: false,
      seamlessSwitchGroupAVisible: true,
      seamlessSwitchGroupBVisible: true,
      seamlessSwitchGroupCVisible: true,
      hotSwitchGraceSeconds: 60,
      hotSwitchLongTurnPolicy: "defer",
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

describe("Dashboard account selection", () => {
  it("only targets visible, non-hidden accounts whose weekly quota is below 3%", () => {
    const accounts = [
      {
        id: "below-threshold",
        isHidden: false,
        metrics: [{ key: "weekly", label: "Weekly", percentage: 2.99, visible: true }]
      },
      {
        id: "at-threshold",
        isHidden: false,
        metrics: [{ key: "weekly", label: "Weekly", percentage: 3, visible: true }]
      },
      {
        id: "hidden-low-quota",
        isHidden: true,
        metrics: [{ key: "weekly", label: "Weekly", percentage: 1, visible: true }]
      },
      {
        id: "no-weekly-window",
        isHidden: false,
        metrics: [{ key: "weekly", label: "Weekly", percentage: 1, visible: false }]
      }
    ] as DashboardState["accounts"];

    expect(getLowWeeklyQuotaAccountIds(accounts)).toEqual(["below-threshold"]);
  });

  it("deselects only accounts that were actually hidden", () => {
    let state = createInitialState();
    state = reducer(state, { type: "toggle-select", accountId: "hidden-account" });
    state = reducer(state, { type: "toggle-select", accountId: "still-selected" });

    const nextState = reducer(state, { type: "deselect-accounts", accountIds: ["hidden-account"] });

    expect(nextState.selectedAccountIds).toEqual(["still-selected"]);
  });
});

describe("publishDashboardSnapshot", () => {
  it("includes the sanitized local usage snapshot without delaying the dashboard", async () => {
    const state = createState();
    buildDashboardStateMock.mockResolvedValue(state);
    backfillMissingResetCreditExpiriesMock.mockResolvedValue(false);
    const usageAnalytics = {
      getSnapshot: vi.fn(async () => localUsage)
    };
    const scheduleLocalUsageRefresh = vi.fn();

    await publishDashboardSnapshot({
      repo: {} as never,
      settingsStore: {} as never,
      logoUri: "logo",
      announcementsState: state.announcements,
      setPanelTitle: vi.fn(),
      postMessage: vi.fn(async () => true),
      schedulePublishState: vi.fn(),
      scheduleLocalUsageRefresh,
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
    expect(scheduleLocalUsageRefresh).toHaveBeenCalledWith(localUsage.nextRefreshAt);
  });

  it("uses the aggregate deadline for active refreshes and throttles overdue retries", () => {
    expect(getDashboardLocalUsageRefreshDelay(20_000, 15_000)).toBe(5_000);
    expect(getDashboardLocalUsageRefreshDelay(14_999, 15_000)).toBe(DASHBOARD_LOCAL_USAGE_MIN_REFRESH_DELAY_MS);
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
