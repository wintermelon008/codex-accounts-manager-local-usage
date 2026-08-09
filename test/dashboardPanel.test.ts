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
import {
  getDashboardAccountPage,
  getDashboardVisibleAccounts,
  getHighWeeklyQuotaHiddenAccountIds,
  getLowWeeklyQuotaAccountIds
} from "../webview-src/dashboard/helpers";
import { createInitialState, reducer } from "../webview-src/dashboard/state";

const localUsage = {
  status: "ready" as const,
  isRefreshing: false,
  periodDays: 7,
  timeZone: "Asia/Shanghai",
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
  by3Hour: [],
  by3HourAndModel: [],
  byDay: [],
  byModel: [],
  byDayAndModel: []
};

const accountTokenUsage = {
  status: "ready" as const,
  isRefreshing: false,
  calculatedAt: 1,
  nextRefreshAt: 2,
  windowsByAccount: {}
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
      localUsageEnabledRanges: ["24h", "7d"],
      localUsageShowEquivalentPrice: true,
      displayLanguage: "en",
      autoRefreshMinutes: 0,
      backgroundTokenRefreshEnabled: true,
      autoSwitchEnabled: false,
      hotSwitchEnabled: false,
      seamlessSwitchEnabled: false,
      seamlessSwitchQuotaBandsEnabled: false,
      seamlessSwitchLowQuotaEnabled: false,
      seamlessSwitchQuotaBandSize: 20,
      seamlessSwitchThreshold: 3,
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
  it("paginates the displayed account set and clamps a removed last page", () => {
    const accounts = Array.from({ length: 101 }, (_, index) => `account-${index + 1}`);

    expect(getDashboardAccountPage(accounts, 1)).toMatchObject({
      page: 1,
      pageCount: 3,
      startIndex: 0,
      endIndex: 50,
      accounts: accounts.slice(0, 50)
    });
    expect(getDashboardAccountPage(accounts, 3)).toMatchObject({
      page: 3,
      pageCount: 3,
      startIndex: 100,
      endIndex: 101,
      accounts: ["account-101"]
    });
    expect(getDashboardAccountPage(accounts.slice(0, 50), 3)).toMatchObject({
      page: 1,
      pageCount: 1,
      startIndex: 0,
      endIndex: 50,
      accounts: accounts.slice(0, 50)
    });
  });

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

  it("targets hidden accounts above 90% weekly quota across all groups", () => {
    const accounts = [
      {
        id: "above-threshold",
        isHidden: true,
        accountGroup: "A",
        metrics: [{ key: "weekly", label: "Weekly", percentage: 90.01, visible: true }]
      },
      {
        id: "at-threshold",
        isHidden: true,
        accountGroup: "B",
        metrics: [{ key: "weekly", label: "Weekly", percentage: 90, visible: true }]
      },
      {
        id: "visible-high-quota",
        isHidden: false,
        metrics: [{ key: "weekly", label: "Weekly", percentage: 99, visible: true }]
      },
      {
        id: "no-weekly-window",
        isHidden: true,
        metrics: [{ key: "weekly", label: "Weekly", percentage: 99, visible: false }]
      }
    ] as DashboardState["accounts"];

    expect(getHighWeeklyQuotaHiddenAccountIds(accounts)).toEqual(["above-threshold"]);
  });

  it("deselects only accounts that were actually hidden", () => {
    let state = createInitialState();
    state = reducer(state, { type: "toggle-select", accountId: "hidden-account" });
    state = reducer(state, { type: "toggle-select", accountId: "still-selected" });

    const nextState = reducer(state, { type: "deselect-accounts", accountIds: ["hidden-account"] });

    expect(nextState.selectedAccountIds).toEqual(["still-selected"]);
  });

  it("clears accounts that leave the group filter while retaining visible selections", () => {
    const dashboardState = createState();
    dashboardState.settings = {
      ...dashboardState.settings,
      seamlessSwitchGroupAVisible: false
    };
    dashboardState.accounts = [
      {
        id: "ungrouped-account",
        isHidden: false
      },
      {
        id: "group-a-account-1",
        accountGroup: "A",
        isHidden: false
      },
      {
        id: "group-a-account-2",
        accountGroup: "A",
        isHidden: false
      },
      {
        id: "hidden-account",
        isHidden: true
      }
    ] as DashboardState["accounts"];

    let state = createInitialState();
    for (const accountId of ["ungrouped-account", "group-a-account-1", "group-a-account-2", "hidden-account"]) {
      state = reducer(state, { type: "toggle-select", accountId });
    }

    const visibleAccountIds = getDashboardVisibleAccounts(dashboardState.accounts, dashboardState.settings, false).map(
      (account) => account.id
    );
    const nextState = reducer(state, { type: "reconcile-selection-scope", visibleAccountIds });

    expect(nextState.selectedAccountIds).toEqual(["ungrouped-account"]);
  });

  it("intersects selected Free/Plus/Pro plans with the existing group and hidden-account filters", () => {
    const dashboardState = createState();
    dashboardState.settings = {
      ...dashboardState.settings,
      seamlessSwitchGroupBVisible: false
    };
    dashboardState.accounts = [
      { id: "free-a", planType: "free", accountGroup: "A", isHidden: false },
      { id: "plus-a", planType: "plus", accountGroup: "A", isHidden: false },
      { id: "pro-b", planType: "pro_20x", accountGroup: "B", isHidden: false },
      { id: "pro-hidden", planType: "pro", accountGroup: "A", isHidden: true },
      { id: "team-a", planType: "team", accountGroup: "A", isHidden: false }
    ] as DashboardState["accounts"];

    expect(
      getDashboardVisibleAccounts(dashboardState.accounts, dashboardState.settings, false, ["free", "pro"]).map(
        (account) => account.id
      )
    ).toEqual(["free-a"]);
    expect(
      getDashboardVisibleAccounts(dashboardState.accounts, dashboardState.settings, true, ["free", "pro"]).map(
        (account) => account.id
      )
    ).toEqual(["free-a", "pro-hidden"]);
    expect(
      getDashboardVisibleAccounts(dashboardState.accounts, dashboardState.settings, false).map((account) => account.id)
    ).toEqual(["free-a", "plus-a", "team-a"]);
  });

  it("clears only selections that leave the selected plan scope", () => {
    const dashboardState = createState();
    dashboardState.accounts = [
      { id: "free-account", planType: "free", isHidden: false },
      { id: "plus-account", planType: "plus", isHidden: false }
    ] as DashboardState["accounts"];

    let state = createInitialState();
    state = reducer(state, { type: "toggle-select", accountId: "free-account" });
    state = reducer(state, { type: "toggle-select", accountId: "plus-account" });
    const visibleAccountIds = getDashboardVisibleAccounts(dashboardState.accounts, dashboardState.settings, false, [
      "free"
    ]).map((account) => account.id);

    expect(reducer(state, { type: "reconcile-selection-scope", visibleAccountIds }).selectedAccountIds).toEqual([
      "free-account"
    ]);
  });

  it("keeps hidden accounts selected only while the hidden-account view is enabled", () => {
    const dashboardState = createState();
    dashboardState.accounts = [
      {
        id: "hidden-account",
        isHidden: true
      }
    ] as DashboardState["accounts"];

    let state = createInitialState();
    state = reducer(state, { type: "toggle-select", accountId: "hidden-account" });

    const shownHiddenAccountIds = getDashboardVisibleAccounts(
      dashboardState.accounts,
      dashboardState.settings,
      true
    ).map((account) => account.id);
    expect(
      reducer(state, { type: "reconcile-selection-scope", visibleAccountIds: shownHiddenAccountIds }).selectedAccountIds
    ).toEqual(["hidden-account"]);

    const hiddenAccountIds = getDashboardVisibleAccounts(dashboardState.accounts, dashboardState.settings, false).map(
      (account) => account.id
    );
    expect(
      reducer(state, { type: "reconcile-selection-scope", visibleAccountIds: hiddenAccountIds }).selectedAccountIds
    ).toEqual([]);
  });
});

describe("publishDashboardSnapshot", () => {
  it("includes the sanitized local usage snapshot without delaying the dashboard", async () => {
    const state = createState();
    buildDashboardStateMock.mockResolvedValue(state);
    backfillMissingResetCreditExpiriesMock.mockResolvedValue(false);
    const usageAnalytics = {
      getSnapshots: vi.fn(async () => ({ localUsage, accountTokenUsage }))
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

    expect(usageAnalytics.getSnapshots).toHaveBeenCalledTimes(1);
    expect(buildDashboardStateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "logo",
      state.announcements,
      localUsage,
      accountTokenUsage
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
