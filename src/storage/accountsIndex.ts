import * as fsSync from "fs";
import { createError } from "../core/errors";
import type { CodexAccountRecord, CodexAccountsIndex, CodexProviderRoute } from "../core/types";
import { normalizeQuotaSummary } from "../utils/quotaWindows";
import { normalizeAccountTags } from "./sharedAccounts";

export function markActive(index: CodexAccountsIndex, accountId: string): void {
  index.currentAccountId = accountId;
  index.currentProviderRoute = "chatgpt";
  index.currentProviderAccountId = accountId;
  for (const account of index.accounts) {
    account.isActive = account.id === accountId;
    account.providerActive = account.id === accountId;
  }
}

export function syncActiveAccountState(index: CodexAccountsIndex, accountId: string | undefined): boolean {
  // auth.json continues to represent the preserved OAuth account while a
  // virtual provider owns the live route. Do not let an auth watcher replace
  // currentAccountId or OAuth active flags during that period.
  if (index.currentProviderRoute === "sub2api") {
    return false;
  }
  const normalizedAccountId =
    accountId && index.accounts.some((account) => account.id === accountId) ? accountId : undefined;
  let changed = index.currentAccountId !== normalizedAccountId;
  index.currentAccountId = normalizedAccountId;

  for (const account of index.accounts) {
    const nextActive = account.id === normalizedAccountId;
    if (account.isActive !== nextActive) {
      account.isActive = nextActive;
      changed = true;
    }
  }

  index.currentProviderRoute = "chatgpt";
  index.currentProviderAccountId = normalizedAccountId;
  for (const account of index.accounts) {
    const nextProviderActive = account.id === normalizedAccountId;
    if (account.providerActive !== nextProviderActive) {
      account.providerActive = nextProviderActive;
      changed = true;
    }
  }

  return changed;
}

export function createEmptyIndex(): CodexAccountsIndex {
  return { currentProviderRoute: "chatgpt", accounts: [] };
}

export function cloneIndex(index: CodexAccountsIndex): CodexAccountsIndex {
  const normalized: CodexAccountsIndex = {
    currentAccountId: index?.currentAccountId,
    currentProviderRoute: normalizeProviderRoute(index?.currentProviderRoute),
    currentProviderAccountId: index?.currentProviderAccountId,
    accounts: Array.isArray(index?.accounts)
      ? index.accounts.map((account) => ({
          ...account,
          tags: normalizeAccountTags(account.tags),
          quotaSummary: normalizeQuotaSummary(account.quotaSummary)
        }))
      : []
  };

  return structuredClone(normalized);
}

export function parseAccountsIndex(raw: string, filePath: string): CodexAccountsIndex {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidAccountsIndex(parsed)) {
      throw new Error("Invalid accounts index structure");
    }

    return cloneIndex(parsed);
  } catch (cause) {
    throw createError.storageIndexCorrupted(filePath, cause);
  }
}

export function getBackupPath(indexPath: string, slot: number): string {
  return indexPath.replace(/\.json$/i, `.backup-${slot}.json`);
}

export function countAvailableBackupsSync(indexPath: string, backupCount: number): number {
  let count = 0;
  for (let slot = 1; slot <= backupCount; slot += 1) {
    if (fsSync.existsSync(getBackupPath(indexPath, slot))) {
      count += 1;
    }
  }

  return count;
}

export function readCurrentIndexForBackupSync(indexPath: string): string | undefined {
  try {
    const raw = fsSync.readFileSync(indexPath, "utf8");
    parseAccountsIndex(raw, indexPath);
    return raw;
  } catch (error) {
    return undefined;
  }
}

function isValidAccountsIndex(value: unknown): value is CodexAccountsIndex {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CodexAccountsIndex>;
  if (!Array.isArray(candidate.accounts)) {
    return false;
  }

  return candidate.accounts.every((account) => {
    if (!account || typeof account !== "object") {
      return false;
    }

    const record = account as Partial<CodexAccountRecord>;
    return (
      typeof record.id === "string" &&
      typeof record.email === "string" &&
      typeof record.createdAt === "number" &&
      typeof record.updatedAt === "number" &&
      (record.isHidden === undefined || typeof record.isHidden === "boolean") &&
      (record.accountGroup === undefined ||
        record.accountGroup === "A" ||
        record.accountGroup === "B" ||
        record.accountGroup === "C") &&
      (record.balancePoolEnabled === undefined || typeof record.balancePoolEnabled === "boolean") &&
      (record.accountKind === undefined || record.accountKind === "chatgpt" || record.accountKind === "sub2api") &&
      (record.manualOnly === undefined || typeof record.manualOnly === "boolean") &&
      (record.quotaMode === undefined || record.quotaMode === "chatgpt" || record.quotaMode === "none") &&
      (record.providerActive === undefined || typeof record.providerActive === "boolean") &&
      (record.virtualRoute === undefined || isValidVirtualRoute(record.virtualRoute)) &&
      (record.tags === undefined || (Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string")))
    );
  });
}

function normalizeProviderRoute(value: unknown): CodexProviderRoute {
  return value === "sub2api" ? "sub2api" : "chatgpt";
}

function isValidVirtualRoute(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const route = value as Record<string, unknown>;
  return ["integrationId", "baseUrl", "model", "credentialRef"].every(
    (key) => {
      const field = route[key];
      return typeof field === "string" && Boolean(field.trim());
    }
  );
}
