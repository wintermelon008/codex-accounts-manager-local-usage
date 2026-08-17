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
    } catch {
      await repo.setBalancePoolMembership(account.id, false).catch(() => undefined);
      refreshFailed += 1;
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
    importFailed
  };
}
