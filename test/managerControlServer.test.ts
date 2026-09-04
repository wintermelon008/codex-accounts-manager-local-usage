import { afterEach, describe, expect, it } from "vitest";
import {
  ManagerControlServer,
  type ManagerControlImportStatus,
  type ManagerControlRefreshSummary
} from "../src/integrations/managerControlServer";
import type { CodexExecProviderConfig, RuntimeAccountSwitchOutcome } from "../src/codex";
import type { SharedCodexAccountJson } from "../src/core/types";

const servers: ManagerControlServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.dispose();
  }
});

describe("ManagerControlServer", () => {
  it("requires the bearer token and returns sanitized account and usage views", async () => {
    const server = createServer();
    const address = await server.start(0, "control-secret");
    servers.push(server);

    const unauthorized = await fetch(`http://${address.host}:${address.port}/api/manager/status`);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`http://${address.host}:${address.port}/api/manager/status`, {
      headers: { authorization: "Bearer control-secret" }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      accounts: { counts: { total: number; poolEligible: number }; accounts: Array<Record<string, unknown>> };
      usageToday: { date: string; total: { totalTokens: number }; byModel: Array<{ model: string }> };
    };

    expect(body.accounts.counts).toMatchObject({ total: 2, poolEligible: 1 });
    expect(body.accounts.accounts[0]).not.toHaveProperty("rawData");
    expect(body.usageToday).toMatchObject({ date: "2026-08-18", total: { totalTokens: 42 } });
    expect(body.usageToday.byModel).toMatchObject([{ date: "2026-08-18", model: "gpt-test", totalTokens: 42 }]);
  });

  it("creates a refresh job and exposes redacted import status", async () => {
    const refreshed: string[][] = [];
    const server = createServer({
      refreshQuotas: async (accountIds) => {
        refreshed.push([...(accountIds ?? [])]);
        return {
          total: accountIds?.length ?? 2,
          succeeded: accountIds?.length ?? 2,
          failed: 0,
          unknownAccountIds: [],
          failedAccountIds: []
        } satisfies ManagerControlRefreshSummary;
      }
    });
    const address = await server.start(0, "control-secret");
    servers.push(server);
    const baseUrl = `http://${address.host}:${address.port}`;

    const refreshResponse = await fetch(`${baseUrl}/api/manager/quotas/refresh`, {
      method: "POST",
      headers: {
        authorization: "Bearer control-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ accountIds: ["account-1"] })
    });
    expect(refreshResponse.status).toBe(202);
    const job = (await refreshResponse.json()) as { id: string; type: string };
    expect(job.type).toBe("quota_refresh");

    await new Promise((resolve) => setTimeout(resolve, 0));
    const jobResponse = await fetch(`${baseUrl}/api/manager/jobs/${job.id}`, {
      headers: { authorization: "Bearer control-secret" }
    });
    expect(jobResponse.status).toBe(200);
    expect((await jobResponse.json()) as { state: string }).toMatchObject({ state: "completed" });
    expect(refreshed).toEqual([["account-1"]]);

    const importResponse = await fetch(`${baseUrl}/api/manager/imports/11111111-1111-4111-8111-111111111111`, {
      headers: { authorization: "Bearer control-secret" }
    });
    expect(importResponse.status).toBe(200);
    expect(await importResponse.json()).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      state: "completed",
      total: 1,
      imported: 1,
      poolEnabled: 1
    });
  });

  it("accepts canonical OAuth accounts only through the private import queue", async () => {
    const queued: unknown[] = [];
    const server = createServer({
      enqueueImport: async (accounts) => {
        queued.push(accounts);
        return { id: "22222222-2222-4222-8222-222222222222", accountCount: accounts.length };
      }
    });
    const address = await server.start(0, "control-secret");
    servers.push(server);
    const baseUrl = `http://${address.host}:${address.port}`;
    const account = {
      email: "paid@example.com",
      tokens: { id_token: "id-token", access_token: "access-token", refresh_token: "refresh-token" },
      raw_data: { access_token: "should-be-dropped" }
    };

    const response = await fetch(`${baseUrl}/api/manager/imports`, {
      method: "POST",
      headers: { authorization: "Bearer control-secret", "content-type": "application/json" },
      body: JSON.stringify({ accounts: [account] })
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      state: "queued",
      total: 1
    });
    expect(queued).toEqual([
      [
        {
          email: "paid@example.com",
          auth_mode: "oauth",
          tokens: { id_token: "id-token", access_token: "access-token", refresh_token: "refresh-token" }
        }
      ]
    ]);
  });

  it("routes an external account switch through the configured callback", async () => {
    const switches: Array<{ accountId: string; force?: boolean }> = [];
    const server = createServer({
      switchAccount: async (accountId, options) => {
        switches.push({ accountId, force: options?.force });
        return {
          status: "switched",
          accountId,
          email: "two@example.com",
          activeTurns: 0,
          interruptedTurns: options?.force ? 2 : 0,
          continuedThreads: options?.force ? 2 : 0
        } satisfies RuntimeAccountSwitchOutcome;
      }
    });
    const address = await server.start(0, "control-secret");
    servers.push(server);

    const response = await fetch(`http://${address.host}:${address.port}/api/manager/accounts/switch`, {
      method: "POST",
      headers: { authorization: "Bearer control-secret", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "account-2", force: true })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "switched", accountId: "account-2", continuedThreads: 2 });
    expect(switches).toEqual([{ accountId: "account-2", force: true }]);
  });

  it("returns ephemeral Codex adapter details to the same-host Gateway", async () => {
    const provider = {
      baseUrl: "http://127.0.0.1:39001/v1",
      token: "ephemeral-adapter-token",
      model: "gpt-test",
      route: "chatgpt" as const,
      ready: true,
      instanceId: "runtime-instance"
    } satisfies CodexExecProviderConfig;
    const server = createServer({ getCodexExecProviderConfig: async () => provider });
    const address = await server.start(0, "control-secret");
    servers.push(server);

    const response = await fetch(`http://${address.host}:${address.port}/api/manager/codex/provider-config`, {
      headers: { authorization: "Bearer control-secret" }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(provider);
  });
});

function createServer(
  overrides: {
    refreshQuotas?: (accountIds?: readonly string[]) => Promise<ManagerControlRefreshSummary>;
    enqueueImport?: (accounts: readonly SharedCodexAccountJson[]) => Promise<{ id: string; accountCount: number }>;
    switchAccount?: (
      accountId: string,
      options?: { force?: boolean; gracePeriodMs?: number; longTurnPolicy?: "defer" | "interrupt" | "interruptAndContinue" }
    ) => Promise<RuntimeAccountSwitchOutcome>;
    getCodexExecProviderConfig?: () => Promise<CodexExecProviderConfig>;
  } = {}
): ManagerControlServer {
  const usage = {
    async getSnapshots() {
      return {
        localUsage: {
          status: "ready" as const,
          isRefreshing: false,
          periodDays: 1,
          timeZone: "Asia/Shanghai",
          calculatedAt: Date.now(),
          nextRefreshAt: Date.now() + 900_000,
          sourceFileCount: 1,
          eventCount: 1,
          total: { inputTokens: 42, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 42 },
          by3Hour: [],
          by3HourAndModel: [],
          byDay: [
            {
              date: "2026-08-18",
              eventCount: 1,
              inputTokens: 42,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 42
            }
          ],
          byModel: [
            {
              model: "gpt-test",
              inputTokens: 42,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 42
            }
          ],
          byDayAndModel: [
            {
              date: "2026-08-18",
              model: "gpt-test",
              inputTokens: 42,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 42
            }
          ]
        },
        accountTokenUsage: { status: "unavailable" as const, isRefreshing: false, windowsByAccount: {} }
      };
    }
  };
  const importStatus: ManagerControlImportStatus = {
    id: "11111111-1111-4111-8111-111111111111",
    state: "completed",
    total: 1,
    imported: 1,
    poolEnabled: 1
  };
  return new ManagerControlServer({
    repo: {
      async listAccounts() {
        return [
          {
            id: "account-1",
            email: "one@example.com",
            accountKind: "chatgpt",
            isActive: true,
            isHidden: false,
            balancePoolEnabled: true,
            lastQuotaAt: Date.now(),
            quotaSummary: {
              hourlyPercentage: 90,
              hourlyWindowPresent: true,
              hourlyWindowMinutes: 300,
              weeklyPercentage: 80,
              weeklyWindowPresent: true,
              weeklyWindowMinutes: 10080,
              codeReviewPercentage: 100
            },
            createdAt: Date.now(),
            updatedAt: Date.now()
          },
          {
            id: "account-2",
            email: "two@example.com",
            accountKind: "chatgpt",
            isActive: false,
            isHidden: true,
            balancePoolEnabled: false,
            quotaError: { code: "unauthorized", message: "401", timestamp: Date.now() },
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ] as never;
      }
    },
    usage,
    now: () => Date.parse("2026-08-18T12:00:00.000Z"),
    refreshQuotas:
      overrides.refreshQuotas ??
      (async () => ({
        total: 2,
        succeeded: 2,
        failed: 0,
        unknownAccountIds: [],
        failedAccountIds: []
      })),
    enqueueImport:
      overrides.enqueueImport ??
      (async (accounts) => ({ id: "22222222-2222-4222-8222-222222222222", accountCount: accounts.length })),
    getImportStatus: async () => importStatus,
    switchAccount: overrides.switchAccount,
    getCodexExecProviderConfig: overrides.getCodexExecProviderConfig
  });
}
