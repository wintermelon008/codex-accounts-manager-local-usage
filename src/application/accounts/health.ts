import { isTokenExpired } from "../../utils/jwt";
import { CodexAccountRecord, CodexTokens, isSub2ApiAccount } from "../../core/types";
import { getQuotaIssueKind } from "../../utils/quotaIssue";
import type { AccountAutomationState, TokenAutomationSnapshot } from "../../presentation/workbench/tokenAutomationState";

export type AccountHealthKind = "healthy" | "expiring" | "refresh_failed" | "reauthorize" | "disabled" | "quota";

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
  if (quotaIssueKind === "auth" || automationState?.errorKind === "reauthorize" || isAuthLikeMessage(automationError)) {
    return {
      kind: "reauthorize",
      issueKey: buildIssueKey("reauthorize", account.quotaError?.code, account.quotaError?.message, automationError),
      message: automationError ?? account.quotaError?.message
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
      kind: "refresh_failed",
      issueKey: buildIssueKey("refresh_failed", undefined, automationError),
      message: automationError
    };
  }

  if (!tokens?.idToken || !tokens.accessToken) {
    return {
      kind: "reauthorize",
      issueKey: "reauthorize:credentials_missing",
      message: "Codex OAuth credentials are missing"
    };
  }

  if (
    automation.enabled &&
    tokens?.accessToken &&
    tokens.refreshToken &&
    isTokenExpired(tokens.accessToken, automation.skewSeconds || 600)
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

function isAuthLikeMessage(message?: string): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("401") ||
    normalized.includes("unauthorized") ||
    normalized.includes("token expired") ||
    normalized.includes("token invalid") ||
    normalized.includes("refresh token") ||
    normalized.includes("invalid_grant") ||
    normalized.includes("oauth") ||
    normalized.includes("authorization")
  );
}

function buildIssueKey(kind: AccountHealthKind, ...parts: Array<string | undefined>): string {
  return [kind, ...parts.filter((value): value is string => Boolean(value?.trim()))].join(":");
}
