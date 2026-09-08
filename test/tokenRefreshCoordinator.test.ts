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

import { ensureFreshTokensWithLease } from "../src/auth/tokenRefreshCoordinator";

describe("token refresh coordinator", () => {
  beforeEach(() => {
    refreshTokensMock.mockReset();
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
