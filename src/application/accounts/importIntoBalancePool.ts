import { refreshImportedAccountQuota } from "./quota";
import { getBalanceQuotaCapability } from "./balanceScheduler";
import type { CodexAccountRecord, SharedCodexAccountJson } from "../../core/types";
import { getQuotaIssueKind } from "../../utils/quotaIssue";
import type { AccountsRepository } from "../../storage";

const MAX_BALANCE_POOL_IMPORT_ACCOUNTS = 50;

export type BalancePoolImportSummary = {
  status: "completed" | "partial" | "failed";
  total: number;
  imported: number;
  poolEnabled: number;
  refreshFailed: number;
  notEligible: number;
  authFailed: number;
  importFailed: number;
  accounts: BalancePoolAccountSummary[];
};

export type BalancePoolAccountSummary = {
  accountId?: string;
  email?: string;
  planType?: string;
  hourlyPercentage?: number;
  weeklyPercentage?: number;
  creditsBalance?: string;
  poolEnabled: boolean;
  status: "ready" | "refresh_failed" | "not_eligible" | "import_failed";
};

/**
 * Import credentials through the same quarantine and live-quota validation
 * path used by the private local inbox. Credentials are never selected into
 * the balance pool before a successful quota refresh proves eligibility.
 */
export async function importSharedAccountsIntoBalancePool(
  repo: AccountsRepository,
  input: SharedCodexAccountJson | SharedCodexAccountJson[]
): Promise<BalancePoolImportSummary> {
  const entries = Array.isArray(input) ? input : [input];
  if (entries.length === 0 || entries.length > MAX_BALANCE_POOL_IMPORT_ACCOUNTS) {
    throw new Error(`At most ${MAX_BALANCE_POOL_IMPORT_ACCOUNTS} accounts may be imported at once`);
  }

  let imported = 0;
  let poolEnabled = 0;
  let refreshFailed = 0;
  let notEligible = 0;
  let authFailed = 0;
  let importFailed = 0;
  const accounts: BalancePoolAccountSummary[] = [];

  for (const entry of entries) {
    let account: CodexAccountRecord;
    try {
      const accounts = await repo.importSharedAccountsForLocalInbox(entry);
      const importedAccount = accounts[0];
      if (!importedAccount) {
        throw new Error("empty import result");
      }
      account = importedAccount;
      imported += 1;
    } catch {
      importFailed += 1;
      accounts.push({
        accountId: readResultString(entry.account_id ?? entry.id),
        email: readResultString(entry.email),
        poolEnabled: false,
        status: "import_failed"
      });
      continue;
    }

    try {
      const refresh = await refreshImportedAccountQuota(repo, account.id);
      const updated = await repo.getAccount(account.id);
      const eligible = !refresh.error && updated ? getBalanceQuotaCapability(updated) !== "unknown" : false;
      await repo.setBalancePoolMembership(account.id, eligible);
      if (eligible) {
        poolEnabled += 1;
      } else if (refresh.error) {
        refreshFailed += 1;
        if (getQuotaIssueKind(refresh.error) === "auth") {
          authFailed += 1;
        }
      } else {
        notEligible += 1;
      }
      accounts.push(
        toAccountSummary(
          updated ?? account,
          eligible,
          refresh.error ? "refresh_failed" : eligible ? "ready" : "not_eligible",
          !refresh.error
        )
      );
    } catch {
      await repo.setBalancePoolMembership(account.id, false).catch(() => undefined);
      refreshFailed += 1;
      const updated = await repo.getAccount(account.id).catch(() => undefined);
      accounts.push(toAccountSummary(updated ?? account, false, "refresh_failed", false));
    }
  }

  return {
    status:
      imported === 0 ? "failed" : imported === entries.length && poolEnabled === imported ? "completed" : "partial",
    total: entries.length,
    imported,
    poolEnabled,
    refreshFailed,
    notEligible,
    authFailed,
    importFailed,
    accounts
  };
}

function toAccountSummary(
  account: CodexAccountRecord,
  poolEnabled: boolean,
  status: BalancePoolAccountSummary["status"],
  includeQuota: boolean
): BalancePoolAccountSummary {
  const quota = includeQuota ? account.quotaSummary : undefined;
  return {
    accountId: readResultString(account.id),
    email: readResultString(account.email),
    planType: readResultString(account.planType),
    hourlyPercentage: finiteNumber(quota?.hourlyPercentage),
    weeklyPercentage: finiteNumber(quota?.weeklyPercentage),
    creditsBalance: readResultString(quota?.credits?.balance),
    poolEnabled,
    status
  };
}

function finiteNumber(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function readResultString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : undefined;
}
