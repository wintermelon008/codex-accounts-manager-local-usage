import { describe, expect, it } from "vitest";
import type { DashboardAccountViewModel } from "../src/domain/dashboard/types";
import { resolveAccountDiagnostic, type AccountDiagnosticSettings } from "../webview-src/dashboard/accountDiagnostics";

const settings: AccountDiagnosticSettings = {
  seamlessSwitchEnabled: true,
  seamlessSwitchGroupAVisible: true,
  seamlessSwitchGroupBVisible: true,
  seamlessSwitchGroupCVisible: true
};

const account = (overrides: Partial<DashboardAccountViewModel> = {}): DashboardAccountViewModel =>
  ({
    id: "account-1",
    displayName: "dev@example.com",
    email: "dev@example.com",
    tags: [],
    authProviderLabel: "ChatGPT",
    accountStructureLabel: "Personal",
    workspaceLabel: "Personal",
    isTeamWorkspace: false,
    subscriptionText: "Plus",
    subscriptionTitle: "Plus",
    addMethodLabel: "OAuth",
    accountTimeLabel: "2026/10/08",
    accountTimeSource: "import",
    planTypeLabel: "Plus",
    isActive: false,
    isHidden: false,
    isCurrentWindowAccount: false,
    balancePoolEnabled: false,
    showInStatusBar: false,
    canToggleStatusBar: true,
    statusToggleTitle: "",
    hasQuota402: false,
    healthKind: "healthy",
    availability: "usable",
    renewal: "succeeded",
    healthLabel: "正常",
    dismissedHealth: false,
    quotaCountdownStartAvailable: false,
    metrics: [],
    ...overrides
  }) as DashboardAccountViewModel;

describe("resolveAccountDiagnostic", () => {
  it("separates a usable account from its pool membership", () => {
    const diagnostic = resolveAccountDiagnostic(account(), settings, "zh");

    expect(diagnostic.title).toBe("账号可用，但未参与无感切号");
    expect(diagnostic.nextStep).toContain("加入无感切号池");
    expect(diagnostic.checks).toContainEqual(expect.objectContaining({ label: "无感切号", value: "尚未加入候选池" }));
  });

  it("prioritizes an authentication failure over pool configuration", () => {
    const diagnostic = resolveAccountDiagnostic(
      account({ healthKind: "access_token_invalid", availability: "auth_unavailable", healthLabel: "访问令牌失效" }),
      settings,
      "zh"
    );

    expect(diagnostic.tone).toBe("error");
    expect(diagnostic.title).toBe("认证不可用");
    expect(diagnostic.nextStep).toContain("重新授权");
  });

  it("does not confuse a usable account without renewal with a quota limit", () => {
    const diagnostic = resolveAccountDiagnostic(
      account({ healthKind: "refresh_unavailable", availability: "usable", renewal: "unavailable" }),
      settings,
      "zh"
    );

    expect(diagnostic.title).toBe("账号可用，但无法续期");
    expect(diagnostic.nextStep).toContain("恢复续期");
  });

  it("explains when a hidden account is excluded from the visible pool", () => {
    const diagnostic = resolveAccountDiagnostic(account({ isHidden: true, balancePoolEnabled: true }), settings, "zh");

    expect(diagnostic.title).toBe("账号可用，但未参与无感切号");
    expect(diagnostic.checks).toContainEqual(expect.objectContaining({ label: "无感切号", value: "已隐藏，不参与" }));
    expect(diagnostic.nextStep).toContain("取消隐藏");
  });
});
