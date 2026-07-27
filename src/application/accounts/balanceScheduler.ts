import type { CodexAccountRecord, SeamlessQuotaBandSize, SeamlessSwitchThreshold } from "../../core/types";

export const QUOTA_BAND_SIZE = 20;
export const BALANCE_QUOTA_MAX_AGE_MS = 15 * 60 * 1000;
export const DEFAULT_SEAMLESS_SWITCH_THRESHOLD = 3;
// The ordinary band scheduler can tolerate a longer cache lifetime. A Free
// account that is about to hit the selected switching threshold cannot: with
// one-minute refresh enabled, keep the Free-peer choice within two refresh
// intervals.
export const FREE_SWITCH_THRESHOLD_QUOTA_MAX_AGE_MS = 2 * 60 * 1000;

export type BalanceQuotaCapability = "windowed" | "reserve" | "unknown";

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
  switchThreshold?: SeamlessSwitchThreshold;
  thresholdQuota?: "hourly" | "weekly";
  forceRecoveryMode?: boolean;
  /**
   * A Free/K12 source has a shorter safety window for another Free/K12 target.
   * Reserve accounts remain eligible, but their quota must be freshly observed.
   */
  requireFreshFreeCandidates?: boolean;
  lastSelectedAt: Readonly<Record<string, number | undefined>>;
  now?: number;
}): CodexAccountRecord | undefined {
  const now = params.now ?? Date.now();
  const active = params.accounts.find((account) => account.id === params.activeAccountId);
  if (!active || active.isHidden) {
    return undefined;
  }

  const activeCapability = getBalanceQuotaCapability(active, now);
  if (activeCapability === "unknown") {
    return undefined;
  }

  const switchThreshold = params.switchThreshold ?? DEFAULT_SEAMLESS_SWITCH_THRESHOLD;
  const candidates = params.accounts.filter(
    (account) =>
      account.id !== params.activeAccountId &&
      !account.isHidden &&
      account.balancePoolEnabled === true &&
      getBalanceQuotaCapability(account, now) !== "unknown" &&
      (!params.requireFreshFreeCandidates ||
        !isFreePlanType(account.planType) ||
        hasFreshFreeSwitchThresholdQuota(account, now)) &&
      account.quotaSummary!.weeklyPercentage > switchThreshold
  );
  const windowedCandidates = candidates.filter((account) => getBalanceQuotaCapability(account, now) === "windowed");
  const reserveCandidates = candidates.filter((account) => getBalanceQuotaCapability(account, now) === "reserve");
  const activeQuota = active.quotaSummary!;
  const activeAtSwitchThreshold =
    activeCapability === "windowed"
      ? activeQuota.hourlyPercentage <= switchThreshold
      : activeQuota.weeklyPercentage <= switchThreshold;
  if (activeCapability === "reserve" && !activeAtSwitchThreshold && !params.thresholdQuota) {
    return undefined;
  }
  const thresholdRecoveryMode =
    activeCapability === "reserve" ||
    activeAtSwitchThreshold ||
    params.thresholdQuota === "weekly" ||
    params.forceRecoveryMode === true;

  if (thresholdRecoveryMode) {
    const recoveredWindowed = windowedCandidates
      .filter((account) => account.quotaSummary!.hourlyPercentage > switchThreshold)
      .sort((left, right) => compareBalanceCandidates(left, right, params.lastSelectedAt, params.quotaBandSize))[0];
    if (recoveredWindowed) {
      return recoveredWindowed;
    }

    const reserve = reserveCandidates.sort((left, right) =>
      compareReserveCandidates(left, right, params.lastSelectedAt)
    )[0];
    if (reserve) {
      return reserve;
    }

    return undefined;
  }

  if (activeCapability !== "windowed") {
    return undefined;
  }

  return windowedCandidates
    .filter(
      (account) =>
        getFiveHourQuotaBand(account.quotaSummary!.hourlyPercentage, params.quotaBandSize) >= params.activeBand &&
        account.quotaSummary!.hourlyPercentage > activeQuota.hourlyPercentage
    )
    .sort((left, right) => compareBalanceCandidates(left, right, params.lastSelectedAt, params.quotaBandSize))[0];
}

export function isVerifiedFreeWindowedAccount(account: CodexAccountRecord, now = Date.now()): boolean {
  return getBalanceQuotaCapability(account, now) === "windowed" && isFreePlanType(account.planType);
}

export function isFreePlanType(planType: string | undefined): boolean {
  const normalized = planType
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
  return (
    normalized === "free" ||
    normalized === "freeplan" ||
    normalized === "chatgptfree" ||
    normalized === "chatgptfreeplan" ||
    normalized === "k12" ||
    normalized === "k12plan" ||
    normalized === "chatgptk12" ||
    normalized === "chatgptk12plan"
  );
}

export function getBalanceQuotaCapability(account: CodexAccountRecord, now = Date.now()): BalanceQuotaCapability {
  if (
    account.quotaError ||
    typeof account.lastQuotaAt !== "number" ||
    Math.abs(now - account.lastQuotaAt) > BALANCE_QUOTA_MAX_AGE_MS ||
    !hasUsableWeeklyQuota(account)
  ) {
    return "unknown";
  }

  if (hasUsableFiveHourQuota(account)) {
    return "windowed";
  }
  return account.quotaSummary?.hourlyWindowPresent === false ? "reserve" : "unknown";
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

export function hasUsableWeeklyQuota(account: CodexAccountRecord): boolean {
  const quota = account.quotaSummary;
  return Boolean(
    quota?.weeklyWindowPresent &&
    typeof quota.weeklyPercentage === "number" &&
    Number.isFinite(quota.weeklyPercentage) &&
    quota.weeklyPercentage >= 0 &&
    quota.weeklyPercentage <= 100 &&
    typeof quota.weeklyWindowMinutes === "number" &&
    quota.weeklyWindowMinutes >= 1440
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

  const weeklyPercentageDifference = rightQuota.weeklyPercentage - leftQuota.weeklyPercentage;
  if (weeklyPercentageDifference !== 0) {
    return weeklyPercentageDifference;
  }

  const planPriorityDifference = getQuotaPlanPriority(left.planType) - getQuotaPlanPriority(right.planType);
  if (planPriorityDifference !== 0) {
    return planPriorityDifference;
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

function hasFreshFreeSwitchThresholdQuota(account: CodexAccountRecord, now: number): boolean {
  return (
    typeof account.lastQuotaAt === "number" &&
    Math.abs(now - account.lastQuotaAt) <= FREE_SWITCH_THRESHOLD_QUOTA_MAX_AGE_MS
  );
}

function compareReserveCandidates(
  left: CodexAccountRecord,
  right: CodexAccountRecord,
  lastSelectedAt: Readonly<Record<string, number | undefined>>
): number {
  const weeklyDifference = right.quotaSummary!.weeklyPercentage - left.quotaSummary!.weeklyPercentage;
  if (weeklyDifference !== 0) {
    return weeklyDifference;
  }

  const planPriorityDifference = getQuotaPlanPriority(left.planType) - getQuotaPlanPriority(right.planType);
  if (planPriorityDifference !== 0) {
    return planPriorityDifference;
  }

  const lastSelectedDifference = (lastSelectedAt[left.id] ?? 0) - (lastSelectedAt[right.id] ?? 0);
  if (lastSelectedDifference !== 0) {
    return lastSelectedDifference;
  }
  return left.id.localeCompare(right.id);
}

export function getQuotaPlanPriority(planType: string | undefined): number {
  if (isFreePlanType(planType)) {
    return 0;
  }

  const normalized = planType
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
  if (
    normalized === "plus" ||
    normalized === "plusplan" ||
    normalized === "chatgptplus" ||
    normalized === "chatgptplusplan"
  ) {
    return 1;
  }
  if (
    normalized === "pro" ||
    normalized === "proplan" ||
    normalized === "chatgptpro" ||
    normalized === "chatgptproplan"
  ) {
    return 2;
  }
  return 3;
}
