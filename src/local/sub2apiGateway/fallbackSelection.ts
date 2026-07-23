import type { CodexAccountRecord } from "../../core/types";
import { getSeamlessSwitchThreshold } from "../../infrastructure/config/extensionSettings";
import { getBalanceQuotaCapability } from "../../application/accounts/balanceScheduler";

type GatewayFallbackConfiguration = {
  get<T>(section: string, defaultValue?: T): T;
};

type GatewayFallbackCandidateSource = {
  listAccounts(): Promise<readonly CodexAccountRecord[]>;
  refreshQuota(accountId: string): Promise<void>;
};

type FreshGatewayFallbackCandidateOptions = {
  /**
   * Candidates that have already failed their runtime handoff or a mandatory
   * refresh during this one fallback transaction.
   */
  excludedAccountIds?: Set<string>;
  /**
   * A fallback target must have completed one forced refresh in this
   * transaction. Keeping this set outside the helper lets a later runtime
   * handoff failure move to the next candidate without refreshing a target
   * twice.
   */
  refreshedAccountIds?: Set<string>;
  now?: () => number;
};

const GROUP_A_VISIBLE = "seamlessSwitchGroupAVisible";
const GROUP_B_VISIBLE = "seamlessSwitchGroupBVisible";
const GROUP_C_VISIBLE = "seamlessSwitchGroupCVisible";

/**
 * The Sub2API route has no OAuth quota of its own, so it never enters the
 * normal source-account scheduler. This is a target-only selector: it accepts
 * only the existing fresh seamless pool and ranks a real five-hour window over
 * a reserve window before considering weekly headroom.
 */
export function selectSub2ApiGatewayFallbackCandidates(
  accounts: readonly CodexAccountRecord[],
  configuration: GatewayFallbackConfiguration,
  now = Date.now()
): CodexAccountRecord[] {
  const switchThreshold = getSeamlessSwitchThreshold(configuration);
  return accounts
    .filter((account) => {
      if (account.isHidden || account.balancePoolEnabled !== true || !isGroupVisible(account, configuration)) {
        return false;
      }
      const capability = getBalanceQuotaCapability(account, now);
      return capability !== "unknown" && account.quotaSummary!.weeklyPercentage > switchThreshold;
    })
    .slice()
    .sort((left, right) => compareFallbackCandidates(left, right, now));
}

/**
 * The normal seamless pool permits a bounded freshness cache. A Gateway
 * exhaustion signal is different: it is the last chance to avoid handing the
 * thread to an already-spent ChatGPT account. Force-refresh the best current
 * candidate, re-rank from the repository snapshot, and only return a target
 * that was refreshed during this fallback transaction.
 */
export async function selectFreshSub2ApiGatewayFallbackCandidate(
  source: GatewayFallbackCandidateSource,
  configuration: GatewayFallbackConfiguration,
  options: FreshGatewayFallbackCandidateOptions = {}
): Promise<CodexAccountRecord | undefined> {
  const excludedAccountIds = options.excludedAccountIds ?? new Set<string>();
  const refreshedAccountIds = options.refreshedAccountIds ?? new Set<string>();
  const now = options.now ?? Date.now;
  let accounts = await source.listAccounts();
  // Each pass forces at most one account. Bound the transaction to the
  // repository snapshot taken when the fallback starts, so a consistently
  // failing quota endpoint can never make the handoff loop indefinitely.
  let remainingRefreshes = accounts.length;

  // The final pass only re-ranks the freshly written snapshot and can return
  // the last refreshed target; it never starts another refresh.
  while (remainingRefreshes >= 0) {
    const candidates = selectSub2ApiGatewayFallbackCandidates(accounts, configuration, now()).filter(
      (account) => !excludedAccountIds.has(account.id)
    );
    const candidate = candidates[0];
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
      // A credential or refresh transport failure must not leave an old quota
      // snapshot eligible for this same Gateway fallback.
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
  return (right.lastQuotaAt ?? 0) - (left.lastQuotaAt ?? 0) || left.id.localeCompare(right.id);
}
