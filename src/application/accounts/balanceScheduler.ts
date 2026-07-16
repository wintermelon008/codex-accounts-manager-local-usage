import type { CodexAccountRecord } from "../../core/types";

export const QUOTA_BAND_SIZE = 20;
export const BALANCE_QUOTA_MAX_AGE_MS = 15 * 60 * 1000;

export function getFiveHourQuotaBand(percentage: number): number {
  if (!Number.isFinite(percentage) || percentage <= 0) {
    return 0;
  }
  return Math.ceil(Math.min(100, percentage) / QUOTA_BAND_SIZE);
}

export function didQuotaBandDrop(previousBand: number | undefined, currentBand: number): boolean {
  return previousBand !== undefined && currentBand < previousBand;
}

export function selectBalanceCandidate(params: {
  accounts: CodexAccountRecord[];
  activeAccountId: string;
  activeBand: number;
  lastSelectedAt: Readonly<Record<string, number | undefined>>;
  now?: number;
}): CodexAccountRecord | undefined {
  const now = params.now ?? Date.now();
  return params.accounts
    .filter((account) => {
      const quota = account.quotaSummary;
      return (
        account.id !== params.activeAccountId &&
        account.balancePoolEnabled === true &&
        !account.quotaError &&
        hasUsableFiveHourQuota(account) &&
        getFiveHourQuotaBand(quota!.hourlyPercentage) >= params.activeBand &&
        typeof account.lastQuotaAt === "number" &&
        Math.abs(now - account.lastQuotaAt) <= BALANCE_QUOTA_MAX_AGE_MS
      );
    })
    .sort((left, right) => compareBalanceCandidates(left, right, params.lastSelectedAt))[0];
}

export function hasUsableFiveHourQuota(account: CodexAccountRecord): boolean {
  const quota = account.quotaSummary;
  return Boolean(
    quota?.hourlyWindowPresent &&
    typeof quota.hourlyPercentage === "number" &&
    Number.isFinite(quota.hourlyPercentage) &&
    quota.hourlyPercentage >= 0 &&
    quota.hourlyPercentage <= 100 &&
    typeof quota.hourlyWindowMinutes === "number" &&
    quota.hourlyWindowMinutes > 0 &&
    quota.hourlyWindowMinutes <= 360
  );
}

function compareBalanceCandidates(
  left: CodexAccountRecord,
  right: CodexAccountRecord,
  lastSelectedAt: Readonly<Record<string, number | undefined>>
): number {
  const leftQuota = left.quotaSummary!;
  const rightQuota = right.quotaSummary!;
  const bandDifference =
    getFiveHourQuotaBand(rightQuota.hourlyPercentage) - getFiveHourQuotaBand(leftQuota.hourlyPercentage);
  if (bandDifference !== 0) {
    return bandDifference;
  }

  const percentageDifference = rightQuota.hourlyPercentage - leftQuota.hourlyPercentage;
  if (percentageDifference !== 0) {
    return percentageDifference;
  }

  const leftReset = leftQuota.hourlyResetTime ?? Number.POSITIVE_INFINITY;
  const rightReset = rightQuota.hourlyResetTime ?? Number.POSITIVE_INFINITY;
  if (leftReset !== rightReset) {
    return leftReset - rightReset;
  }

  const lastSelectedDifference = (lastSelectedAt[left.id] ?? 0) - (lastSelectedAt[right.id] ?? 0);
  if (lastSelectedDifference !== 0) {
    return lastSelectedDifference;
  }
  return left.id.localeCompare(right.id);
}
