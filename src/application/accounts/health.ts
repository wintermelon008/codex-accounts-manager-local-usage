import { isTokenExpired } from "../../utils/jwt";
import { CodexAccountRecord, CodexTokens, isSub2ApiAccount } from "../../core/types";
import { getQuotaIssueKind } from "../../utils/quotaIssue";
import type { AccountAutomationState, TokenAutomationSnapshot } from "../../presentation/workbench/tokenAutomationState";
import type { AccountHealthKind } from "../../domain/accountHealth";

export type { AccountHealthKind } from "../../domain/accountHealth";

export type AccountHealthInfo = {
  kind: AccountHealthKind;
  issueKey: string;
  message?: string;
};

export function resolveAccountHealth(
  account: CodexAccountRecord,
  tokens: CodexTokens | undefined,
  automation: TokenAutomationSnapshot
): AccountHealthInfo {
  if (isSub2ApiAccount(account)) {
    return { kind: "healthy", issueKey: "virtual" };
  }
  const automationState = getAccountAutomationState(automation, account);
  const quotaIssueKind = getQuotaIssueKind(account.quotaError);
  if (quotaIssueKind === "disabled") {
    return {
      kind: "disabled",
      issueKey: buildIssueKey("disabled", account.quotaError?.code, account.quotaError?.message),
      message: account.quotaError?.message
    };
  }

  const automationError = automationState?.lastError;
  if (quotaIssueKind === "auth") {
    return {
      kind: "access_token_invalid",
      issueKey: buildIssueKey("access_token_invalid", account.quotaError?.code, account.quotaError?.message),
      message: account.quotaError?.message
    };
  }

  if (!tokens?.accessToken) {
    return {
      kind: "access_token_invalid",
      issueKey: "access_token_invalid:credentials_missing",
      message: "Codex access token is missing"
    };
  }

  if (isAccessTokenExpired(tokens.accessToken)) {
    return {
      kind: "access_token_invalid",
      issueKey: "access_token_invalid:credentials_expired",
      message: "Codex access token is expired"
    };
  }

  if (automationState?.errorKind === "reauthorize") {
    // A refresh failure does not prove that the account is unusable. The
    // current access token may still be valid (for example after another
    // host rotated the refresh token), so keep this as a distinct warning
    // until an actual API/auth check rejects the access token.
    return {
      kind: "refresh_unavailable",
      issueKey: buildIssueKey("refresh_unavailable", undefined, automationError),
      message: automationError
    };
  }

  if (quotaIssueKind === "quota") {
    return {
      kind: "quota",
      issueKey: buildIssueKey("quota", account.quotaError?.code, account.quotaError?.message),
      message: account.quotaError?.message
    };
  }

  if (automationError) {
    return {
      kind: automationState?.errorKind === "network" ? "refresh_failed" : "refresh_unavailable",
      issueKey: buildIssueKey(
        automationState?.errorKind === "network" ? "refresh_failed" : "refresh_unavailable",
        undefined,
        automationError
      ),
      message: automationError
    };
  }

  if (!tokens.idToken) {
    return {
      kind: "refresh_unavailable",
      issueKey: "refresh_unavailable:credentials_incomplete",
      message: "Codex OAuth id token is missing"
    };
  }

  if (
    automation.enabled &&
    tokens?.accessToken &&
    tokens.refreshToken &&
    isAccessTokenExpired(tokens.accessToken, automation.skewSeconds || 600)
  ) {
    return {
      kind: "expiring",
      issueKey: buildIssueKey("expiring", undefined, tokens.accountId ?? account.accountId),
      message: "Token is nearing expiration"
    };
  }

  return {
    kind: "healthy",
    issueKey: "healthy"
  };
}

export function isHealthDismissed(account: CodexAccountRecord, health: AccountHealthInfo): boolean {
  return Boolean(account.dismissedHealthIssueKey && account.dismissedHealthIssueKey === health.issueKey);
}

export function getAccountAutomationState(
  automation: TokenAutomationSnapshot,
  account: Pick<
    CodexAccountRecord,
    | "id"
    | "tokenRefreshLastAttemptAt"
    | "tokenRefreshLastSuccessAt"
    | "tokenRefreshLastError"
    | "tokenRefreshLastErrorAt"
    | "tokenRefreshLastErrorKind"
    | "tokenRefreshNextRetryAt"
  >
): AccountAutomationState | undefined {
  const runtime = automation.accounts[account.id];
  const persisted = {
    lastCheckAt: account.tokenRefreshLastAttemptAt,
    lastRefreshAt: account.tokenRefreshLastSuccessAt,
    lastError: account.tokenRefreshLastError,
    lastErrorAt: account.tokenRefreshLastErrorAt,
    errorKind: account.tokenRefreshLastErrorKind,
    nextRetryAt: account.tokenRefreshNextRetryAt
  } satisfies AccountAutomationState;

  if (!runtime && Object.values(persisted).every((value) => value === undefined)) {
    return undefined;
  }

  return {
    lastCheckAt: runtime?.lastCheckAt ?? persisted.lastCheckAt,
    lastRefreshAt: runtime?.lastRefreshAt ?? persisted.lastRefreshAt,
    lastError: hasRuntimeField(runtime, "lastError") ? runtime?.lastError : persisted.lastError,
    lastErrorAt: hasRuntimeField(runtime, "lastErrorAt") ? runtime?.lastErrorAt : persisted.lastErrorAt,
    errorKind: hasRuntimeField(runtime, "errorKind") ? runtime?.errorKind : persisted.errorKind,
    nextRetryAt: hasRuntimeField(runtime, "nextRetryAt") ? runtime?.nextRetryAt : persisted.nextRetryAt
  };
}

function hasRuntimeField(
  state: AccountAutomationState | undefined,
  field: keyof AccountAutomationState
): boolean {
  return state !== undefined && Object.prototype.hasOwnProperty.call(state, field);
}

function isAccessTokenExpired(token: string, skewSeconds = 0): boolean {
  try {
    return isTokenExpired(token, skewSeconds);
  } catch {
    // The provider may return a non-JWT bearer. Let the actual API check
    // decide whether it is usable instead of crashing health resolution.
    return false;
  }
}

function buildIssueKey(kind: AccountHealthKind, ...parts: Array<string | undefined>): string {
  return [kind, ...parts.filter((value): value is string => Boolean(value?.trim()))].join(":");
}
