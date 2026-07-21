import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { DashboardActionContext } from "../src/presentation/dashboard/actionHandlers";

const { consumeResetCreditMock } = vi.hoisted(() => ({
  consumeResetCreditMock: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../src/services/quota", async () => {
  const actual = await vi.importActual<typeof import("../src/services/quota")>("../src/services/quota");
  return {
    ...actual,
    consumeResetCredit: consumeResetCreditMock
  };
});

import { executeDashboardActionMessage } from "../src/presentation/dashboard/actionHandlers";

describe("executeDashboardActionMessage", () => {
  it("forces a panel state publish for refreshView", async () => {
    const publishState = vi.fn().mockResolvedValue(undefined);
    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo: {} as DashboardActionContext["repo"],
        resolveLanguage: () => "en",
        schedulePublishState: vi.fn(),
        publishState,
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({
          version: "0.1.15",
          locale: "en"
        })
      },
      {
        type: "dashboard:action",
        action: "refreshView",
        requestId: "req-1"
      }
    );

    expect(publishState).toHaveBeenCalledWith(true);
    expect(result.status).toBe("completed");
  });

  it("waits for quota refresh after consuming a reset credit", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Reset Rate Limit" as never);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
    const executeCommandMock = vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const repo = {
      getAccount: vi.fn(async () => ({
        id: "account-1",
        email: "dev@example.com",
        accountId: "acct-1",
        quotaSummary: {
          resetCreditsAvailable: 1
        }
      })),
      getTokens: vi.fn(async () => ({
        accessToken: "access-token"
      }))
    } as unknown as DashboardActionContext["repo"];

    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo,
        resolveLanguage: () => "en",
        schedulePublishState: vi.fn(),
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({
          version: "0.1.15",
          locale: "en"
        })
      },
      {
        type: "dashboard:action",
        action: "consumeResetCredit",
        requestId: "req-2",
        accountId: "account-1"
      }
    );

    expect(executeCommandMock).toHaveBeenCalledWith(
      "codexAccounts.refreshQuota",
      expect.objectContaining({ id: "account-1" })
    );
    expect(result.status).toBe("completed");
  });

  it("removes any selected accounts from the seamless-switch pool", async () => {
    const removeFromBalancePool = vi.fn().mockResolvedValue([]);
    const schedulePublishState = vi.fn();
    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo: { removeFromBalancePool } as unknown as DashboardActionContext["repo"],
        resolveLanguage: () => "zh",
        schedulePublishState,
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({ version: "0.1.16", locale: "zh" })
      },
      {
        type: "dashboard:action",
        action: "removeFromBalancePool",
        requestId: "req-remove-pool",
        payload: { accountIds: ["account-1"] }
      }
    );

    expect(removeFromBalancePool).toHaveBeenCalledWith(["account-1"]);
    expect(schedulePublishState).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
  });

  it("toggles one saved account's seamless-switch pool membership", async () => {
    const setBalancePoolMembership = vi.fn().mockResolvedValue(undefined);
    const schedulePublishState = vi.fn();
    const account = {
      id: "account-1",
      email: "dev@example.com",
      isActive: false,
      balancePoolEnabled: false,
      createdAt: 1,
      updatedAt: 1
    };
    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo: {
          getAccount: vi.fn().mockResolvedValue(account),
          setBalancePoolMembership
        } as unknown as DashboardActionContext["repo"],
        resolveLanguage: () => "zh",
        schedulePublishState,
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({ version: "0.1.16", locale: "zh" })
      },
      {
        type: "dashboard:action",
        action: "toggleBalancePool" as never,
        requestId: "req-toggle-pool",
        accountId: account.id
      }
    );

    expect(setBalancePoolMembership).toHaveBeenCalledWith(account.id, true);
    expect(schedulePublishState).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
  });

  it("hides selected accounts and resets the seamless-switch runtime state", async () => {
    const hideAccounts = vi.fn().mockResolvedValue([]);
    const schedulePublishState = vi.fn();
    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo: { hideAccounts } as unknown as DashboardActionContext["repo"],
        resolveLanguage: () => "zh",
        schedulePublishState,
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({ version: "0.1.16", locale: "zh" })
      },
      {
        type: "dashboard:action",
        action: "hideAccounts",
        requestId: "req-hide-accounts",
        payload: { accountIds: ["account-1", "account-2"] }
      }
    );

    expect(hideAccounts).toHaveBeenCalledWith(["account-1", "account-2"]);
    expect(schedulePublishState).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
    expect(result.payload).toEqual({ affectedAccountIds: ["account-1", "account-2"] });
  });

  it("unhides selected accounts and restores their seamless-switch pool membership", async () => {
    const unhideAccounts = vi.fn().mockResolvedValue([]);
    const schedulePublishState = vi.fn();
    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo: { unhideAccounts } as unknown as DashboardActionContext["repo"],
        resolveLanguage: () => "en",
        schedulePublishState,
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({ version: "0.1.16", locale: "en" })
      },
      {
        type: "dashboard:action",
        action: "unhideAccounts",
        requestId: "req-unhide-accounts",
        payload: { accountIds: ["account-1"] }
      }
    );

    expect(unhideAccounts).toHaveBeenCalledWith(["account-1"]);
    expect(schedulePublishState).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
  });

  it("sets a selected account group and resets seamless scheduling", async () => {
    const setAccountGroup = vi.fn().mockResolvedValue([]);
    const schedulePublishState = vi.fn();
    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo: { setAccountGroup } as unknown as DashboardActionContext["repo"],
        resolveLanguage: () => "zh",
        schedulePublishState,
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({ version: "0.1.16", locale: "zh" })
      },
      {
        type: "dashboard:action",
        action: "setAccountGroup",
        requestId: "req-set-group",
        payload: { accountIds: ["account-1", "account-2"], accountGroup: "C" }
      }
    );

    expect(setAccountGroup).toHaveBeenCalledWith(["account-1", "account-2"], "C");
    expect(schedulePublishState).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
  });

  it("passes the Dashboard-visible account ids to one-click quota refresh", async () => {
    const executeCommandMock = vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo: {} as DashboardActionContext["repo"],
        resolveLanguage: () => "en",
        schedulePublishState: vi.fn(),
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({ version: "0.1.16", locale: "en" })
      },
      {
        type: "dashboard:action",
        action: "refreshAll",
        requestId: "req-visible-refresh",
        payload: { accountIds: ["visible-account"] }
      }
    );

    expect(executeCommandMock).toHaveBeenCalledWith("codexAccounts.refreshAllQuotas", {
      accountIds: ["visible-account"]
    });
    expect(result.status).toBe("completed");
  });
});
