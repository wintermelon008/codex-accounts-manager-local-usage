import { needsRefresh } from "../../auth/oauth";
import { ensureFreshAccountTokens, type TokenRefreshAccountRepository } from "../../auth/tokenRefreshCoordinator";
import { APIError } from "../../core/errors";
import type { CodexTokens } from "../../core/types";

/** Execute one account-scoped request with token preflight and a single 401 retry. */
export async function runAuthenticatedAccountRequest<T>(
  repo: TokenRefreshAccountRepository,
  accountId: string,
  request: (tokens: CodexTokens) => Promise<T>,
  initialTokens?: CodexTokens
): Promise<T> {
  const storedTokens = initialTokens ?? (await repo.getTokens(accountId));
  if (!storedTokens?.accessToken) {
    throw new Error("No access token available");
  }

  let effectiveTokens = storedTokens;
  if (!initialTokens && storedTokens.refreshToken && needsRefresh(storedTokens.accessToken)) {
    effectiveTokens = await refreshAndPersistTokens(repo, accountId, storedTokens);
  }

  try {
    return await request(effectiveTokens);
  } catch (error) {
    if (!isUnauthorized(error) || !effectiveTokens.refreshToken) {
      throw error;
    }

    const refreshedTokens = await refreshAndPersistTokens(repo, accountId, effectiveTokens, true);
    return request(refreshedTokens);
  }
}

async function refreshAndPersistTokens(
  repo: TokenRefreshAccountRepository,
  accountId: string,
  tokens: CodexTokens,
  forceRefresh = false
): Promise<CodexTokens> {
  if (!tokens.refreshToken) {
    return tokens;
  }

  const refreshed = await ensureFreshAccountTokens(repo, accountId, {
    fallbackTokens: tokens,
    providerAccountId: tokens.accountId,
    forceRefresh
  });
  if (!refreshed?.accessToken) {
    throw new Error("No access token available after refresh");
  }
  return refreshed;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof APIError && error.statusCode === 401;
}
