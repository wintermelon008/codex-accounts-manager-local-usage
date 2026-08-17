import { describe, expect, it, vi } from "vitest";
import { ManagerIntegrationHost } from "../src/integrations";

describe("ManagerIntegrationHost", () => {
  it("exposes the optional sanitized account directory and direct OAuth handoff", async () => {
    const gateway = createGateway();
    const getManagedAccountEmails = vi.fn(async () => ["linked@example.com"] as const);
    const startOAuthAccountImport = vi.fn(async (options: { expectedEmail?: string } = {}) => ({
      accountId: "account-1",
      email: options.expectedEmail ?? "linked@example.com",
      quotaRefreshed: true
    }));
    const cancelOAuthAccountImport = vi.fn();
    const importSharedAccountsToBalancePool = vi.fn(async () => ({
      status: "completed" as const,
      total: 1,
      imported: 1,
      poolEnabled: 1,
      refreshFailed: 0,
      notEligible: 0,
      authFailed: 0,
      importFailed: 0
    }));
    const host = new ManagerIntegrationHost(gateway.operations, undefined, {
      getManagedAccountEmails,
      startOAuthAccountImport,
      cancelOAuthAccountImport,
      importSharedAccountsToBalancePool
    });

    await expect(host.api.getManagedAccountEmails?.()).resolves.toEqual(["linked@example.com"]);
    await expect(host.api.startOAuthAccountImport?.({ expectedEmail: "mailbox@example.com" })).resolves.toMatchObject({
      accountId: "account-1",
      email: "mailbox@example.com"
    });
    expect(getManagedAccountEmails).toHaveBeenCalledOnce();
    expect(startOAuthAccountImport).toHaveBeenCalledWith({ expectedEmail: "mailbox@example.com" });
    host.api.cancelOAuthAccountImport?.("mailbox-operation-1");
    expect(cancelOAuthAccountImport).toHaveBeenCalledWith("mailbox-operation-1");
    await expect(
      host.api.importSharedAccountsToBalancePool?.({
        account_id: "account-1",
        tokens: { id_token: "id-token", access_token: "access-token" }
      })
    ).resolves.toMatchObject({ status: "completed", poolEnabled: 1 });
    expect(importSharedAccountsToBalancePool).toHaveBeenCalledWith({
      account_id: "account-1",
      tokens: { id_token: "id-token", access_token: "access-token" }
    });
    host.dispose();
  });

  it("exposes only registered Dashboard cards and declared actions", async () => {
    const gateway = createGateway();
    const host = new ManagerIntegrationHost(gateway.operations);
    const runAction = vi.fn();
    const onDidChange = vi.fn((listener: () => void) => ({ dispose: vi.fn(() => listener()) }));

    const registration = host.api.registerDashboardIntegration({
      id: "example.card",
      getViewModel: () => ({
        id: "example.card",
        title: "Example card",
        status: "ready",
        actions: [
          { id: "refresh", label: "Refresh" },
          { id: "disabled", label: "Disabled", enabled: false }
        ]
      }),
      runAction,
      onDidChange
    });

    expect(host.getDashboardIntegrations()).toEqual([
      expect.objectContaining({ id: "example.card", title: "Example card", status: "ready" })
    ]);
    await host.runDashboardAction("example.card", "refresh");
    expect(runAction).toHaveBeenCalledWith("refresh");
    await expect(host.runDashboardAction("example.card", "disabled")).rejects.toThrow("unavailable");
    await expect(host.runDashboardAction("missing.card", "refresh")).rejects.toThrow("unavailable");

    registration.dispose();
    expect(host.getDashboardIntegrations()).toEqual([]);
    host.dispose();
  });

  it("contains an invalid integration view instead of exposing it to the Dashboard", () => {
    const gateway = createGateway();
    const host = new ManagerIntegrationHost(gateway.operations);
    host.api.registerDashboardIntegration({
      id: "example.broken",
      getViewModel: () => ({ id: "wrong.id" }) as never,
      runAction: vi.fn()
    });

    expect(host.getDashboardIntegrations()).toEqual([
      expect.objectContaining({
        id: "example.broken",
        status: "error",
        actions: []
      })
    ]);
    host.dispose();
  });

  it("gives exactly one integration ownership of the local Gateway runtime", async () => {
    const gateway = createGateway();
    const host = new ManagerIntegrationHost(gateway.operations);
    const first = host.api.registerGateway("example.first");
    const second = host.api.registerGateway("example.second");

    await first.activate({ displayName: "Example", baseUrl: "https://gateway.invalid", model: "example" });
    expect(first.isConfigured()).toBe(true);
    expect(first.isActive()).toBe(true);
    await expect(
      second.activate({ displayName: "Other", baseUrl: "https://other.invalid", model: "other" })
    ).rejects.toThrow("already owns");

    await first.fallbackToChatGpt();
    expect(first.isActive()).toBe(false);
    first.dispose();
    await expect(
      second.activate({ displayName: "Other", baseUrl: "https://other.invalid", model: "other" })
    ).resolves.toMatchObject({ configured: true });
    expect(gateway.deactivate).toHaveBeenCalled();

    second.dispose();
    host.dispose();
  });

  it("reserves the Gateway before an asynchronous activation completes", async () => {
    const gateway = createGateway();
    let completeActivation:
      | ((value: { enabled: boolean; configured: boolean; requiresReload: boolean }) => void)
      | undefined;
    gateway.operations.activate = vi.fn(
      () =>
        new Promise((resolve) => {
          completeActivation = resolve;
        })
    );
    const host = new ManagerIntegrationHost(gateway.operations);
    const first = host.api.registerGateway("example.first");
    const second = host.api.registerGateway("example.second");

    const activation = first.activate({ displayName: "Example", baseUrl: "https://gateway.invalid", model: "example" });
    await expect(
      second.activate({ displayName: "Other", baseUrl: "https://other.invalid", model: "other" })
    ).rejects.toThrow("transition");
    completeActivation?.({ enabled: true, configured: true, requiresReload: false });
    await activation;

    first.dispose();
    second.dispose();
    host.dispose();
  });

  it("registers and manually switches an opaque virtual provider account", async () => {
    const gateway = createGateway();
    const virtual = {
      upsert: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
      deactivate: vi.fn(async () => undefined)
    };
    const host = new ManagerIntegrationHost(gateway.operations, virtual);
    const activate = vi.fn(async () => ({ enabled: true, configured: true, requiresReload: false }));
    const runCardAction = vi.fn(async () => undefined);
    const setEnabled = vi.fn(async () => undefined);
    let visible = true;
    await host.api.registerVirtualAccount({
      id: "sub2api-gateway",
      displayName: "Sub2API Gateway",
      descriptor: {
        integrationId: "sub2api-gateway",
        baseUrl: "https://gateway.invalid/v1",
        model: "gpt-5",
        credentialRef: "primary"
      },
      activate,
      getCardView: () => ({
        integrationId: "sub2api-gateway",
        details: [{ label: "下游", value: "https://gateway.invalid/v1" }],
        actions: [{ id: "refresh", label: "刷新" }]
      }),
      runCardAction,
      setting: {
        id: "sub2api-gateway-card-visible",
        title: "显示 Sub2API 账号卡片",
        getEnabled: () => visible,
        setEnabled: vi.fn(async (enabled: boolean) => {
          visible = enabled;
          await setEnabled(enabled);
        })
      }
    });

    expect(host.getVirtualAccountCards()).toEqual([
      expect.objectContaining({
        accountId: "virtual:sub2api-gateway",
        card: expect.objectContaining({ integrationId: "sub2api-gateway" })
      })
    ]);
    expect(host.getIntegrationSettings()).toEqual([
      expect.objectContaining({ id: "sub2api-gateway-card-visible", enabled: true })
    ]);
    await host.runVirtualAccountAction("virtual:sub2api-gateway", "refresh");
    await host.updateIntegrationSetting("sub2api-gateway-card-visible", false);
    expect(runCardAction).toHaveBeenCalledWith("refresh");
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(host.getVirtualAccountCards()).toEqual([]);
    expect(host.getVisibleVirtualAccountIds()).not.toContain("virtual:sub2api-gateway");

    await expect(host.switchVirtualAccount("virtual:sub2api-gateway")).resolves.toMatchObject({
      status: "switched",
      accountId: "virtual:sub2api-gateway"
    });
    expect(virtual.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "sub2api-gateway", credentialRef: "primary" }),
      "Sub2API Gateway"
    );
    expect(virtual.activate).toHaveBeenCalledWith("virtual:sub2api-gateway");
    expect(activate).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("updates provider card visibility without changing the provider route", async () => {
    const gateway = createGateway();
    const virtual = {
      upsert: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
      deactivate: vi.fn(async () => undefined)
    };
    const host = new ManagerIntegrationHost(gateway.operations, virtual);
    const setEnabled = vi.fn(async () => undefined);
    let visible = false;
    await host.api.registerVirtualAccount({
      id: "sub2api-gateway",
      displayName: "Sub2API Gateway",
      descriptor: {
        integrationId: "sub2api-gateway",
        baseUrl: "https://gateway.invalid/v1",
        model: "gpt-5",
        credentialRef: "primary"
      },
      activate: vi.fn(async () => ({ enabled: true, configured: true, requiresReload: false })),
      setting: {
        id: "sub2api-gateway-card-visible",
        title: "显示 Sub2API 账号卡片",
        getEnabled: () => visible,
        setEnabled: vi.fn(async (enabled: boolean) => {
          visible = enabled;
          await setEnabled(enabled);
        })
      }
    });

    await host.updateIntegrationSetting("sub2api-gateway-card-visible", true);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(gateway.operations.activate).not.toHaveBeenCalled();
    expect(virtual.activate).not.toHaveBeenCalled();
    expect(host.getVisibleVirtualAccountIds()).toContain("virtual:sub2api-gateway");
    host.dispose();
  });

  it("does not mark a virtual provider active before a required runtime reload", async () => {
    const gateway = createGateway();
    gateway.operations.activate = vi.fn(async () => {
      return { enabled: true, configured: false, requiresReload: true };
    });
    const virtual = {
      upsert: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
      deactivate: vi.fn(async () => undefined)
    };
    const host = new ManagerIntegrationHost(gateway.operations, virtual);
    await host.api.registerVirtualAccount({
      id: "sub2api-gateway",
      displayName: "Sub2API Gateway",
      descriptor: {
        integrationId: "sub2api-gateway",
        baseUrl: "https://gateway.invalid/v1",
        model: "gpt-5",
        credentialRef: "primary"
      },
      activate: vi.fn(async () => ({ enabled: true, configured: true, requiresReload: false }))
    });
    const lease = host.api.registerGateway("sub2api-gateway");

    await expect(
      lease.activate({ displayName: "Gateway", baseUrl: "https://gateway.invalid/v1", model: "gpt-5" })
    ).resolves.toMatchObject({ requiresReload: true });

    expect(lease.isActive()).toBe(false);
    expect(virtual.activate).not.toHaveBeenCalled();
    expect(virtual.deactivate).toHaveBeenCalledOnce();
    host.dispose();
  });
});

function createGateway() {
  let active = false;
  let configured = false;
  const deactivate = vi.fn(async () => {
    active = false;
    configured = false;
    return { enabled: true, configured: false, requiresReload: false };
  });
  return {
    deactivate,
    operations: {
      isActive: () => active,
      isConfigured: () => configured,
      activate: vi.fn(async () => {
        active = true;
        configured = true;
        return { enabled: true, configured: true, requiresReload: false };
      }),
      deactivate,
      configureCredential: vi.fn(async () => ({
        active,
        ready: true,
        requestCount: 0,
        successfulRequestCount: 0,
        failedRequestCount: 0
      })),
      getStatus: vi.fn(async () => ({
        active,
        ready: configured,
        requestCount: 0,
        successfulRequestCount: 0,
        failedRequestCount: 0
      })),
      fallbackToChatGpt: vi.fn(async () => {
        active = false;
        return {
          status: "switched" as const,
          accountId: "account-1",
          email: "account@example.invalid",
          activeTurns: 0,
          interruptedTurns: 0,
          continuedThreads: 0
        };
      })
    }
  };
}
