import { describe, expect, it, vi } from "vitest";
import { getAutomaticQuotaRefreshAccountIds } from "../src/presentation/workbench/schedulerRegistration";
import { selectBalanceCandidate } from "../src/application/accounts/balanceScheduler";
import { selectGatewayFallbackCandidates } from "../src/application/accounts/gatewayFallbackSelection";
import { refreshSingleQuota } from "../src/application/accounts/quota";
import { buildDashboardState } from "../src/application/dashboard/buildDashboardState";
import type { CodexAccountRecord, CodexQuotaSummary } from "../src/core/types";

const quota: CodexQuotaSummary = {
  hourlyPercentage: 95,
  hourlyWindowPresent: true,
  hourlyWindowMinutes: 300,
  weeklyPercentage: 95,
  weeklyWindowPresent: true,
  weeklyWindowMinutes: 10_080
};

function chatgpt(id: string): CodexAccountRecord {
  return {
    id,
    email: `${id}@example.invalid`,
    accountKind: "chatgpt",
    quotaMode: "chatgpt",
    balancePoolEnabled: true,
    quotaSummary: structuredClone(quota),
    lastQuotaAt: Date.now(),
    createdAt: 1,
    updatedAt: 1
  };
}

function virtual(): CodexAccountRecord {
  return {
    id: "virtual:sub2api-gateway",
    email: "Sub2API Gateway",
    accountKind: "sub2api",
    manualOnly: true,
    quotaMode: "none",
    virtualRoute: {
      integrationId: "sub2api-gateway",
      baseUrl: "https://gateway.example.invalid/v1",
      model: "gpt-5",
      credentialRef: "primary"
    },
    balancePoolEnabled: false,
    quotaSummary: structuredClone(quota),
    createdAt: 1,
    updatedAt: 1
  };
}

describe("Sub2API virtual account boundaries", () => {
  it("excludes virtual accounts from every automatic candidate list", () => {
    const active = chatgpt("active");
    active.isActive = true;
    active.quotaSummary!.hourlyPercentage = 40;
    const provider = virtual();
    const accounts = [active, provider, chatgpt("target")];
    const config = { get: <T>(_key: string, defaultValue?: T) => defaultValue as T };

    expect(
      selectBalanceCandidate({
        accounts,
        activeAccountId: active.id,
        activeBand: 1,
        lastSelectedAt: {},
        now: Date.now()
      })?.id
    ).toBe("target");
    expect(selectGatewayFallbackCandidates(accounts, config).map((account) => account.id)).not.toContain(provider.id);
    expect(getAutomaticQuotaRefreshAccountIds(accounts, config as never)).toEqual(["active", "target"]);
  });

  it("does not read OAuth tokens or refresh quota for a virtual account", async () => {
    const account = virtual();
    const getTokens = vi.fn();
    const repo = {
      getAccount: vi.fn(async () => account),
      getTokens,
      updateQuota: vi.fn()
    } as never;

    await refreshSingleQuota(repo, { refresh() {} }, account.id);
    expect(getTokens).not.toHaveBeenCalled();
  });

  it("renders a virtual account without quota, subscription, or token-health details", async () => {
    const account = virtual();
    const getTokens = vi.fn(async () => undefined);
    account.providerActive = true;
    account.subscriptionActiveUntil = "2099-01-01T00:00:00.000Z";
    account.quotaError = { code: "quota", message: "should not render", timestamp: 1 };
    const state = await buildDashboardState(
      {
        listAccounts: vi.fn(async () => [account]),
        getTokens,
        getIndexHealthSummary: vi.fn(async () => ({ status: "healthy", availableBackups: 0 }))
      } as never,
      {
        resolveLanguage: () => "zh",
        getDashboardSettings: () => ({ codexAppPath: "" })
      } as never,
      "",
      { announcements: [], unreadIds: [] }
    );

    const rendered = state.accounts[0]!;
    expect(getTokens).not.toHaveBeenCalled();
    expect(rendered.displayName).toBe("Sub2API Gateway");
    expect(rendered.metrics).toEqual([]);
    expect(rendered.creditsText).toBeUndefined();
    expect(rendered.subscriptionText).toBe("");
    expect(rendered.quotaIssueKind).toBeUndefined();
    expect(rendered.lastTokenRefreshAt).toBeUndefined();
    expect(rendered.statusColor).toBe("var(--accent-blue)");
  });

  it("carries provider-owned usage and card actions without OAuth fields", async () => {
    const account = virtual();
    const state = await buildDashboardState(
      {
        listAccounts: vi.fn(async () => [account]),
        getTokens: vi.fn(async () => {
          throw new Error("virtual OAuth token lookup must not run");
        }),
        getIndexHealthSummary: vi.fn(async () => ({ status: "healthy", availableBackups: 0 }))
      } as never,
      {
        resolveLanguage: () => "zh",
        getDashboardSettings: () => ({ codexAppPath: "" })
      } as never,
      "",
      { announcements: [], unreadIds: [] }
    );

    expect(state.accounts[0]?.providerCard).toBeUndefined();
    expect(state.integrationSettings).toBeUndefined();
  });
});
