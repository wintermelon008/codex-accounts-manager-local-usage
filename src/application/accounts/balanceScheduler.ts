import type { CodexAccountRecord, SeamlessQuotaBandSize, SeamlessReserveThreshold } from "../../core/types";

export const QUOTA_BAND_SIZE = 20;
export const BALANCE_QUOTA_MAX_AGE_MS = 15 * 60 * 1000;
export const MINIMUM_BALANCE_CANDIDATE_WEEKLY_PERCENTAGE = 3;
export const FREE_EXHAUSTION_QUOTA_PERCENTAGE = 1;
// The ordinary band scheduler can tolerate a longer cache lifetime. A Free
// account that is about to hard-stop cannot: with one-minute refresh enabled,
// keep the emergency peer choice within two refresh intervals.
export const FREE_EXHAUSTION_QUOTA_MAX_AGE_MS = 2 * 60 * 1000;

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
  reserveThreshold?: SeamlessReserveThreshold;
  minimumHourlyPercentage?: number;
  emergencyQuota?: "hourly" | "weekly";
  forceRecoveryMode?: boolean;
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

  const reserveThreshold = params.reserveThreshold ?? MINIMUM_BALANCE_CANDIDATE_WEEKLY_PERCENTAGE;
  const candidates = params.accounts.filter(
    (account) =>
      account.id !== params.activeAccountId &&
      !account.isHidden &&
      account.balancePoolEnabled === true &&
      getBalanceQuotaCapability(account, now) !== "unknown" &&
      account.quotaSummary!.weeklyPercentage > reserveThreshold
  );
  const windowedCandidates = candidates.filter((account) => getBalanceQuotaCapability(account, now) === "windowed");
  const reserveCandidates = candidates.filter((account) => getBalanceQuotaCapability(account, now) === "reserve");
  const activeQuota = active.quotaSummary!;
  const activeAtReserveFloor =
    activeCapability === "windowed"
      ? activeQuota.hourlyPercentage <= reserveThreshold
      : activeQuota.weeklyPercentage <= reserveThreshold;
  if (activeCapability === "reserve" && !activeAtReserveFloor && !params.emergencyQuota) {
    return undefined;
  }
  const reserveRecoveryMode =
    activeCapability === "reserve" ||
    activeAtReserveFloor ||
    params.emergencyQuota === "weekly" ||
    params.forceRecoveryMode === true;

  if (reserveRecoveryMode) {
    const recoveredWindowed = windowedCandidates
      .filter((account) => account.quotaSummary!.hourlyPercentage > reserveThreshold)
      .sort((left, right) =>
        compareBalanceCandidates(left, right, params.lastSelectedAt, params.quotaBandSize, params.emergencyQuota)
      )[0];
    if (recoveredWindowed) {
      return recoveredWindowed;
    }

    const reserve = reserveCandidates.sort((left, right) =>
      compareReserveCandidates(left, right, params.lastSelectedAt)
    )[0];
    if (reserve) {
      return reserve;
    }

    const emergencyFloor = params.minimumHourlyPercentage;
    if (params.emergencyQuota && emergencyFloor !== undefined) {
      return windowedCandidates
        .filter((account) => account.quotaSummary!.hourlyPercentage > emergencyFloor)
        .sort((left, right) =>
          compareBalanceCandidates(left, right, params.lastSelectedAt, params.quotaBandSize, params.emergencyQuota)
        )[0];
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
        account.quotaSummary!.hourlyPercentage > activeQuota.hourlyPercentage &&
        (params.minimumHourlyPercentage === undefined ||
          account.quotaSummary!.hourlyPercentage > params.minimumHourlyPercentage)
    )
    .sort((left, right) =>
      compareBalanceCandidates(left, right, params.lastSelectedAt, params.quotaBandSize, params.emergencyQuota)
    )[0];
}

/**
 * Select a same-Free peer for the hard-stop path. Plan metadata alone is not
 * sufficient: both the source and target must still expose fresh, valid
 * five-hour and weekly windows. This keeps a stale/misreported plan label from
 * routing an emergency switch to an unusable account.
 */
export function selectFreeExhaustionCandidate(params: {
  accounts: CodexAccountRecord[];
  activeAccountId: string;
  reserveThreshold?: SeamlessReserveThreshold;
  lastSelectedAt: Readonly<Record<string, number | undefined>>;
  now?: number;
}): CodexAccountRecord | undefined {
  const now = params.now ?? Date.now();
  const active = params.accounts.find((account) => account.id === params.activeAccountId);
  if (!active || active.isHidden || !isVerifiedFreeWindowedAccount(active, now)) {
    return undefined;
  }

  const reserveThreshold = params.reserveThreshold ?? MINIMUM_BALANCE_CANDIDATE_WEEKLY_PERCENTAGE;
  return params.accounts
    .filter(
      (account) =>
        account.id !== active.id &&
        !account.isHidden &&
        account.balancePoolEnabled === true &&
        isVerifiedFreeWindowedAccount(account, now) &&
        hasFreshFreeExhaustionQuota(account, now) &&
        account.quotaSummary!.hourlyPercentage > FREE_EXHAUSTION_QUOTA_PERCENTAGE &&
        account.quotaSummary!.weeklyPercentage > reserveThreshold
    )
    .sort((left, right) => compareFreeExhaustionCandidates(left, right, params.lastSelectedAt))[0];
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
    normalized === "chatgptfreeplan"
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
  quotaBandSize: SeamlessQuotaBandSize = QUOTA_BAND_SIZE,
  emergencyQuota?: "hourly" | "weekly"
): number {
  const leftQuota = left.quotaSummary!;
  const rightQuota = right.quotaSummary!;
  if (emergencyQuota === "weekly") {
    const weeklyPercentageDifference = rightQuota.weeklyPercentage - leftQuota.weeklyPercentage;
    if (weeklyPercentageDifference !== 0) {
      return weeklyPercentageDifference;
    }
  }
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

function hasFreshFreeExhaustionQuota(account: CodexAccountRecord, now: number): boolean {
  return (
    typeof account.lastQuotaAt === "number" && Math.abs(now - account.lastQuotaAt) <= FREE_EXHAUSTION_QUOTA_MAX_AGE_MS
  );
}

function compareFreeExhaustionCandidates(
  left: CodexAccountRecord,
  right: CodexAccountRecord,
  lastSelectedAt: Readonly<Record<string, number | undefined>>
): number {
  const leftQuota = left.quotaSummary!;
  const rightQuota = right.quotaSummary!;
  const hourlyDifference = rightQuota.hourlyPercentage - leftQuota.hourlyPercentage;
  if (hourlyDifference !== 0) {
    return hourlyDifference;
  }

  const weeklyDifference = rightQuota.weeklyPercentage - leftQuota.weeklyPercentage;
  if (weeklyDifference !== 0) {
    return weeklyDifference;
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

function compareReserveCandidates(
  left: CodexAccountRecord,
  right: CodexAccountRecord,
  lastSelectedAt: Readonly<Record<string, number | undefined>>
): number {
  const weeklyDifference = right.quotaSummary!.weeklyPercentage - left.quotaSummary!.weeklyPercentage;
  if (weeklyDifference !== 0) {
    return weeklyDifference;
  }

  const lastSelectedDifference = (lastSelectedAt[left.id] ?? 0) - (lastSelectedAt[right.id] ?? 0);
  if (lastSelectedDifference !== 0) {
    return lastSelectedDifference;
  }
  return left.id.localeCompare(right.id);
}
