import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAuthFile, writeAuthFile } from "../src/codex/authFile";
import type { CodexAccountRecord } from "../src/core/types";
import {
  CodexHotSwitchRuntime,
  resolveRuntimeAccessTokenIdentity,
  selectManagedAccountForRefresh,
  selectManagedAccountForUsageAttribution
} from "../src/codex/hotSwitchRuntime";
import { HotSwitchOperationUncertainError } from "../src/codex/hotSwitchBridge";
import {
  clearCurrentWindowRuntimeAccountIfMatches,
  getCurrentWindowRuntimeAccountId,
  setCurrentWindowRuntimeAccountId
} from "../src/presentation/workbench/windowRuntimeAccount";

vi.mock("../src/codex/authFile", () => ({
  readAuthFile: vi.fn(),
  writeAuthFile: vi.fn()
}));

describe("Codex hot-switch runtime setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readAuthFile).mockResolvedValue(undefined);
    vi.mocked(writeAuthFile).mockResolvedValue(undefined);
    setCurrentWindowRuntimeAccountId(undefined);
  });

  it("reuses the coordinator-owned lease for bridge-driven local activation", async () => {
    const switchAccount = vi.fn(async () => undefined);
    const runtime = new CodexHotSwitchRuntime(
      {} as vscode.ExtensionContext,
      { switchAccount } as unknown as ConstructorParameters<typeof CodexHotSwitchRuntime>[1]
    );

    await (
      runtime as unknown as {
        activateLocalAccount: (localAccountId: string) => Promise<void>;
      }
    ).activateLocalAccount("local-b");

    expect(switchAccount).toHaveBeenCalledWith("local-b", { runtimeLeaseHeld: true });
    expect(getCurrentWindowRuntimeAccountId()).toBe("local-b");
  });

  it("uses the local account identity when workspace identifiers are shared", () => {
    const accounts = [
      {
        id: "local-a",
        accountId: "shared-workspace",
        email: "first@example.invalid",
        isActive: false
      },
      {
        id: "local-b",
        accountId: "shared-workspace",
        email: "second@example.invalid",
        isActive: true
      }
    ] as CodexAccountRecord[];

    expect(
      selectManagedAccountForRefresh(
        accounts,
        {
          previousAccountId: "shared-workspace",
          localAccountId: "local-a",
          expectedEmail: "FIRST@example.invalid"
        },
        "local-b"
      ).id
    ).toBe("local-a");
    expect(() => selectManagedAccountForRefresh(accounts, { previousAccountId: "shared-workspace" })).toThrow(
      "matches multiple managed accounts"
    );
    expect(
      selectManagedAccountForRefresh(accounts, {
        previousAccountId: "shared-workspace",
        localAccountId: "local-a",
        expectedEmail: "second@example.invalid"
      }).id
    ).toBe("local-a");
  });

  it("only enables startup usage attribution for an unambiguous runtime identity", () => {
    const accounts = [
      { id: "local-a", email: "same@example.invalid", isActive: true },
      { id: "local-b", email: "same@example.invalid", isActive: false },
      { id: "local-c", email: "other@example.invalid", isActive: false }
    ] as CodexAccountRecord[];

    expect(
      selectManagedAccountForUsageAttribution(accounts, {
        email: "same@example.invalid",
        managedLocalAccountId: "local-b"
      })?.id
    ).toBe("local-b");
    expect(
      selectManagedAccountForUsageAttribution(accounts, {
        email: "same@example.invalid",
        managedLocalAccountId: null
      })?.id
    ).toBe("local-a");
    expect(
      selectManagedAccountForUsageAttribution(accounts, {
        email: "missing@example.invalid",
        managedLocalAccountId: null
      })
    ).toBeUndefined();
  });

  it("uses the access-token email for app-server identity when a stable user has an email alias", () => {
    const identity = resolveRuntimeAccessTokenIdentity(
      { email: "stored@example.invalid", userId: "user-same" },
      createUnsignedJwt({
        "https://api.openai.com/auth": { chatgpt_user_id: "user-same" },
        "https://api.openai.com/profile": { email: "runtime@example.invalid" }
      })
    );

    expect(identity).toEqual({ email: "runtime@example.invalid", userId: "user-same" });
  });

  it("rejects an access token from a different user", () => {
    expect(() =>
      resolveRuntimeAccessTokenIdentity(
        { email: "stored@example.invalid", userId: "user-expected" },
        createUnsignedJwt({
          "https://api.openai.com/auth": { chatgpt_user_id: "user-other" },
          "https://api.openai.com/profile": { email: "stored@example.invalid" }
        })
      )
    ).toThrow("different user");
  });

  it("passes runtime aliases to the shim while preserving stable local account identities", async () => {
    const enabledConfiguration = {
      get: (key: string, defaultValue?: unknown) => (key === "hotSwitchEnabled" ? true : defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as unknown as vscode.WorkspaceConfiguration;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(enabledConfiguration);

    const accounts = new Map<string, CodexAccountRecord>([
      [
        "local-a",
        {
          id: "local-a",
          email: "stored-a@example.invalid",
          userId: "user-a",
          accountId: "workspace-a",
          isActive: true,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      [
        "local-b",
        {
          id: "local-b",
          email: "stored-b@example.invalid",
          userId: "user-b",
          accountId: "workspace-b",
          isActive: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    ]);
    const tokens = new Map([
      [
        "local-a",
        {
          idToken: "unused-id-a",
          accessToken: createUnsignedJwt({
            exp: Math.floor(Date.now() / 1_000) + 3_600,
            "https://api.openai.com/auth": { chatgpt_user_id: "user-a" },
            "https://api.openai.com/profile": { email: "runtime-a@example.invalid" }
          }),
          accountId: "workspace-a"
        }
      ],
      [
        "local-b",
        {
          idToken: "unused-id-b",
          accessToken: createUnsignedJwt({
            exp: Math.floor(Date.now() / 1_000) + 3_600,
            "https://api.openai.com/auth": { chatgpt_user_id: "user-b" },
            "https://api.openai.com/profile": { email: "runtime-b@example.invalid" }
          }),
          accountId: "workspace-b"
        }
      ]
    ]);
    const switchAccount = vi.fn().mockResolvedValue({
      status: "switched",
      accountId: "workspace-b",
      email: "runtime-b@example.invalid",
      activeTurns: 0,
      interruptedTurns: 0,
      continuedThreads: 0
    });
    const runtime = new CodexHotSwitchRuntime(
      {} as vscode.ExtensionContext,
      {
        getAccount: vi.fn(async (id: string) => accounts.get(id)),
        getTokens: vi.fn(async (id: string) => tokens.get(id))
      } as unknown as ConstructorParameters<typeof CodexHotSwitchRuntime>[1]
    );
    (runtime as unknown as { bridge: { switchAccount: typeof switchAccount } }).bridge = { switchAccount };
    setCurrentWindowRuntimeAccountId("local-a");

    await expect(runtime.switchAccount("local-b")).resolves.toMatchObject({ status: "switched" });
    expect(switchAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        localAccountId: "local-b",
        previousLocalAccountId: "local-a",
        expectedEmail: "runtime-b@example.invalid",
        previousExpectedEmail: "runtime-a@example.invalid"
      })
    );

    switchAccount.mockClear();
    await runtime.switchAccount("local-b", {
      gracePeriodMs: 0,
      longTurnPolicy: "interruptAndContinue",
      recoverRecentUsageLimitedTurns: true
    });
    expect(switchAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        gracePeriodMs: 0,
        longTurnPolicy: "interruptAndContinue",
        recoverRecentUsageLimitedTurns: true
      })
    );
  });

  it("rejects a hidden account before sending a runtime switch request", async () => {
    const enabledConfiguration = {
      get: (key: string, defaultValue?: unknown) => (key === "hotSwitchEnabled" ? true : defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as unknown as vscode.WorkspaceConfiguration;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(enabledConfiguration);
    const switchAccount = vi.fn();
    const runtime = new CodexHotSwitchRuntime(
      {} as vscode.ExtensionContext,
      {
        getAccount: vi.fn(async () => ({
          id: "hidden",
          email: "hidden@example.invalid",
          accountId: "workspace-hidden",
          isActive: false,
          isHidden: true,
          createdAt: 1,
          updatedAt: 1
        })),
        getTokens: vi.fn(async () => ({ idToken: "id", accessToken: "access", accountId: "workspace-hidden" }))
      } as unknown as ConstructorParameters<typeof CodexHotSwitchRuntime>[1]
    );
    (runtime as unknown as { bridge: { switchAccount: typeof switchAccount } }).bridge = { switchAccount };

    await expect(runtime.switchAccount("hidden")).rejects.toThrow("selected account is hidden");
    expect(switchAccount).not.toHaveBeenCalled();
  });

  it("uses a validated auth.json snapshot when the previous managed account was deleted", async () => {
    const enabledConfiguration = {
      get: (key: string, defaultValue?: unknown) => (key === "hotSwitchEnabled" ? true : defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as unknown as vscode.WorkspaceConfiguration;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(enabledConfiguration);

    const previousIdToken = createUnsignedJwt({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      email: "previous@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_user_id: "previous-user",
        chatgpt_account_id: "workspace-previous",
        chatgpt_plan_type: "free"
      }
    });
    const previousAccessToken = createUnsignedJwt({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      "https://api.openai.com/auth": {
        chatgpt_user_id: "previous-user",
        chatgpt_account_id: "workspace-previous"
      },
      "https://api.openai.com/profile": { email: "previous@example.invalid" }
    });
    vi.mocked(readAuthFile).mockResolvedValue({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: previousIdToken,
        access_token: previousAccessToken,
        refresh_token: "previous-refresh-token",
        account_id: "workspace-previous"
      }
    });

    const targetAccount: CodexAccountRecord = {
      id: "local-target",
      email: "target@example.invalid",
      userId: "target-user",
      accountId: "workspace-target",
      isActive: false,
      createdAt: 1,
      updatedAt: 1
    };
    const targetTokens = {
      idToken: "unused-target-id",
      accessToken: createUnsignedJwt({
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        "https://api.openai.com/auth": { chatgpt_user_id: "target-user" },
        "https://api.openai.com/profile": { email: "target@example.invalid" }
      }),
      accountId: "workspace-target"
    };
    const switchAccount = vi.fn().mockResolvedValue({
      status: "switched",
      accountId: "workspace-target",
      email: "target@example.invalid",
      activeTurns: 0,
      interruptedTurns: 0,
      continuedThreads: 0
    });
    const runtime = new CodexHotSwitchRuntime(
      {} as vscode.ExtensionContext,
      {
        getAccount: vi.fn(async (id: string) => (id === targetAccount.id ? targetAccount : undefined)),
        getTokens: vi.fn(async (id: string) => (id === targetAccount.id ? targetTokens : undefined)),
        syncActiveAccountFromAuthFile: vi.fn(async () => undefined)
      } as unknown as ConstructorParameters<typeof CodexHotSwitchRuntime>[1]
    );
    (
      runtime as unknown as { bridge: { getIdentity: () => Promise<unknown>; switchAccount: typeof switchAccount } }
    ).bridge = {
      getIdentity: vi.fn().mockResolvedValue({
        accountType: "chatgpt",
        email: "previous@example.invalid",
        planType: "free",
        externalAuthActive: true,
        managedAccountId: "workspace-previous",
        managedLocalAccountId: "deleted-local",
        httpTransportForced: true
      }),
      switchAccount
    };
    setCurrentWindowRuntimeAccountId("deleted-local");

    await expect(runtime.switchAccount(targetAccount.id)).resolves.toMatchObject({ status: "switched" });
    expect(switchAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        localAccountId: targetAccount.id,
        previousAccountId: "workspace-previous",
        previousExpectedEmail: "previous@example.invalid",
        previousAccessToken,
        previousPlanType: "free",
        rollbackContextId: expect.any(String)
      })
    );
    expect(switchAccount.mock.calls[0]?.[0]).not.toHaveProperty("previousLocalAccountId");
    expect(writeAuthFile).not.toHaveBeenCalled();

    switchAccount.mockRejectedValueOnce(
      new HotSwitchOperationUncertainError("runtime/switch", "the control request timed out", "operation-uncertain")
    );
    await expect(runtime.switchAccount(targetAccount.id)).rejects.toThrow("outcome is uncertain");
    const rollbackContextId = switchAccount.mock.calls[1]?.[0]?.rollbackContextId;
    expect(rollbackContextId).toEqual(expect.any(String));
    const runtimeInternals = runtime as unknown as {
      unmanagedRollbackSnapshots: Map<string, unknown>;
      restoreUnmanagedAccount(rollbackContextId: string): Promise<void>;
    };
    expect(runtimeInternals.unmanagedRollbackSnapshots.has(rollbackContextId)).toBe(true);
    await runtimeInternals.restoreUnmanagedAccount(rollbackContextId);
    expect(writeAuthFile).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: previousAccessToken, accountId: "workspace-previous" })
    );
    expect(runtimeInternals.unmanagedRollbackSnapshots.has(rollbackContextId)).toBe(false);
  });

  it("carries a validated auth.json rollback snapshot into a Gateway fallback", async () => {
    const enabledConfiguration = {
      get: (key: string, defaultValue?: unknown) => (key === "hotSwitchEnabled" ? true : defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as unknown as vscode.WorkspaceConfiguration;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(enabledConfiguration);
    const previousIdToken = createUnsignedJwt({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      email: "previous@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_user_id: "previous-user",
        chatgpt_account_id: "workspace-previous",
        chatgpt_plan_type: "plus"
      }
    });
    const previousAccessToken = createUnsignedJwt({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      "https://api.openai.com/auth": {
        chatgpt_user_id: "previous-user",
        chatgpt_account_id: "workspace-previous"
      },
      "https://api.openai.com/profile": { email: "previous@example.invalid" }
    });
    vi.mocked(readAuthFile).mockResolvedValue({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: previousIdToken,
        access_token: previousAccessToken,
        refresh_token: "previous-refresh-token",
        account_id: "workspace-previous"
      }
    });
    const target: CodexAccountRecord = {
      id: "local-target",
      email: "target@example.invalid",
      userId: "target-user",
      accountId: "workspace-target",
      isActive: false,
      createdAt: 1,
      updatedAt: 1
    };
    const targetTokens = {
      idToken: "unused-target-id",
      accessToken: createUnsignedJwt({
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        "https://api.openai.com/auth": { chatgpt_user_id: "target-user" },
        "https://api.openai.com/profile": { email: "target@example.invalid" }
      }),
      accountId: "workspace-target"
    };
    const globalState = new Map<string, unknown>([
      [
        "gateway.runtimeConfig",
        {
          config: {
            displayName: "Gateway",
            baseUrl: "http://127.0.0.1:65432/v1",
            model: "gpt-5.5",
            autoFallbackToChatGpt: true
          },
          active: true
        }
      ]
    ]);
    const fallbackToChatGpt = vi.fn().mockResolvedValue({
      status: "switched",
      accountId: "workspace-target",
      email: "target@example.invalid",
      activeTurns: 0,
      interruptedTurns: 0,
      continuedThreads: 0
    });
    const runtime = new CodexHotSwitchRuntime(
      {
        globalState: {
          get: (key: string) => globalState.get(key),
          update: async (key: string, value: unknown) => {
            if (value === undefined) {
              globalState.delete(key);
            } else {
              globalState.set(key, value);
            }
          }
        }
      } as unknown as vscode.ExtensionContext,
      {
        getAccount: vi.fn(async (id: string) => (id === target.id ? target : undefined)),
        getTokens: vi.fn(async (id: string) => (id === target.id ? targetTokens : undefined))
      } as unknown as ConstructorParameters<typeof CodexHotSwitchRuntime>[1]
    );
    (
      runtime as unknown as {
        bridge: { getIdentity: () => Promise<unknown>; fallbackToChatGpt: typeof fallbackToChatGpt };
      }
    ).bridge = {
      getIdentity: vi.fn().mockResolvedValue({
        accountType: "chatgpt",
        email: "previous@example.invalid",
        planType: "plus",
        externalAuthActive: true,
        managedAccountId: null,
        managedLocalAccountId: null,
        httpTransportForced: true
      }),
      fallbackToChatGpt
    };

    await expect(runtime.fallbackGatewayToChatGpt(target.id)).resolves.toMatchObject({ status: "switched" });
    expect(fallbackToChatGpt).toHaveBeenCalledWith(
      expect.objectContaining({
        localAccountId: target.id,
        previousAccountId: "workspace-previous",
        previousExpectedEmail: "previous@example.invalid",
        previousAccessToken,
        previousPlanType: "plus",
        rollbackContextId: expect.any(String)
      })
    );
    expect(fallbackToChatGpt.mock.calls[0]?.[0]).not.toHaveProperty("previousLocalAccountId");
    expect(globalState.get("gateway.runtimeConfig")).toMatchObject({ active: false });
  });

  it("clears only the deleted account from the window runtime baseline", () => {
    setCurrentWindowRuntimeAccountId("local-a");

    expect(clearCurrentWindowRuntimeAccountIfMatches("local-b")).toBe(false);
    expect(getCurrentWindowRuntimeAccountId()).toBe("local-a");
    expect(clearCurrentWindowRuntimeAccountIfMatches("local-a")).toBe(true);
    expect(getCurrentWindowRuntimeAccountId()).toBeUndefined();
  });

  it("fails closed when hot switching is enabled but the runtime bridge is not ready", async () => {
    const enabledConfiguration = {
      get: (key: string, defaultValue?: unknown) => (key === "hotSwitchEnabled" ? true : defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as unknown as vscode.WorkspaceConfiguration;
    vi.mocked(vscode.workspace.getConfiguration)
      .mockReturnValueOnce(enabledConfiguration)
      .mockReturnValueOnce(enabledConfiguration);

    const runtime = new CodexHotSwitchRuntime(
      {} as vscode.ExtensionContext,
      {} as ConstructorParameters<typeof CodexHotSwitchRuntime>[1]
    );

    expect(runtime.isEnabled()).toBe(true);
    await expect(runtime.switchAccount("local-b")).rejects.toThrow("runtime is not ready");
  });

  it("requires one reload for first Gateway runtime installation, then switches both routes without reload", async () => {
    const enabledConfiguration = {
      get: (key: string, defaultValue?: unknown) => (key === "hotSwitchEnabled" ? true : defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as unknown as vscode.WorkspaceConfiguration;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(enabledConfiguration);
    const config = {
      displayName: "Gateway",
      baseUrl: "https://gateway.example.invalid/v1",
      model: "gpt-5",
      autoFallbackToChatGpt: false
    };
    const firstRuntime = new CodexHotSwitchRuntime(
      { globalState: { get: vi.fn(), update: vi.fn() } } as unknown as vscode.ExtensionContext,
      {} as ConstructorParameters<typeof CodexHotSwitchRuntime>[1]
    );
    vi.spyOn(firstRuntime as never, "configureRuntime" as never).mockResolvedValue({
      enabled: true,
      configured: false,
      requiresReload: true
    } as never);
    await expect(firstRuntime.activateGateway(config)).resolves.toMatchObject({ requiresReload: true });

    const globalState = new Map<string, unknown>([
      [
        "gateway.runtimeConfig",
        {
          config,
          active: false
        }
      ]
    ]);
    const switchGatewayRoute = vi.fn(async ({ route }: { route: "gateway" | "chatgpt" }) => ({
      status: "switched" as const,
      accountId: route === "gateway" ? "virtual:sub2api-gateway" : "",
      email: null,
      activeTurns: 0,
      interruptedTurns: 0,
      continuedThreads: 0
    }));
    const runtime = new CodexHotSwitchRuntime(
      {
        globalState: {
          get: (key: string) => globalState.get(key),
          update: async (key: string, value: unknown) => globalState.set(key, value)
        }
      } as unknown as vscode.ExtensionContext,
      {
        listAccounts: vi.fn(async () => [
          {
            id: "oauth-account",
            email: "oauth@example.invalid",
            isActive: true,
            createdAt: 1,
            updatedAt: 1
          }
        ]),
        getTokens: vi.fn(async () => ({ idToken: "id", accessToken: "oauth-token" })),
        switchProviderRoute: vi.fn()
      } as never
    );
    (runtime as unknown as { bridge: unknown }).bridge = {
      configureGatewayCredential: vi.fn(async () => undefined),
      switchGatewayRoute
    };

    await expect(runtime.activateGateway(config, "gateway-key")).resolves.toEqual({
      enabled: true,
      configured: true,
      requiresReload: false
    });
    await expect(runtime.deactivateGateway()).resolves.toEqual({
      enabled: true,
      configured: true,
      requiresReload: false
    });
    expect(switchGatewayRoute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ route: "gateway", longTurnPolicy: expect.any(String) })
    );
    expect(switchGatewayRoute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ route: "chatgpt", longTurnPolicy: expect.any(String) })
    );
  });

  it("requires a reload when an active Gateway profile changes its endpoint or model", async () => {
    const enabledConfiguration = {
      get: (key: string, defaultValue?: unknown) => (key === "hotSwitchEnabled" ? true : defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as unknown as vscode.WorkspaceConfiguration;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(enabledConfiguration);
    const currentConfig = {
      displayName: "Local Gateway",
      baseUrl: "https://local.example.invalid/v1",
      model: "gpt-5"
    };
    const nextConfig = {
      displayName: "External Gateway",
      baseUrl: "https://external.example.invalid/v1",
      model: "gpt-5.5"
    };
    const globalState = new Map<string, unknown>([
      ["gateway.runtimeConfig", { config: currentConfig, active: true }]
    ]);
    const runtime = new CodexHotSwitchRuntime(
      {
        globalState: {
          get: (key: string) => globalState.get(key),
          update: async (key: string, value: unknown) => globalState.set(key, value)
        }
      } as unknown as vscode.ExtensionContext,
      {} as ConstructorParameters<typeof CodexHotSwitchRuntime>[1]
    );
    const switchGatewayRoute = vi.fn();
    (runtime as unknown as { bridge: { switchGatewayRoute: typeof switchGatewayRoute } }).bridge = {
      switchGatewayRoute
    };

    await expect(runtime.activateGateway(nextConfig, "external-key")).resolves.toEqual({
      enabled: true,
      configured: false,
      requiresReload: true
    });
    expect(globalState.get("gateway.runtimeConfig")).toEqual({ config: nextConfig, active: true });
    expect(switchGatewayRoute).not.toHaveBeenCalled();
  });
});

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.verification`;
}
