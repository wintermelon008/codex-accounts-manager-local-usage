import type { Sub2ApiGatewayConfig } from "./config";

const OBSERVER_TIMEOUT_MS = 8_000;
const ACCOUNT_PAGE_SIZE = 100;
const MAX_ACCOUNT_PAGES = 20;
const QUOTA_CONCURRENCY = 4;

type InventoryObserverConfig = NonNullable<Sub2ApiGatewayConfig["inventoryObserver"]>;

export type Sub2ApiGatewayInventoryPool = {
  accountCount: number;
  remainingUnits: number;
  capacityUnits: number;
  remainingPercent: number;
  earliestResetAt?: number;
};

export type Sub2ApiGatewayInventorySnapshot = {
  group: string;
  checkedAt: number;
  eligibleAccountCount: number;
  observedAccountCount: number;
  fiveHour?: Sub2ApiGatewayInventoryPool;
  weekly?: Sub2ApiGatewayInventoryPool;
};

type QuotaWindows = {
  primary?: ParsedQuotaWindow;
  secondary?: ParsedQuotaWindow;
};

type ParsedQuotaWindow = {
  usedPercent: number;
  resetAt?: number;
};

/**
 * Read only aggregate metadata from Sub2API's admin API.  This intentionally
 * never receives a downstream API key and never writes to Sub2API.  It does
 * not retain account IDs, names, or quota payloads after the aggregate is
 * returned.
 */
export async function fetchSub2ApiGatewayInventory(
  observer: InventoryObserverConfig,
  adminApiKey: string
): Promise<Sub2ApiGatewayInventorySnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OBSERVER_TIMEOUT_MS);
  try {
    const group = await resolveGroup(observer, adminApiKey, controller.signal);
    const accounts = await fetchGroupAccounts(observer, adminApiKey, controller.signal, group.id);
    const eligibleAccountIds = [...new Set(accounts.filter(isSchedulableAccount).map(readAccountId).filter(isDefined))];
    const quotas = await mapWithConcurrency(eligibleAccountIds, QUOTA_CONCURRENCY, async (accountId) => {
      try {
        const payload = await fetchAdminJson(
          observer,
          adminApiKey,
          `/api/v1/admin/openai/accounts/${encodeURIComponent(accountId)}/quota`,
          controller.signal
        );
        return parseQuotaWindows(payload);
      } catch {
        // A single temporarily unavailable upstream account must not turn into
        // a fabricated 0% pool.  It is represented by observedAccountCount.
        return undefined;
      }
    });
    const usableQuotas = quotas.filter(isDefined);
    if (eligibleAccountIds.length > 0 && usableQuotas.length === 0) {
      throw new Error("The Sub2API observer could not read an upstream account quota");
    }
    return {
      group: observer.group,
      checkedAt: Date.now(),
      eligibleAccountCount: eligibleAccountIds.length,
      observedAccountCount: usableQuotas.length,
      fiveHour: aggregateQuotaWindow(usableQuotas.map((quota) => quota.primary).filter(isDefined)),
      weekly: aggregateQuotaWindow(usableQuotas.map((quota) => quota.secondary).filter(isDefined))
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveGroup(
  observer: InventoryObserverConfig,
  adminApiKey: string,
  signal: AbortSignal
): Promise<{ id: string }> {
  const payload = await fetchAdminJson(observer, adminApiKey, "/api/v1/admin/groups/all?platform=openai", signal);
  const needle = observer.group.trim().toLowerCase();
  const group = unwrapArrays(payload).find((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return false;
    }
    const id = readIdentifier(record["id"]);
    const name = readString(record["name"]) ?? readString(record["group_name"]);
    return id?.toLowerCase() === needle || name?.toLowerCase() === needle;
  });
  const id = group && asRecord(group) ? readIdentifier(asRecord(group)?.["id"]) : undefined;
  if (!id) {
    throw new Error(`The configured Sub2API observer group '${observer.group}' was not found`);
  }
  return { id };
}

async function fetchGroupAccounts(
  observer: InventoryObserverConfig,
  adminApiKey: string,
  signal: AbortSignal,
  groupId: string
): Promise<unknown[]> {
  const first = await fetchAccountPage(observer, adminApiKey, signal, groupId, 1);
  const total = readTotal(first.payload);
  const pages = total === undefined ? 1 : Math.min(MAX_ACCOUNT_PAGES, Math.max(1, Math.ceil(total / ACCOUNT_PAGE_SIZE)));
  if (pages === 1) {
    return first.accounts;
  }
  const remaining = await Promise.all(
    Array.from({ length: pages - 1 }, (_, index) => fetchAccountPage(observer, adminApiKey, signal, groupId, index + 2))
  );
  return first.accounts.concat(...remaining.map((page) => page.accounts));
}

async function fetchAccountPage(
  observer: InventoryObserverConfig,
  adminApiKey: string,
  signal: AbortSignal,
  groupId: string,
  page: number
): Promise<{ payload: unknown; accounts: unknown[] }> {
  const params = new URLSearchParams({
    platform: "openai",
    group: groupId,
    page: String(page),
    page_size: String(ACCOUNT_PAGE_SIZE)
  });
  const payload = await fetchAdminJson(observer, adminApiKey, `/api/v1/admin/accounts?${params.toString()}`, signal);
  return { payload, accounts: unwrapArrays(payload) };
}

async function fetchAdminJson(
  observer: InventoryObserverConfig,
  adminApiKey: string,
  pathname: string,
  signal: AbortSignal
): Promise<unknown> {
  const url = new URL(pathname, `${observer.adminBaseUrl}/`);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-api-key": adminApiKey
    },
    signal
  });
  if (!response.ok) {
    throw new Error(`Sub2API observer returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Sub2API observer returned invalid JSON");
  }
}

function isSchedulableAccount(value: unknown): boolean {
  const record = asRecord(value);
  if (!record || !readAccountId(record)) {
    return false;
  }
  if (record["enabled"] === false || record["is_active"] === false || record["schedulable"] === false) {
    return false;
  }
  const status = (readString(record["status"]) ?? "").toLowerCase();
  return !["disabled", "inactive", "error", "deleted", "invalid"].includes(status);
}

function readAccountId(value: unknown): string | undefined {
  const record = asRecord(value);
  return record ? readIdentifier(record["id"]) : undefined;
}

function parseQuotaWindows(value: unknown): QuotaWindows {
  const rateLimit = findRateLimit(value);
  if (!rateLimit) {
    return {};
  }
  return {
    primary: parseQuotaWindow(rateLimit["primary_window"] ?? rateLimit["primaryWindow"]),
    secondary: parseQuotaWindow(rateLimit["secondary_window"] ?? rateLimit["secondaryWindow"])
  };
}

function findRateLimit(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4) {
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const direct = asRecord(record["rate_limit"] ?? record["rateLimit"]);
  if (direct) {
    return direct;
  }
  for (const key of ["data", "quota", "result"] as const) {
    const nested = findRateLimit(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function parseQuotaWindow(value: unknown): ParsedQuotaWindow | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const used = readFiniteNumber(record["used_percent"] ?? record["usedPercent"]);
  const remaining = readFiniteNumber(record["remaining_percent"] ?? record["remainingPercent"]);
  const usedPercent = used ?? (remaining === undefined ? undefined : 100 - remaining);
  if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) {
    return undefined;
  }
  const resetRaw = readFiniteNumber(record["reset_at"] ?? record["resetAt"]);
  return {
    usedPercent,
    ...(resetRaw === undefined ? {} : { resetAt: resetRaw < 100_000_000_000 ? resetRaw * 1_000 : resetRaw })
  };
}

function aggregateQuotaWindow(windows: ParsedQuotaWindow[]): Sub2ApiGatewayInventoryPool | undefined {
  if (windows.length === 0) {
    return undefined;
  }
  const remainingUnits = windows.reduce((total, window) => total + (100 - window.usedPercent) / 100, 0);
  const resets = windows.map((window) => window.resetAt).filter(isDefined);
  return {
    accountCount: windows.length,
    remainingUnits: roundCapacity(remainingUnits),
    capacityUnits: windows.length,
    remainingPercent: roundCapacity((remainingUnits / windows.length) * 100),
    ...(resets.length > 0 ? { earliestResetAt: Math.min(...resets) } : {})
  };
}

function unwrapArrays(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (depth > 4) {
    return [];
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  for (const key of ["data", "items", "list", "accounts", "groups", "records"] as const) {
    const found = unwrapArrays(record[key], depth + 1);
    if (found.length > 0) {
      return found;
    }
  }
  return [];
}

function readTotal(value: unknown, depth = 0): number | undefined {
  if (depth > 4) {
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const direct = readFiniteNumber(record["total"] ?? record["total_count"] ?? record["totalCount"]);
  if (direct !== undefined && direct >= 0) {
    return Math.floor(direct);
  }
  for (const key of ["data", "pagination", "meta"] as const) {
    const nested = readTotal(record[key], depth + 1);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) {
        results[index] = await work(value);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readIdentifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roundCapacity(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
