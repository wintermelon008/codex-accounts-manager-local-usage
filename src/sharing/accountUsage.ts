import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { AccountUsagePackage } from "./types";

export const ACCOUNT_USAGE_STATE_SCHEMA = "codex-account-shared-usage/v1" as const;
export const ACCOUNT_USAGE_STATE_FILE_NAME = "shared-account-usage-v1.json" as const;

export type AccountUsageState = {
  schema: typeof ACCOUNT_USAGE_STATE_SCHEMA;
  pendingRequests: AccountUsagePendingRequest[];
  sources: AccountUsageSource[];
};

export type AccountUsagePendingRequest = {
  requestId: string;
  syncId: string;
  createdAt: number;
  expiresAt: number;
};

export type AccountUsageSource = {
  syncId: string;
  sourceUserId: string;
  sourceDisplayName?: string;
  revision: number;
  calculatedAt?: number;
  receivedAt: number;
  accounts: AccountUsagePackage["accounts"];
};

export function createEmptyAccountUsageState(): AccountUsageState {
  return {
    schema: ACCOUNT_USAGE_STATE_SCHEMA,
    pendingRequests: [],
    sources: []
  };
}

export async function readAccountUsageState(privateRoot: string): Promise<AccountUsageState> {
  try {
    const parsed = JSON.parse(await readFile(getAccountUsageStatePath(privateRoot), "utf8")) as unknown;
    return normalizeAccountUsageState(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[codexAccounts] shared account usage cache ignored", error);
    }
    return createEmptyAccountUsageState();
  }
}

export async function writeAccountUsageState(privateRoot: string, state: AccountUsageState): Promise<void> {
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const target = getAccountUsageStatePath(privateRoot);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(normalizeAccountUsageState(state))}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function getAccountUsageStatePath(privateRoot: string): string {
  return path.join(privateRoot, ACCOUNT_USAGE_STATE_FILE_NAME);
}

function normalizeAccountUsageState(value: unknown): AccountUsageState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptyAccountUsageState();
  }
  const candidate = value as Partial<AccountUsageState>;
  if (candidate.schema !== ACCOUNT_USAGE_STATE_SCHEMA) {
    return createEmptyAccountUsageState();
  }
  return {
    schema: ACCOUNT_USAGE_STATE_SCHEMA,
    pendingRequests: Array.isArray(candidate.pendingRequests)
      ? candidate.pendingRequests.filter(isPendingRequest).slice(-64)
      : [],
    sources: Array.isArray(candidate.sources) ? candidate.sources.filter(isUsageSource).slice(-64) : []
  };
}

function isPendingRequest(value: unknown): value is AccountUsagePendingRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<AccountUsagePendingRequest>;
  return Boolean(
    typeof candidate.requestId === "string" &&
    typeof candidate.syncId === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.expiresAt === "number"
  );
}

function isUsageSource(value: unknown): value is AccountUsageSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<AccountUsageSource>;
  return Boolean(
    typeof candidate.syncId === "string" &&
    typeof candidate.sourceUserId === "string" &&
    (candidate.sourceDisplayName === undefined || typeof candidate.sourceDisplayName === "string") &&
    Number.isSafeInteger(candidate.revision) &&
    (candidate.calculatedAt === undefined || typeof candidate.calculatedAt === "number") &&
    typeof candidate.receivedAt === "number" &&
    Array.isArray(candidate.accounts) &&
    candidate.accounts.every(isUsageAccount)
  );
}

function isUsageAccount(value: unknown): value is AccountUsageSource["accounts"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<AccountUsageSource["accounts"][number]>;
  return typeof candidate.accountId === "string" && candidate.accountId.trim().length > 0;
}
