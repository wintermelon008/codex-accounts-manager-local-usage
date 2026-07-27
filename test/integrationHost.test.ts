import { describe, expect, it, vi } from "vitest";
import { ManagerIntegrationHost } from "../src/integrations";

describe("ManagerIntegrationHost", () => {
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
