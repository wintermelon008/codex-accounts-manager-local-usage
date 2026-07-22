import { describe, expect, it } from "vitest";
import { buildDashboardStateSignature } from "../src/presentation/dashboard/signature";
import type { DashboardState } from "../src/domain/dashboard/types";

function createState(overrides?: {
  resetCreditsAvailable?: number;
  resetCreditsNextExpiresAt?: number;
  isHidden?: boolean;
  accountGroup?: "A" | "B" | "C";
  tokenUsage?: { totalTokens: number; resetAt: number };
}): DashboardState {
  return {
    lang: "zh",
    panelTitle: "title",
    brandSub: "sub",
    logoUri: "logo",
    settings: {
      dashboardTheme: "dark",
      localUsageDefaultRange: "7d",
      localUsageShowEquivalentPrice: true,
      displayLanguage: "zh",
      autoRefreshMinutes: 0,
      backgroundTokenRefreshEnabled: true,
      autoSwitchEnabled: false,
      hotSwitchEnabled: true,
      seamlessSwitchEnabled: true,
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
        isHidden: overrides?.isHidden ?? false,
        accountGroup: overrides?.accountGroup,
        balancePoolEnabled: false,
        showInStatusBar: false,
        healthKind: "healthy",
        dismissedHealth: false,
        metrics: [],
        resetCreditsAvailable: overrides?.resetCreditsAvailable,
        resetCreditsNextExpiresAt: overrides?.resetCreditsNextExpiresAt,
        tokenUsage: overrides?.tokenUsage
          ? {
              status: "tracking",
              window: "hourly",
              resetAt: overrides.tokenUsage.resetAt,
              inputTokens: overrides.tokenUsage.totalTokens,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: overrides.tokenUsage.totalTokens
            }
          : undefined
      } as DashboardState["accounts"][number]
    ]
  };
}

describe("buildDashboardStateSignature", () => {
  it("changes when reset credits expiry changes", () => {
    const before = buildDashboardStateSignature(createState({ resetCreditsAvailable: 1 }));
    const after = buildDashboardStateSignature(
      createState({ resetCreditsAvailable: 1, resetCreditsNextExpiresAt: 1_800_000_000 })
    );

    expect(after).not.toBe(before);
  });

  it("changes when an account is hidden or unhidden", () => {
    expect(buildDashboardStateSignature(createState({ isHidden: true }))).not.toBe(
      buildDashboardStateSignature(createState({ isHidden: false }))
    );
  });

  it("changes when an account group or its visible-group setting changes", () => {
    const base = createState();
    const grouped = createState({ accountGroup: "A" });
    const groupFilterChanged: DashboardState = {
      ...base,
      settings: { ...base.settings, seamlessSwitchGroupAVisible: false }
    };

    expect(buildDashboardStateSignature(grouped)).not.toBe(buildDashboardStateSignature(base));
    expect(buildDashboardStateSignature(groupFilterChanged)).not.toBe(buildDashboardStateSignature(base));
  });

  it("changes when local usage settings or the cached aggregate changes", () => {
    const base = createState();
    const rangeChanged: DashboardState = {
      ...base,
      settings: {
        ...base.settings,
        localUsageDefaultRange: "14d"
      }
    };
    const usageChanged: DashboardState = {
      ...base,
      localUsage: {
        status: "ready",
        isRefreshing: false,
        periodDays: 14,
        calculatedAt: 100,
        nextRefreshAt: 200,
        sourceFileCount: 1,
        eventCount: 1,
        total: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 3,
          reasoningOutputTokens: 1,
          totalTokens: 13
        },
        byDay: [
          {
            date: "2026-07-14",
            eventCount: 1,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 3,
            reasoningOutputTokens: 1,
            totalTokens: 13
          }
        ],
        byModel: [
          {
            model: "gpt-5.6-sol",
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 3,
            reasoningOutputTokens: 1,
            totalTokens: 13
          }
        ],
        byDayAndModel: [
          {
            date: "2026-07-14",
            model: "gpt-5.6-sol",
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 3,
            reasoningOutputTokens: 1,
            totalTokens: 13
          }
        ],
        byThreeHour: [
          {
            startAt: 100,
            endAt: 10_800_100,
            eventCount: 1,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 3,
            reasoningOutputTokens: 1,
            totalTokens: 13
          }
        ],
        byThreeHourAndModel: [
          {
            startAt: 100,
            model: "gpt-5.6-sol",
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 3,
            reasoningOutputTokens: 1,
            totalTokens: 13
          }
        ]
      }
    };

    const baseSignature = buildDashboardStateSignature(base);
    expect(buildDashboardStateSignature(rangeChanged)).not.toBe(baseSignature);
    expect(buildDashboardStateSignature(usageChanged)).not.toBe(baseSignature);
  });

  it("changes when quota-band balancing or pool membership changes", () => {
    const base = createState();
    const settingChanged: DashboardState = {
      ...base,
      settings: { ...base.settings, seamlessSwitchQuotaBandsEnabled: true }
    };
    const poolChanged: DashboardState = {
      ...base,
      accounts: [{ ...base.accounts[0]!, balancePoolEnabled: true }]
    };

    const baseSignature = buildDashboardStateSignature(base);
    expect(buildDashboardStateSignature(settingChanged)).not.toBe(baseSignature);
    expect(buildDashboardStateSignature(poolChanged)).not.toBe(baseSignature);
  });

  it("changes when the seamless reserve threshold changes", () => {
    const base = createState();
    const changed: DashboardState = {
      ...base,
      settings: { ...base.settings, seamlessSwitchReserveThreshold: 1 }
    };

    expect(buildDashboardStateSignature(changed)).not.toBe(buildDashboardStateSignature(base));
  });

  it("changes when the quota-band size or emergency switch changes", () => {
    const base = createState();
    const sizeChanged: DashboardState = {
      ...base,
      settings: { ...base.settings, seamlessSwitchQuotaBandSize: 33 }
    };
    const emergencyChanged: DashboardState = {
      ...base,
      settings: { ...base.settings, seamlessSwitchEmergencySwitchEnabled: true }
    };

    const baseSignature = buildDashboardStateSignature(base);
    expect(buildDashboardStateSignature(sizeChanged)).not.toBe(baseSignature);
    expect(buildDashboardStateSignature(emergencyChanged)).not.toBe(baseSignature);
  });

  it("changes when the hot-switch grace period or long-turn policy changes", () => {
    const base = createState();
    const graceChanged: DashboardState = {
      ...base,
      settings: { ...base.settings, hotSwitchGraceSeconds: 30 }
    };
    const policyChanged: DashboardState = {
      ...base,
      settings: { ...base.settings, hotSwitchLongTurnPolicy: "interruptAndContinue" }
    };

    const baseSignature = buildDashboardStateSignature(base);
    expect(buildDashboardStateSignature(graceChanged)).not.toBe(baseSignature);
    expect(buildDashboardStateSignature(policyChanged)).not.toBe(baseSignature);
  });

  it("changes when seamless switching is disabled", () => {
    const base = createState();
    const disabled: DashboardState = {
      ...base,
      settings: { ...base.settings, seamlessSwitchEnabled: false }
    };

    expect(buildDashboardStateSignature(disabled)).not.toBe(buildDashboardStateSignature(base));
  });

  it("changes when the current quota-window token counter changes or resets", () => {
    const before = createState({ tokenUsage: { totalTokens: 100, resetAt: 1_800_000_000 } });
    const usedMore = createState({ tokenUsage: { totalTokens: 200, resetAt: 1_800_000_000 } });
    const reset = createState({ tokenUsage: { totalTokens: 0, resetAt: 1_800_001_000 } });

    expect(buildDashboardStateSignature(usedMore)).not.toBe(buildDashboardStateSignature(before));
    expect(buildDashboardStateSignature(reset)).not.toBe(buildDashboardStateSignature(usedMore));
  });
});
