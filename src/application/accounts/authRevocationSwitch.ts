import { isAutomaticAccount, type CodexAccountRecord } from "../../core/types";
import { getDashboardAccountOrder } from "../../presentation/dashboard/accountOrder";

type AuthRevocationConfiguration = {
  get<T>(section: string, defaultValue?: T): T;
};

const GROUP_A_VISIBLE = "seamlessSwitchGroupAVisible";
const GROUP_B_VISIBLE = "seamlessSwitchGroupBVisible";
const GROUP_C_VISIBLE = "seamlessSwitchGroupCVisible";

/**
 * Token revocation is an identity failure, so candidate selection must not
 * depend on possibly stale quota snapshots. It still respects the existing
 * seamless-switch pool, visibility groups, and Dashboard ordering.
 */
export function selectAuthRevocationCandidates(
  accounts: readonly CodexAccountRecord[],
  activeAccountId: string,
  configuration: AuthRevocationConfiguration,
  accountOrder: readonly string[] | undefined = getDashboardAccountOrder(),
  excludedAccountIds: ReadonlySet<string> = new Set()
): CodexAccountRecord[] {
  const fallbackOrder = new Map(accounts.map((account, index) => [account.id, index]));
  const visibleOrder = new Map((accountOrder ?? []).map((accountId, index) => [accountId, index]));
  const orderOf = (account: CodexAccountRecord): number =>
    visibleOrder.get(account.id) ?? (accountOrder?.length ?? 0) + (fallbackOrder.get(account.id) ?? accounts.length);

  return accounts
    .filter(
      (account) =>
        account.id !== activeAccountId &&
        !excludedAccountIds.has(account.id) &&
        !account.isHidden &&
        isAutomaticAccount(account) &&
        account.balancePoolEnabled === true &&
        isVisibleGroup(account, configuration)
    )
    .slice()
    .sort((left, right) => orderOf(left) - orderOf(right) || left.id.localeCompare(right.id));
}

function isVisibleGroup(account: CodexAccountRecord, configuration: AuthRevocationConfiguration): boolean {
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
