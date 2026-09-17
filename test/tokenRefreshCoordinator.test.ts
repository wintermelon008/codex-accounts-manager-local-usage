import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexTokens } from "../src/core/types";

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

import {
  ensureFreshAccountTokens,
  ensureFreshTokensWithLease,
  invalidateFreshAccountTokenRefresh
} from "../src/auth/tokenRefreshCoordinator";
import { clearAccountStates } from "../src/application/accounts/accountState";
import { resolveAccountHealth } from "../src/application/accounts/health";

describe("token refresh coordinator", () => {
  beforeEach(() => {
    refreshTokensMock.mockReset();
    clearAccountStates();
  });

  it("a managed OAuth renewal immediately confirms the account without a model request", async () => {
    const account = {
      id: "managed",
      accountId: "workspace",
      email: "test@example.invalid",
      isActive: false,
      createdAt: 1,
      updatedAt: 1
    };
    let stored = { ...makeTokens("old", 1), accountId: account.accountId };
    const issued = { ...makeTokens("new", 3_600), accountId: account.accountId };
    refreshTokensMock.mockResolvedValue(issued);
    const repo = {
      ...makeLeaseRepo(),
      getTokens: async () => stored,
      updateTokens: vi.fn(async (_id: string, next: CodexTokens) => {
        stored = next as typeof stored;
      })
    };
    await ensureFreshAccountTokens(repo, account.id);
    expect(refreshTokensMock).toHaveBeenCalledOnce();
    expect(repo.updateTokens).toHaveBeenCalledOnce();
    expect(
      resolveAccountHealth(account, stored, { enabled: false, intervalMs: 0, skewSeconds: 300, accounts: {} })
    ).toMatchObject({ kind: "healthy", availability: "usable", renewal: "succeeded" });
  });

  it("shares one in-process refresh and persists the resulting pair once", async () => {
    const oldTokens = makeTokens("old", 1);
    const newTokens = makeTokens("new", 3_600);
    let stored = oldTokens;
    let releaseRefresh!: () => void;
    const refreshFinished = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    refreshTokensMock.mockImplementation(async () => {
      await refreshFinished;
      return newTokens;
    });

    const save = vi.fn(async (tokens: CodexTokens) => {
      stored = tokens;
    });
    const repo = makeLeaseRepo();
    const source = {
      key: "test-in-process-single-flight",
      load: async () => stored,
      save
    };

    const first = ensureFreshTokensWithLease(repo, source);
    const second = ensureFreshTokensWithLease(repo, source);
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }

    expect(refreshTokensMock).toHaveBeenCalledOnce();
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([newTokens, newTokens]);
    expect(save).toHaveBeenCalledOnce();
    expect(stored).toEqual(newTokens);
  });

  it("does not reuse or overwrite an in-flight refresh after OAuth replaces credentials", async () => {
    const oldTokens = makeTokens("old", 1);
    const newTokens = makeTokens("oauth", 3_600);
    let stored = oldTokens;
    let releaseRefresh!: () => void;
    const refreshFinished = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    refreshTokensMock.mockImplementation(async () => {
      await refreshFinished;
      return makeTokens("stale-refresh-result", 3_600);
    });

    const save = vi.fn(async (tokens: CodexTokens) => {
      stored = tokens;
    });
    const source = {
      key: "account:reauthorization-race",
      load: async () => stored,
      save
    };
    const repo = makeLeaseRepo();
    const oldRefresh = ensureFreshTokensWithLease(repo, source);
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }

    expect(refreshTokensMock).toHaveBeenCalledOnce();
    stored = newTokens;
    invalidateFreshAccountTokenRefresh("reauthorization-race");

    await expect(ensureFreshTokensWithLease(repo, source)).resolves.toEqual(newTokens);
    releaseRefresh();

    await expect(oldRefresh).resolves.toEqual(newTokens);
    expect(save).not.toHaveBeenCalled();
    expect(stored).toEqual(newTokens);
  });

  it("re-reads after acquiring the lease and adopts a refresh done by another process", async () => {
    const oldTokens = makeTokens("old", 1);
    const newTokens = makeTokens("new", 3_600);
    let stored = oldTokens;
    const save = vi.fn(async (tokens: CodexTokens) => {
      stored = tokens;
    });
    const repo = makeLeaseRepo(async () => {
      stored = newTokens;
      return makeLease();
    });

    const result = await ensureFreshTokensWithLease(repo, {
      key: "test-cross-process-reread",
      load: async () => stored,
      save
    });

    expect(result).toEqual(newTokens);
    expect(refreshTokensMock).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("forces a refresh for a still-valid token after an authenticated 401", async () => {
    const oldTokens = makeTokens("old", 3_600);
    const newTokens = makeTokens("new", 7_200);
    let stored = oldTokens;
    const save = vi.fn(async (tokens: CodexTokens) => {
      stored = tokens;
    });
    refreshTokensMock.mockResolvedValue(newTokens);

    const result = await ensureFreshTokensWithLease(makeLeaseRepo(), {
      key: "test-force-refresh-after-401",
      forceRefresh: true,
      load: async () => stored,
      save
    });

    expect(result).toEqual(newTokens);
    expect(refreshTokensMock).toHaveBeenCalledWith(oldTokens.refreshToken, oldTokens.idToken);
    expect(save).toHaveBeenCalledWith(newTokens, oldTokens);
  });

  it("adopts a changed token pair instead of forcing a second refresh", async () => {
    const oldTokens = makeTokens("old", 3_600);
    const newTokens = makeTokens("new", 7_200);
    let stored = oldTokens;
    const save = vi.fn(async () => undefined);
    const repo = makeLeaseRepo(async () => {
      stored = newTokens;
      return makeLease();
    });

    const result = await ensureFreshTokensWithLease(repo, {
      key: "test-force-refresh-adopts-external-update",
      forceRefresh: true,
      load: async () => stored,
      save
    });

    expect(result).toEqual(newTokens);
    expect(refreshTokensMock).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("adopts a newer pair after refresh_token_reused without replaying the old token", async () => {
    const oldTokens = makeTokens("old", 1);
    const newTokens = makeTokens("new", 3_600);
    let loadCount = 0;
    const save = vi.fn(async () => undefined);
    refreshTokensMock.mockRejectedValue(
      Object.assign(new Error("Your refresh token has already been used to generate a new access token"), {
        statusCode: 401,
        context: { errorCode: "refresh_token_reused" }
      })
    );

    const result = await ensureFreshTokensWithLease(makeLeaseRepo(), {
      key: "test-reconcile-reused-token",
      load: async () => {
        loadCount += 1;
        return loadCount >= 3 ? newTokens : oldTokens;
      },
      save
    });

    expect(result).toEqual(newTokens);
    expect(refreshTokensMock).toHaveBeenCalledOnce();
    expect(refreshTokensMock).toHaveBeenCalledWith(oldTokens.refreshToken, oldTokens.idToken);
    expect(save).not.toHaveBeenCalled();
  });
});

function makeLease() {
  return { release: vi.fn(async () => undefined) };
}

function makeLeaseRepo(
  acquire: () => Promise<{ release: () => Promise<void> }> = async () => makeLease()
) {
  return {
    tryAcquireSchedulerLease: vi.fn(acquire)
  };
}

function makeTokens(marker: string, expirySeconds: number): CodexTokens {
  const exp = Math.floor(Date.now() / 1_000) + expirySeconds;
  return {
    idToken: makeJwt(`${marker}-id`, exp),
    accessToken: makeJwt(`${marker}-access`, exp),
    refreshToken: `${marker}-refresh`,
    accountId: `account-${marker}`
  };
}

function makeJwt(marker: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ marker, exp }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}
