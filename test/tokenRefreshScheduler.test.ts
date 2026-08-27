import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";

const { refreshTokensMock } = vi.hoisted(() => ({
  refreshTokensMock: vi.fn()
}));

vi.mock("../src/auth/oauth", async () => {
  const actual = await vi.importActual<typeof import("../src/auth/oauth")>("../src/auth/oauth");
  return {
    ...actual,
    refreshTokens: refreshTokensMock
  };
});

import { registerTokenRefreshScheduler } from "../src/presentation/workbench/schedulerRegistration";

describe("token refresh scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes an account when only its id token enters the five-minute window", async () => {
    vi.useFakeTimers();
    const account = makeAccount("account-a");
    const tokens = makeTokens(3_600, 240);
    const refreshed = makeTokens(7_200, 7_200);
    refreshTokensMock.mockResolvedValue(refreshed);

    const repo = makeRepo([account], tokens);
    const registration = registerScheduler(repo);

    try {
      await registration.resync();
      await vi.advanceTimersByTimeAsync(0);

      expect(refreshTokensMock).toHaveBeenCalledOnce();
      expect(refreshTokensMock).toHaveBeenCalledWith("refresh-account-a", tokens.idToken);
      expect(repo.updateTokens).toHaveBeenCalledWith(
        "account-a",
        {
          ...refreshed,
          accountId: "provider-account-a"
        },
        { notifyTokenChange: false }
      );
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("refreshes an account only once when access and id token entries are both due", async () => {
    vi.useFakeTimers();
    const account = makeAccount("account-a");
    const tokens = makeTokens(240, 240);
    refreshTokensMock.mockResolvedValue(makeTokens(7_200, 7_200));

    const repo = makeRepo([account], tokens);
    const registration = registerScheduler(repo);

    try {
      await registration.resync();
      await vi.advanceTimersByTimeAsync(0);

      expect(refreshTokensMock).toHaveBeenCalledOnce();
      expect(repo.updateTokens).toHaveBeenCalledOnce();
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("refreshes due accounts in parallel with a bounded worker pool", async () => {
    vi.useFakeTimers();
    const accounts = [makeAccount("account-a"), makeAccount("account-b")];
    const tokensById = new Map(accounts.map((account) => [account.id, makeTokens(3_600, 240)]));
    let releaseRefreshes!: () => void;
    const refreshesFinished = new Promise<void>((resolve) => {
      releaseRefreshes = resolve;
    });
    let activeRefreshes = 0;
    let maximumActiveRefreshes = 0;
    refreshTokensMock.mockImplementation(async () => {
      activeRefreshes += 1;
      maximumActiveRefreshes = Math.max(maximumActiveRefreshes, activeRefreshes);
      await refreshesFinished;
      activeRefreshes -= 1;
      return makeTokens(7_200, 7_200);
    });

    const repo = makeRepo(accounts, tokensById.get("account-a")!);
    repo.getTokens.mockImplementation(async (accountId: string) => tokensById.get(accountId));
    const registration = registerScheduler(repo);

    try {
      await registration.resync();
      vi.advanceTimersByTime(0);
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }

      expect(maximumActiveRefreshes).toBe(2);
      releaseRefreshes();
      await vi.advanceTimersByTimeAsync(0);
      expect(repo.updateTokens).toHaveBeenCalledTimes(2);
    } finally {
      releaseRefreshes();
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("does not re-enter the scheduler while a refresh is still in flight", async () => {
    vi.useFakeTimers();
    const account = makeAccount("account-a");
    const tokens = makeTokens(3_600, 240);
    let releaseRefresh!: () => void;
    const refreshFinished = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    refreshTokensMock.mockImplementation(async () => {
      await refreshFinished;
      return makeTokens(7_200, 7_200);
    });

    let announceTokensChanged: ((accountIds?: readonly string[]) => void) | undefined;
    const repo = makeRepo([account], tokens);
    repo.onDidChangeTokens.mockImplementation((listener: (accountIds?: readonly string[]) => void) => {
      announceTokensChanged = listener;
      return { dispose: vi.fn() };
    });
    const registration = registerScheduler(repo);

    try {
      await registration.resync();
      vi.advanceTimersByTime(0);
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }

      expect(refreshTokensMock).toHaveBeenCalledOnce();
      announceTokensChanged?.([account.id]);
      await registration.resync([account.id]);

      // The lease renewal interval is the only timer that should remain while
      // the due account's refresh request is unresolved.
      expect(vi.getTimerCount()).toBe(1);

      releaseRefresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(repo.updateTokens).toHaveBeenCalledOnce();
    } finally {
      releaseRefresh();
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("backs off when the refresh endpoint only returns a new access token", async () => {
    vi.useFakeTimers();
    const account = makeAccount("account-a");
    const tokens = makeTokens(3_600, 240);
    refreshTokensMock.mockResolvedValue({
      ...makeTokens(7_200, 7_200),
      idToken: tokens.idToken
    });

    const repo = makeRepo([account], tokens);
    const registration = registerScheduler(repo);

    try {
      await registration.resync();
      await vi.advanceTimersByTimeAsync(0);

      expect(refreshTokensMock).toHaveBeenCalledOnce();
      expect(repo.updateTokens).toHaveBeenCalledOnce();
      expect(repo.updateTokenRefreshStatus).toHaveBeenCalledWith(
        "account-a",
        expect.objectContaining({
          tokenRefreshLastAttemptAt: expect.any(Number),
          tokenRefreshLastSuccessAt: expect.any(Number),
          tokenRefreshLastError: undefined,
          tokenRefreshLastErrorKind: undefined
        })
      );
      await vi.advanceTimersByTimeAsync(299_999);
      expect(refreshTokensMock).toHaveBeenCalledOnce();
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("does not retry an invalid refresh token until credentials are replaced", async () => {
    vi.useFakeTimers();
    const account = makeAccount("account-a");
    const tokens = makeTokens(3_600, 240);
    const invalidGrant = Object.assign(new Error("Token refresh failed (401)"), {
      code: "API_ERROR",
      statusCode: 401,
      context: { errorCode: "invalid_grant" }
    });
    refreshTokensMock.mockRejectedValue(invalidGrant);

    const repo = makeRepo([account], tokens);
    const registration = registerScheduler(repo);

    try {
      await registration.resync();
      await vi.advanceTimersByTimeAsync(0);

      expect(refreshTokensMock).toHaveBeenCalledOnce();
      expect(repo.updateTokenRefreshStatus).toHaveBeenCalledWith(
        "account-a",
        expect.objectContaining({
          tokenRefreshLastError: "Token refresh failed (401)",
          tokenRefreshLastErrorKind: "reauthorize",
          tokenRefreshNextRetryAt: undefined
        })
      );
      await vi.advanceTimersByTimeAsync(900_000);
      expect(refreshTokensMock).toHaveBeenCalledOnce();
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("retries transient refresh endpoint failures after the scheduler interval", async () => {
    vi.useFakeTimers();
    const account = makeAccount("account-a");
    const tokens = makeTokens(3_600, 240);
    const serviceUnavailable = Object.assign(new Error("Token refresh failed (503)"), {
      code: "API_ERROR",
      statusCode: 503
    });
    refreshTokensMock.mockRejectedValue(serviceUnavailable);

    const repo = makeRepo([account], tokens);
    const registration = registerScheduler(repo);

    try {
      await registration.resync();
      await vi.advanceTimersByTimeAsync(0);

      expect(refreshTokensMock).toHaveBeenCalledOnce();
      expect(repo.updateTokenRefreshStatus).toHaveBeenCalledWith(
        "account-a",
        expect.objectContaining({
          tokenRefreshLastErrorKind: "network",
          tokenRefreshNextRetryAt: expect.any(Number)
        })
      );
      await vi.advanceTimersByTimeAsync(299_999);
      expect(refreshTokensMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshTokensMock).toHaveBeenCalledTimes(2);
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("discards a stale queue entry after a token resync", async () => {
    vi.useFakeTimers();
    const account = makeAccount("account-a");
    const original = makeTokens(600, 600);
    const replacement = makeTokens(3_600, 3_600);
    refreshTokensMock.mockResolvedValue(makeTokens(7_200, 7_200));

    const repo = makeRepo([account], original);
    const registration = registerScheduler(repo);

    try {
      await registration.resync();
      repo.getTokens.mockResolvedValue(replacement);
      await registration.resync([account.id]);

      await vi.advanceTimersByTimeAsync(301_000);

      expect(refreshTokensMock).not.toHaveBeenCalled();
      expect(repo.updateTokens).not.toHaveBeenCalled();
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });

  it("resynchronizes an imported account after the repository announces its credentials", async () => {
    vi.useFakeTimers();
    const account = makeAccount("account-a");
    const tokens = makeTokens(3_600, 240);
    refreshTokensMock.mockResolvedValue(makeTokens(7_200, 7_200));
    let accounts: CodexAccountRecord[] = [];
    let announceTokensChanged: ((accountIds?: readonly string[]) => void) | undefined;

    const repo = makeRepo([], tokens);
    repo.listAccounts.mockImplementation(async () => accounts);
    repo.onDidChangeTokens.mockImplementation((listener: (accountIds?: readonly string[]) => void) => {
      announceTokensChanged = listener;
      return { dispose: vi.fn() };
    });
    const registration = registerScheduler(repo);

    try {
      await registration.resync();
      accounts = [account];
      announceTokensChanged?.([account.id]);
      await registration.resync([account.id]);
      await vi.advanceTimersByTimeAsync(0);

      expect(repo.getTokens).toHaveBeenCalledWith(account.id);
      expect(refreshTokensMock).toHaveBeenCalledOnce();
    } finally {
      registration.dispose();
      vi.useRealTimers();
    }
  });
});

function registerScheduler(repo: ReturnType<typeof makeRepo>) {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration() as never);
  vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue({ dispose: vi.fn() } as never);
  return registerTokenRefreshScheduler({
    context: { subscriptions: [] } as never,
    repo: repo as never,
    view: { refresh: vi.fn() },
    checkIntervalMs: 300_000,
    skewSeconds: 300
  });
}

function makeRepo(accounts: CodexAccountRecord[], tokens: CodexTokens) {
  return {
    listAccounts: vi.fn().mockResolvedValue(accounts),
    getTokens: vi.fn().mockResolvedValue(tokens),
    updateTokens: vi.fn().mockResolvedValue(undefined),
    updateTokenRefreshStatus: vi.fn().mockResolvedValue(undefined),
    tryAcquireSchedulerLease: vi.fn().mockResolvedValue({
      renew: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined)
    }),
    onDidChangeTokens: vi.fn().mockReturnValue({ dispose: vi.fn() })
  };
}

function makeAccount(id: string): CodexAccountRecord {
  return {
    id,
    email: `${id}@example.invalid`,
    accountKind: "chatgpt",
    quotaMode: "chatgpt",
    isActive: false,
    accountId: `provider-${id}`,
    createdAt: 1,
    updatedAt: 1
  };
}

function makeTokens(accessExpirySeconds: number, idExpirySeconds: number): CodexTokens {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    accessToken: makeJwt(nowSeconds + accessExpirySeconds),
    idToken: makeJwt(nowSeconds + idExpirySeconds),
    refreshToken: "refresh-account-a"
  };
}

function makeJwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

function configuration(): vscode.WorkspaceConfiguration {
  return {
    get: (key: string, fallback?: unknown) => (key === "backgroundTokenRefreshEnabled" ? true : fallback),
    update: vi.fn(),
    inspect: vi.fn()
  } as never;
}
