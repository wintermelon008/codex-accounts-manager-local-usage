import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sub2ApiGatewayController } from "../src/local/sub2apiGateway/controller";

describe("Sub2API Gateway controller", () => {
  let storagePath: string;
  let secrets: Map<string, string>;
  let state: Map<string, unknown>;

  beforeEach(async () => {
    storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-sub2api-gateway-controller-"));
    secrets = new Map();
    state = new Map();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback: unknown) => (key === "sub2apiGatewayConfigFile" ? "gateway.json" : fallback))
    } as never);
    vi.mocked(vscode.window.showInformationMessage).mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(storagePath, { recursive: true, force: true });
  });

  it("creates the template only after the enabled controller initializes and never puts the key in global state", async () => {
    const runtime = {
      isSub2ApiGatewayActive: vi.fn(() => false)
    };
    const controller = new Sub2ApiGatewayController(createContext(storagePath, secrets, state), runtime as never);

    await controller.initialize();

    expect(controller.getViewModel()).toMatchObject({
      configFile: "gateway.json",
      status: "credential_required",
      credentialPresent: false,
      usage: { requestCount: 0 }
    });
    const configText = await fs.readFile(path.join(storagePath, "gateway.json"), "utf8");
    expect(configText).not.toMatch(/api[_-]?key/i);
    expect([...state.values()].join("\n")).not.toContain("secret-key");
  });

  it("injects a SecretStorage credential only after the Gateway runtime is active", async () => {
    const usageDay = currentUsageDay();
    const configureSub2ApiGatewayCredential = vi.fn().mockResolvedValue({
      active: true,
      ready: true,
      instanceId: "runtime-1",
      requestCount: 4,
      successfulRequestCount: 3,
      failedRequestCount: 1,
      usageDay,
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 3,
      reasoningTokens: 2,
      totalTokens: 18
    });
    const getSub2ApiGatewayStatus = vi.fn().mockResolvedValue({
      active: true,
      ready: true,
      instanceId: "runtime-1",
      requestCount: 4,
      successfulRequestCount: 3,
      failedRequestCount: 1,
      usageDay,
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 3,
      reasoningTokens: 2,
      totalTokens: 18
    });
    const runtime = {
      isSub2ApiGatewayActive: vi.fn(() => true),
      configureSub2ApiGatewayCredential,
      getSub2ApiGatewayStatus
    };
    secrets.set("codex.sub2api.gateway.primary", "secret-key");
    const controller = new Sub2ApiGatewayController(createContext(storagePath, secrets, state), runtime as never);

    await controller.initialize();

    expect(configureSub2ApiGatewayCredential).toHaveBeenCalledWith("secret-key");
    expect(controller.getViewModel()).toMatchObject({
      isActive: true,
      credentialPresent: true,
      status: "active",
      usage: {
        requestCount: 4,
        successfulRequestCount: 3,
        failedRequestCount: 1,
        today: { date: usageDay, totalTokens: 18, inputTokens: 11, outputTokens: 7 },
        windows: { fiveHour: { totalTokens: 18 }, sevenDay: { totalTokens: 18 } }
      }
    });
    expect(JSON.stringify([...state.entries()])).not.toContain("secret-key");
  });

  it("requests the configured ChatGPT fallback once after a semantic quota-exhaustion status", async () => {
    await fs.writeFile(
      path.join(storagePath, "gateway.json"),
      JSON.stringify({
        schema: "codex-accounts-sub2api-gateway/v1",
        displayName: "Sub2API Gateway",
        sub2api: {
          baseUrl: "http://127.0.0.1:65432/v1",
          model: "gpt-5.5",
          credentialRef: "primary"
        },
        autoFallbackToChatGpt: true
      }),
      "utf8"
    );
    const usageDay = currentUsageDay();
    const statusBeforeFallback = {
      active: true,
      ready: true,
      route: "sub2api" as const,
      autoFallbackToChatGpt: true,
      quotaExhaustionCount: 1,
      instanceId: "runtime-1",
      requestCount: 1,
      successfulRequestCount: 0,
      failedRequestCount: 1,
      usageDay,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    };
    const statusAfterFallback = {
      ...statusBeforeFallback,
      active: false,
      route: "chatgpt" as const
    };
    const getSub2ApiGatewayStatus = vi
      .fn()
      .mockResolvedValueOnce(statusBeforeFallback)
      .mockResolvedValueOnce(statusAfterFallback);
    const fallback = vi.fn().mockResolvedValue({
      status: "switched",
      accountId: "workspace-b",
      email: "b@example.invalid",
      activeTurns: 0,
      interruptedTurns: 0,
      continuedThreads: 0
    });
    const runtime = {
      isSub2ApiGatewayActive: vi.fn(() => true),
      isSub2ApiGatewayConfigured: vi.fn(() => true),
      configureSub2ApiGatewayCredential: vi.fn().mockResolvedValue(statusBeforeFallback),
      getSub2ApiGatewayStatus
    };
    secrets.set("codex.sub2api.gateway.primary", "secret-key");
    const controller = new Sub2ApiGatewayController(
      createContext(storagePath, secrets, state),
      runtime as never,
      () => undefined,
      fallback
    );

    await controller.initialize();

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(controller.getViewModel()).toMatchObject({
      isActive: true,
      status: "ready",
      statusMessage: "Sub2API quota exhaustion confirmed; ChatGPT Auth fallback is active"
    });
    controller.dispose();
  });

  it("uses bounded exponential backoff after a failed ChatGPT fallback", async () => {
    const startedAt = Date.parse("2026-07-23T00:00:00.000Z");
    let now = startedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await fs.writeFile(
      path.join(storagePath, "gateway.json"),
      JSON.stringify({
        schema: "codex-accounts-sub2api-gateway/v1",
        displayName: "Sub2API Gateway",
        sub2api: {
          baseUrl: "http://127.0.0.1:65432/v1",
          model: "gpt-5.5",
          credentialRef: "primary"
        },
        autoFallbackToChatGpt: true
      }),
      "utf8"
    );
    const status = {
      active: true,
      ready: true,
      route: "sub2api" as const,
      autoFallbackToChatGpt: true,
      quotaExhaustionCount: 1,
      instanceId: "runtime-1",
      requestCount: 1,
      successfulRequestCount: 0,
      failedRequestCount: 1,
      usageDay: currentUsageDay(),
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    };
    const fallback = vi.fn().mockResolvedValue({ status: "failed", message: "no refreshed candidate" });
    const runtime = {
      isSub2ApiGatewayActive: vi.fn(() => true),
      isSub2ApiGatewayConfigured: vi.fn(() => true),
      configureSub2ApiGatewayCredential: vi.fn().mockResolvedValue(status),
      getSub2ApiGatewayStatus: vi.fn().mockResolvedValue(status)
    };
    secrets.set("codex.sub2api.gateway.primary", "secret-key");
    const controller = new Sub2ApiGatewayController(
      createContext(storagePath, secrets, state),
      runtime as never,
      () => undefined,
      fallback
    );

    await controller.initialize();

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(controller.getViewModel().statusMessage).toContain("retrying in 5 seconds (attempt 1)");

    const refreshRuntimeUsage = (controller as unknown as { refreshRuntimeUsage(): Promise<void> }).refreshRuntimeUsage;
    now = startedAt + 4_999;
    await refreshRuntimeUsage.call(controller);
    expect(fallback).toHaveBeenCalledTimes(1);

    now = startedAt + 5_000;
    await refreshRuntimeUsage.call(controller);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(controller.getViewModel().statusMessage).toContain("retrying in 10 seconds (attempt 2)");
    controller.dispose();
  });

  it("retains the sanitized Gateway failure diagnostic after switching back to ChatGPT Auth", async () => {
    let gatewayActive = false;
    const deactivateSub2ApiGateway = vi.fn(async () => {
      gatewayActive = false;
      return { enabled: true, configured: true, requiresReload: false };
    });
    const runtime = {
      isSub2ApiGatewayActive: vi.fn(() => gatewayActive),
      deactivateSub2ApiGateway
    };
    const controller = new Sub2ApiGatewayController(createContext(storagePath, secrets, state), runtime as never);

    await controller.initialize();
    await fs.mkdir(path.join(storagePath, "hot-switch-runtime"), { recursive: true });
    await fs.writeFile(
      path.join(storagePath, "hot-switch-runtime", "sub2api-gateway-last-failure.json"),
      JSON.stringify({
        schema: "codex-accounts-sub2api-gateway-diagnostic/v1",
        recordedAt: Date.now(),
        origin: "adapter",
        statusCode: 502,
        transportCode: "ECONNRESET",
        request: {
          method: "POST",
          path: "/v1/responses",
          contentLength: 123,
          transferEncoding: "chunked",
          authorization: "secret-key",
          body: "must never be surfaced"
        }
      }),
      "utf8"
    );

    gatewayActive = true;
    await controller.deactivate();

    expect(deactivateSub2ApiGateway).toHaveBeenCalledTimes(1);
    expect(controller.getViewModel().usage.lastFailure).toMatchObject({
      origin: "adapter",
      statusCode: 502,
      transportCode: "ECONNRESET",
      requestMethod: "POST",
      requestPath: "/v1/responses",
      contentLength: 123,
      transferEncoding: "chunked"
    });
    expect(JSON.stringify(controller.getViewModel())).not.toContain("secret-key");
    expect(JSON.stringify(controller.getViewModel())).not.toContain("must never be surfaced");
  });

  it("keeps upstream quota observation optional and stores its separate credential only in SecretStorage", async () => {
    await fs.writeFile(
      path.join(storagePath, "gateway.json"),
      JSON.stringify({
        schema: "codex-accounts-sub2api-gateway/v1",
        displayName: "Sub2API Gateway",
        sub2api: {
          baseUrl: "http://127.0.0.1:65432/v1",
          model: "gpt-5.5",
          credentialRef: "primary"
        },
        inventoryObserver: {
          adminBaseUrl: "http://127.0.0.1:65432",
          group: "test",
          credentialRef: "observer",
          refreshSeconds: 300
        }
      }),
      "utf8"
    );
    secrets.set("codex.sub2api.gateway.observer", "admin-observer-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/admin/groups/all") {
          return jsonResponse({ data: [{ id: 1, name: "test" }] });
        }
        if (url.pathname === "/api/v1/admin/accounts") {
          return jsonResponse({ data: [{ id: 2, status: "normal" }] });
        }
        return jsonResponse({
          data: {
            rate_limit: {
              primary_window: { used_percent: 20 },
              secondary_window: { used_percent: 40 }
            }
          }
        });
      })
    );
    const runtime = { isSub2ApiGatewayActive: vi.fn(() => false) };
    const controller = new Sub2ApiGatewayController(createContext(storagePath, secrets, state), runtime as never);

    await controller.initialize();
    await controller.refresh();

    expect(controller.getViewModel().inventory).toMatchObject({
      configured: true,
      credentialPresent: true,
      status: "healthy",
      group: "test",
      fiveHour: { remainingPercent: 80, capacityUnits: 1 },
      weekly: { remainingPercent: 60, capacityUnits: 1 }
    });
    expect(JSON.stringify([...state.entries()])).not.toContain("admin-observer-key");
  });
});

function createContext(storagePath: string, secrets: Map<string, string>, state: Map<string, unknown>) {
  return {
    globalStorageUri: { fsPath: storagePath },
    secrets: {
      get: vi.fn(async (key: string) => secrets.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        secrets.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        secrets.delete(key);
      })
    },
    globalState: {
      get: vi.fn((key: string) => state.get(key)),
      update: vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) {
          state.delete(key);
        } else {
          state.set(key, value);
        }
      })
    }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function currentUsageDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
