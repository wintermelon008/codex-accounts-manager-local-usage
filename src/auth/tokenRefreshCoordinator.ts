import type { CodexTokens } from "../core/types";
import { needsTokenRefresh, refreshTokens } from "./oauth";

const TOKEN_REFRESH_LEASE_MS = 60_000;
const TOKEN_REFRESH_LEASE_WAIT_MS = 5_000;

export type TokenRefreshLease = {
  release(): Promise<void>;
};

export type TokenRefreshLeaseRepository = {
  tryAcquireSchedulerLease(
    name: string,
    leaseMs: number,
    waitTimeoutMs?: number
  ): Promise<TokenRefreshLease | undefined>;
};

export type TokenRefreshAccountRepository = TokenRefreshLeaseRepository & {
  getTokens(
    accountId: string,
    options?: { syncExternal?: boolean; forceReload?: boolean }
  ): Promise<CodexTokens | undefined>;
  updateTokens(
    accountId: string,
    tokens: CodexTokens,
    options?: { notifyTokenChange?: boolean }
  ): Promise<unknown>;
};

type CoordinatedTokenSource = {
  key: string;
  load(): Promise<CodexTokens | undefined>;
  save(tokens: CodexTokens): Promise<void>;
  fallbackTokens?: CodexTokens;
  /** Refresh a still-valid token after an authenticated endpoint rejects it. */
  forceRefresh?: boolean;
};

const inFlightRefreshes = new Map<string, Promise<CodexTokens | undefined>>();

/**
 * Read the latest account tokens and refresh them through a per-account
 * cross-host lease. The second read after acquiring the lease is intentional:
 * another VS Code window may have completed the rotation while this caller was
 * waiting.
 */
export function ensureFreshAccountTokens(
  repo: TokenRefreshAccountRepository,
  accountId: string,
  options: {
    fallbackTokens?: CodexTokens;
    notifyTokenChange?: boolean;
    providerAccountId?: string;
    forceRefresh?: boolean;
  } = {}
): Promise<CodexTokens | undefined> {
  return ensureFreshTokensWithLease(repo, {
    key: `account:${accountId}`,
    fallbackTokens: options.fallbackTokens,
    forceRefresh: options.forceRefresh,
    load: async () => {
      const current = await repo.getTokens(accountId, { forceReload: true });
      if (!current) {
        return options.fallbackTokens;
      }
      return {
        ...current,
        accountId: current.accountId ?? options.providerAccountId ?? options.fallbackTokens?.accountId
      };
    },
    save: async (tokens) => {
      await repo.updateTokens(accountId, tokens, { notifyTokenChange: options.notifyTokenChange });
    }
  });
}

/**
 * Shared implementation for managed accounts and the temporary global
 * auth.json rollback snapshot used by the hot-switch runtime.
 */
export function ensureFreshTokensWithLease(
  repo: TokenRefreshLeaseRepository,
  source: CoordinatedTokenSource
): Promise<CodexTokens | undefined> {
  const existing = inFlightRefreshes.get(source.key);
  if (existing) {
    return existing;
  }

  const operation = refreshTokensWithLease(repo, source);
  const taskRef: { current?: Promise<CodexTokens | undefined> } = {};
  const clearInFlight = (): void => {
    if (inFlightRefreshes.get(source.key) === taskRef.current) {
      inFlightRefreshes.delete(source.key);
    }
  };
  const task = operation.then(
    (result) => {
      clearInFlight();
      return result;
    },
    (error: unknown) => {
      clearInFlight();
      throw error;
    }
  );
  taskRef.current = task;
  inFlightRefreshes.set(source.key, task);
  return task;
}

async function refreshTokensWithLease(
  repo: TokenRefreshLeaseRepository,
  source: CoordinatedTokenSource
): Promise<CodexTokens | undefined> {
  const initial = (await source.load()) ?? source.fallbackTokens;
  if (!initial?.accessToken || (!source.forceRefresh && !needsTokenRefresh(initial))) {
    return initial;
  }

  if (!initial.refreshToken) {
    throw new Error("Token expired and no refresh token is available");
  }

  const lease = await repo.tryAcquireSchedulerLease(
    `token-refresh-${source.key}`,
    TOKEN_REFRESH_LEASE_MS,
    TOKEN_REFRESH_LEASE_WAIT_MS
  );
  if (!lease) {
    const afterWait = (await source.load()) ?? source.fallbackTokens;
    if (
      afterWait &&
      !needsTokenRefresh(afterWait) &&
      (!source.forceRefresh || !initial || hasCredentialChanged(initial, afterWait))
    ) {
      return afterWait;
    }
    throw new TokenRefreshCoordinationError();
  }

  try {
    const current = (await source.load()) ?? source.fallbackTokens;
    const refreshedByAnotherProcess = Boolean(initial && current && hasCredentialChanged(initial, current));
    if (
      !current?.accessToken ||
      (!needsTokenRefresh(current) && (!source.forceRefresh || refreshedByAnotherProcess))
    ) {
      return current;
    }

    if (!current.refreshToken) {
      throw new Error("Token expired and no refresh token is available");
    }

    try {
      const refreshed = await refreshTokens(current.refreshToken, current.idToken);
      const effectiveTokens: CodexTokens = {
        ...refreshed,
        accountId: refreshed.accountId ?? current.accountId
      };
      await source.save(effectiveTokens);
      return effectiveTokens;
    } catch (error) {
      if (!isRefreshTokenReusedError(error)) {
        throw error;
      }

      // A refresh performed outside this coordinator may have rotated the
      // token. Adopt a newly persisted pair once, but never replay the same
      // refresh token blindly.
      const reconciled = await source.load();
      if (reconciled && hasCredentialChanged(current, reconciled)) {
        return reconciled;
      }
      throw error;
    }
  } finally {
    await lease.release();
  }
}

export class TokenRefreshCoordinationError extends Error {
  constructor() {
    super("Another process is refreshing this account token; try again shortly");
    this.name = "TokenRefreshCoordinationError";
  }
}

function hasCredentialChanged(previous: CodexTokens, next: CodexTokens): boolean {
  return (
    previous.idToken !== next.idToken ||
    previous.accessToken !== next.accessToken ||
    previous.refreshToken !== next.refreshToken ||
    previous.accountId !== next.accountId
  );
}

function isRefreshTokenReusedError(error: unknown): boolean {
  const candidate = error as {
    context?: Record<string, unknown>;
    message?: unknown;
  };
  const errorCode = candidate.context?.["errorCode"] ?? candidate.context?.["code"];
  if (errorCode === "refresh_token_reused") {
    return true;
  }

  const message = typeof candidate.message === "string" ? candidate.message : String(error);
  return /refresh_token_reused|refresh token[^.]*already been used/i.test(message);
}
