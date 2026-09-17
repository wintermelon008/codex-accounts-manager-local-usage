import { isTokenExpired } from "../../utils/jwt";
import { CodexAccountRecord, CodexTokens, isSub2ApiAccount } from "../../core/types";
import {
  readAvailability,
  readRenewal,
  readRenewalAvailability,
  restoreAccountRenewalEvidence,
  type AvailabilityKind,
  type RenewalKind
} from "./accountState";
import type {
  AccountAutomationState,
  TokenAutomationSnapshot
} from "../../presentation/workbench/tokenAutomationState";
import type { AccountHealthKind } from "../../domain/accountHealth";

export type { AccountHealthKind } from "../../domain/accountHealth";

export type AccountHealthInfo = {
  kind: AccountHealthKind;
  issueKey: string;
  message?: string;
  availability?: AvailabilityKind;
  renewal?: RenewalKind;
  observedAt?: number;
};

export type AccountHealthSignals = {
  mailboxDeactivated?: boolean;
};

type QuotaAvailabilitySignal = "allowed";

export function resolveAccountHealth(
  account: CodexAccountRecord,
  tokens: CodexTokens | undefined,
  automation: TokenAutomationSnapshot,
  signals: AccountHealthSignals = {}
): AccountHealthInfo {
  if (isSub2ApiAccount(account)) {
    return { kind: "healthy", issueKey: "virtual" };
  }
  if (signals.mailboxDeactivated === true) {
    return {
      kind: "disabled",
      issueKey: "disabled:mailbox_deactivated",
      message: "The linked mailbox received an OpenAI account deactivation notice"
    };
  }

  restoreAccountRenewalEvidence(account, tokens);
  const accountId = account.accountId ?? tokens?.accountId;
  const renewal = readRenewal(account.id, tokens) ?? "unknown";
  const renewalAvailability = readRenewalAvailability(account.id, accountId, tokens);
  let availability = readAvailability(account.id, accountId, tokens);
  const quotaSignal = resolveQuotaAvailabilitySignal(account);
  const quotaObservedAt = account.lastQuotaAt;

  // A persisted runtime quota observation remains conservative until a newer
  // quota response explicitly says the account is allowed again.
  if (
    quotaSignal === "allowed" &&
    availability.kind === "quota_limited" &&
    quotaObservedAt !== undefined &&
    (availability.observedAt === undefined || quotaObservedAt >= availability.observedAt)
  ) {
    availability = renewalAvailability;
  }

  const observedAt = availability.observedAt;
  if (
    availability.kind === "quota_limited" &&
    observedAt !== undefined &&
    [account.quotaSummary?.hourlyResetTime, account.quotaSummary?.weeklyResetTime].some(
      (resetAt) => typeof resetAt === "number" && resetAt * 1000 > observedAt && resetAt * 1000 <= Date.now()
    )
  ) {
    availability = readRenewalAvailability(account.id, account.accountId ?? tokens?.accountId, tokens);
  }
  let kind: AccountHealthKind;
  if (availability.kind === "auth_unavailable") kind = "access_token_invalid";
  else if (availability.kind === "quota_limited") kind = "quota";
  else if (renewal === "unavailable")
    kind = availability.kind === "usable" ? "refresh_unavailable" : "refresh_unavailable_unverified";
  else if (renewal === "network_failed") kind = "refresh_failed";
  else if (renewal === "refreshing") kind = "refreshing";
  else if (availability.kind === "unknown") kind = "unverified";
  else if (
    automation.enabled &&
    tokens?.accessToken &&
    tokens.refreshToken &&
    isAccessTokenExpired(tokens.accessToken, automation.skewSeconds || 300)
  )
    kind = "expiring";
  else kind = "healthy";
  return {
    kind,
    issueKey: `${kind}:${availability.observedAt ?? 0}:${renewal}`,
    availability: availability.kind,
    renewal,
    observedAt: availability.observedAt
  };
}

function resolveQuotaAvailabilitySignal(account: CodexAccountRecord): QuotaAvailabilitySignal | undefined {
  const quota = account.quotaSummary;
  if (
    !quota ||
    account.lastQuotaAt === undefined ||
    !Number.isFinite(account.lastQuotaAt) ||
    (quota.hourlyWindowPresent !== true && quota.weeklyWindowPresent !== true)
  ) {
    return undefined;
  }

  const raw = asRecord(quota.rawData);
  const rateLimit = asRecord(raw?.["rate_limit"] ?? raw?.["rateLimit"]);
  if (!rateLimit) {
    return undefined;
  }

  const allowed = rateLimit["allowed"];
  const limitReached = rateLimit["limit_reached"] ?? rateLimit["limitReached"];
  if (allowed === true && limitReached === false) {
    return "allowed";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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
