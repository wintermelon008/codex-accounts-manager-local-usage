import { isAutomaticAccount, type CodexAccountRecord } from "../../core/types";
import { getSeamlessSwitchThreshold } from "../../infrastructure/config/extensionSettings";
import { getBalanceQuotaCapability, getQuotaPlanPriority } from "./balanceScheduler";

type GatewayFallbackConfiguration = {
  get<T>(section: string, defaultValue?: T): T;
};

type GatewayFallbackCandidateSource = {
  listAccounts(): Promise<readonly CodexAccountRecord[]>;
  refreshQuota(accountId: string): Promise<void>;
};

export type FreshGatewayFallbackCandidateOptions = {
  /** Candidates already rejected by this one fallback transaction. */
  excludedAccountIds?: Set<string>;
  /** Candidates that completed the mandatory refresh in this transaction. */
  refreshedAccountIds?: Set<string>;
  now?: () => number;
};

const GROUP_A_VISIBLE = "seamlessSwitchGroupAVisible";
const GROUP_B_VISIBLE = "seamlessSwitchGroupBVisible";
const GROUP_C_VISIBLE = "seamlessSwitchGroupCVisible";

/**
 * A Gateway is a transport, not an OAuth account. It can only fail over to a
 * fresh, eligible ChatGPT Auth target and never enters normal source-account
 * scheduling.
 */
export function selectGatewayFallbackCandidates(
  accounts: readonly CodexAccountRecord[],
  configuration: GatewayFallbackConfiguration,
  now = Date.now()
): CodexAccountRecord[] {
  const switchThreshold = getSeamlessSwitchThreshold(configuration);
  return accounts
    .filter((account) => {
      if (
        !isAutomaticAccount(account) ||
        account.quotaMode === "none" ||
        account.isHidden ||
        account.balancePoolEnabled !== true ||
        !isGroupVisible(account, configuration)
      ) {
        return false;
      }
      const capability = getBalanceQuotaCapability(account, now);
      return capability !== "unknown" && account.quotaSummary!.weeklyPercentage > switchThreshold;
    })
    .slice()
    .sort((left, right) => compareFallbackCandidates(left, right, now));
}

/**
 * Force-refresh one leading candidate at a time, then re-rank from the latest
 * repository snapshot. A stale quota is never accepted as a fallback target.
 */
export async function selectFreshGatewayFallbackCandidate(
  source: GatewayFallbackCandidateSource,
  configuration: GatewayFallbackConfiguration,
  options: FreshGatewayFallbackCandidateOptions = {}
): Promise<CodexAccountRecord | undefined> {
  const excludedAccountIds = options.excludedAccountIds ?? new Set<string>();
  const refreshedAccountIds = options.refreshedAccountIds ?? new Set<string>();
  const now = options.now ?? Date.now;
  let accounts = await source.listAccounts();
  let remainingRefreshes = accounts.length;

  while (remainingRefreshes >= 0) {
    const candidate = selectGatewayFallbackCandidates(accounts, configuration, now()).find(
      (account) => !excludedAccountIds.has(account.id)
    );
    if (!candidate) {
      return undefined;
    }
    if (refreshedAccountIds.has(candidate.id)) {
      return candidate;
    }
    if (remainingRefreshes === 0) {
      return undefined;
    }

    refreshedAccountIds.add(candidate.id);
    remainingRefreshes -= 1;
    try {
      await source.refreshQuota(candidate.id);
    } catch {
      excludedAccountIds.add(candidate.id);
    }
    accounts = await source.listAccounts();
  }

  return undefined;
}

function isGroupVisible(account: CodexAccountRecord, configuration: GatewayFallbackConfiguration): boolean {
  switch (account.accountGroup) {
    case "A":
      return configuration.get<boolean>(GROUP_A_VISIBLE, true);
    case "B":
      return configuration.get<boolean>(GROUP_B_VISIBLE, true);
    case "C":
      return configuration.get<boolean>(GROUP_C_VISIBLE, true);
    default:
      return true;
  }
}

function compareFallbackCandidates(left: CodexAccountRecord, right: CodexAccountRecord, now: number): number {
  const leftCapability = getBalanceQuotaCapability(left, now);
  const rightCapability = getBalanceQuotaCapability(right, now);
  if (leftCapability !== rightCapability) {
    return leftCapability === "windowed" ? -1 : 1;
  }
  if (leftCapability === "windowed") {
    const hourlyDifference = right.quotaSummary!.hourlyPercentage - left.quotaSummary!.hourlyPercentage;
    if (hourlyDifference !== 0) {
      return hourlyDifference;
    }
  }
  const weeklyDifference = right.quotaSummary!.weeklyPercentage - left.quotaSummary!.weeklyPercentage;
  if (weeklyDifference !== 0) {
    return weeklyDifference;
  }
  const planPriorityDifference = getQuotaPlanPriority(left.planType) - getQuotaPlanPriority(right.planType);
  if (planPriorityDifference !== 0) {
    return planPriorityDifference;
  }
  return (right.lastQuotaAt ?? 0) - (left.lastQuotaAt ?? 0) || left.id.localeCompare(right.id);
}
