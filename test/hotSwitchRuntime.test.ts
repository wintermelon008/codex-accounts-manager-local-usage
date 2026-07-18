import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAccountRecord } from "../src/core/types";
import {
  CodexHotSwitchRuntime,
  resolveRuntimeAccessTokenIdentity,
  selectManagedAccountForRefresh
} from "../src/codex/hotSwitchRuntime";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";

describe("Codex hot-switch runtime setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentWindowRuntimeAccountId(undefined);
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
});

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.verification`;
}
