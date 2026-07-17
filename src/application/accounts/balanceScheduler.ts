import type { CodexAccountRecord, SeamlessQuotaBandSize } from "../../core/types";

export const QUOTA_BAND_SIZE = 20;
export const BALANCE_QUOTA_MAX_AGE_MS = 15 * 60 * 1000;

export function getFiveHourQuotaBand(
  percentage: number,
  quotaBandSize: SeamlessQuotaBandSize = QUOTA_BAND_SIZE
): number {
  if (!Number.isFinite(percentage) || percentage <= 0) {
    return 0;
  }
  const bandCount = quotaBandSize === 33 ? 3 : 100 / quotaBandSize;
  return Math.ceil((Math.min(100, percentage) * bandCount) / 100);
}

export function didQuotaBandDrop(previousBand: number | undefined, currentBand: number): boolean {
  return previousBand !== undefined && currentBand < previousBand;
}

export function selectBalanceCandidate(params: {
  accounts: CodexAccountRecord[];
  activeAccountId: string;
  activeBand: number;
  quotaBandSize?: SeamlessQuotaBandSize;
  minimumHourlyPercentage?: number;
  lastSelectedAt: Readonly<Record<string, number | undefined>>;
  now?: number;
}): CodexAccountRecord | undefined {
  const now = params.now ?? Date.now();
  const active = params.accounts.find((account) => account.id === params.activeAccountId);
  if (!active || !hasUsableFiveHourQuota(active)) {
    return undefined;
  }
  const activeHourlyPercentage = active.quotaSummary!.hourlyPercentage;
  return params.accounts
    .filter((account) => {
      const quota = account.quotaSummary;
      return (
        account.id !== params.activeAccountId &&
        account.balancePoolEnabled === true &&
        !account.quotaError &&
        hasUsableFiveHourQuota(account) &&
        getFiveHourQuotaBand(quota!.hourlyPercentage, params.quotaBandSize) >= params.activeBand &&
        quota!.hourlyPercentage > activeHourlyPercentage &&
        (params.minimumHourlyPercentage === undefined || quota!.hourlyPercentage > params.minimumHourlyPercentage) &&
        typeof account.lastQuotaAt === "number" &&
        Math.abs(now - account.lastQuotaAt) <= BALANCE_QUOTA_MAX_AGE_MS
      );
    })
    .sort((left, right) => compareBalanceCandidates(left, right, params.lastSelectedAt, params.quotaBandSize))[0];
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
  lastSelectedAt: Readonly<Record<string, number | undefined>>,
  quotaBandSize: SeamlessQuotaBandSize = QUOTA_BAND_SIZE
): number {
  const leftQuota = left.quotaSummary!;
  const rightQuota = right.quotaSummary!;
  const bandDifference =
    getFiveHourQuotaBand(rightQuota.hourlyPercentage, quotaBandSize) -
    getFiveHourQuotaBand(leftQuota.hourlyPercentage, quotaBandSize);
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
