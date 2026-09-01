import { randomUUID } from "node:crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { CodexAccountRecord, CodexQuotaSummary, CodexTokens, SharedCodexAccountJson } from "../core/types";
import { isSub2ApiAccount } from "../core/types";
import { extractClaims } from "../utils/jwt";
import { tryAcquireSharedFileLease } from "./accountsWriteCoordinator";

type JsonRecord = Record<string, unknown>;

export type AideckMirrorTokenSnapshot = Partial<CodexTokens> & {
  email?: string;
  userId?: string;
  organizationId?: string;
};

export async function readAideckCodexTokens(accountId: string): Promise<AideckMirrorTokenSnapshot | undefined> {
  const filePath = getAideckCodexAccountFilePath(accountId);
  try {
    if (await hasAideckCodexAccountTombstone(accountId)) {
      return undefined;
    }
    const parsed = (await readJsonFile(filePath)) ?? {};
    const tokenSource = getRecord(parsed["tokens"]);
    const idToken = readString(tokenSource?.["id_token"]) ?? readString(parsed["id_token"]);
    const accessToken =
      readString(tokenSource?.["access_token"]) ?? readString(parsed["access_token"]) ?? readString(parsed["token"]);
    const refreshToken = readString(tokenSource?.["refresh_token"]) ?? readString(parsed["refresh_token"]) ?? undefined;
    const externalAccountId = readString(tokenSource?.["account_id"]) ?? readString(parsed["account_id"]) ?? undefined;

    if (!idToken && !accessToken && !refreshToken && !externalAccountId) {
      return undefined;
    }

    const snapshot = {
      idToken,
      accessToken,
      refreshToken,
      accountId: externalAccountId,
      email: readString(parsed["email"]),
      userId: readString(parsed["user_id"]),
      organizationId: readString(parsed["organization_id"])
    };

    return isMirrorSnapshotConsistent(snapshot) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

export async function listAideckCodexSharedAccounts(): Promise<SharedCodexAccountJson[]> {
  const root = getAideckCodexRoot();
  const accountFiles = new Set<string>();

  try {
    const index = (await readJsonFile(path.join(root, "accounts-index.json"))) ?? {};
    const accounts = Array.isArray(index["accounts"]) ? index["accounts"] : [];
    for (const item of accounts) {
      const record = getRecord(item);
      const id = readString(record?.["id"]);
      if (id) {
        accountFiles.add(getAideckCodexAccountFilePath(id));
      }
    }
  } catch {
    // The index is optional; account-file discovery below remains authoritative.
  }

  try {
    const dir = path.join(root, "accounts");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        accountFiles.add(path.join(dir, entry.name));
      }
    }
  } catch {
    // A missing account directory represents an empty shared store.
  }

  const shared: SharedCodexAccountJson[] = [];
  for (const filePath of accountFiles) {
    const parsed = await readJsonFile(filePath);
    const accountId = readString(parsed?.["id"]);
    if (accountId && (await hasAideckCodexAccountTombstone(accountId))) {
      continue;
    }
    const entry = parsed ? toSharedCodexAccount(parsed) : undefined;
    if (entry) {
      shared.push(entry);
    }
  }

  return shared;
}

export async function mirrorAideckCodexAccount(account: CodexAccountRecord, tokens?: CodexTokens): Promise<void> {
  if (!account.id || !account.email || isSub2ApiAccount(account)) {
    return;
  }

  try {
    const now = Date.now();
    const filePath = getAideckCodexAccountFilePath(account.id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const lease = await acquireMirrorLease(filePath);
    if (!lease) {
      return;
    }
    try {
      if (await hasAideckCodexAccountTombstone(account.id)) {
        return;
      }
      const existing = (await readJsonFile(filePath)) ?? {};
      const existingTokens = getRecord(existing["tokens"]) ?? {};
      const existingQuota = getRecord(existing["quota"]);
      const existingQuotaError = getSharedQuotaError(existing["quota_error"]);
      const safeTokens = shouldMirrorTokensForAccount(account, tokens) ? tokens : undefined;
      const nextTokens = safeTokens
        ? {
            ...existingTokens,
            id_token: safeTokens.idToken,
            access_token: safeTokens.accessToken,
            refresh_token: safeTokens.refreshToken,
            account_id: account.accountId ?? safeTokens.accountId ?? readString(existingTokens["account_id"]) ?? ""
          }
        : existingTokens;
      const incomingQuotaUpdatedAt = account.lastQuotaAt ?? account.updatedAt;
      const existingQuotaUpdatedAt = readNumber(existingQuota?.["updated_at"]) ?? 0;
      const existingQuotaErrorUpdatedAt = existingQuotaError?.timestamp ?? 0;
      const next = {
        ...existing,
        id: account.id,
        email: account.email.trim().toLowerCase(),
        auth_mode: readString(existing["auth_mode"]) ?? "",
        user_id: account.userId ?? readString(existing["user_id"]) ?? "",
        // The Aideck mirror is a compatibility layer, not an authority for workspace-scoped metadata.
        // Preserve existing workspace metadata while accepting demonstrably newer quota snapshots.
        plan_type: readString(existing["plan_type"]) ?? account.planType ?? "",
        subscription_active_until:
          readString(existing["subscription_active_until"]) ?? account.subscriptionActiveUntil ?? "",
        account_id: account.accountId ?? readString(existing["account_id"]) ?? "",
        organization_id: account.organizationId ?? readString(existing["organization_id"]) ?? "",
        account_name: readString(existing["account_name"]) ?? account.accountName ?? "",
        account_structure: readString(existing["account_structure"]) ?? account.accountStructure ?? "",
        added_via: account.addedVia ?? readString(existing["added_via"]) ?? "",
        added_at: readNumber(existing["added_at"]) ?? account.createdAt ?? now,
        created_at: account.createdAt ?? readNumber(existing["created_at"]) ?? now,
        last_used: account.isActive ? now : (readNumber(existing["last_used"]) ?? account.updatedAt ?? 0),
        updated_at: now,
        tokens: nextTokens,
        quota:
          account.quotaSummary && incomingQuotaUpdatedAt >= existingQuotaUpdatedAt
            ? toAideckQuota(account.quotaSummary, incomingQuotaUpdatedAt)
            : (existingQuota ?? null),
        quota_error:
          incomingQuotaUpdatedAt >= existingQuotaErrorUpdatedAt
            ? account.quotaError
              ? {
                  code: account.quotaError.code,
                  message: account.quotaError.message,
                  timestamp: account.quotaError.timestamp
                }
              : null
            : (existingQuotaError ?? null),
        tags: account.tags?.length ? [...account.tags] : []
      };

      await writeJsonFile(filePath, next);
      await writeAideckCodexIndex(account.id, next);
    } finally {
      await lease.release();
    }
  } catch {
    // Aideck storage is a compatibility mirror. Failing to mirror must not break the VS Code extension store.
  }
}

export async function mirrorAideckCurrentAccount(accountId: string): Promise<void> {
  if (!accountId.trim()) {
    return;
  }

  try {
    const currentPath = path.join(getAideckCodexRoot(), "current.json");
    await fs.mkdir(path.dirname(currentPath), { recursive: true });
    const lease = await acquireMirrorLease(currentPath);
    if (!lease) {
      return;
    }
    try {
      await writeJsonFile(currentPath, {
        id: accountId,
        updated_at: Date.now()
      });
    } finally {
      await lease.release();
    }
  } catch {
    // Best-effort compatibility mirror.
  }
}

export async function removeAideckCodexAccount(accountId: string): Promise<void> {
  if (!accountId.trim()) {
    return;
  }

  try {
    const accountPath = getAideckCodexAccountFilePath(accountId);
    const lease = await acquireMirrorLease(accountPath);
    if (!lease) {
      return;
    }
    try {
      const tombstonePath = getAideckCodexTombstonePath(accountId);
      await fs.mkdir(path.dirname(tombstonePath), { recursive: true });
      await writeJsonFile(tombstonePath, {
        id: accountId,
        deleted_at: Date.now()
      });
      await fs.rm(accountPath, { force: true });
    } finally {
      await lease.release();
    }
    await removeAideckCodexIndexRecord(accountId);
    await clearAideckCurrentAccountIfMatches(accountId);
  } catch {
    // Aideck storage is a compatibility mirror. Failing to clean it must not block the VS Code extension store.
  }
}

export function getAideckCodexAccountFilePath(accountId: string): string {
  return path.join(getAideckCodexRoot(), "accounts", `${sanitizeFileStem(accountId)}.json`);
}

export async function getAideckCodexAccountRevision(accountId: string): Promise<string> {
  const revisions = await Promise.all([
    readPathRevision(getAideckCodexAccountFilePath(accountId)),
    readPathRevision(getAideckCodexTombstonePath(accountId))
  ]);
  return revisions.join(":");
}

export async function clearAideckCodexAccountTombstone(accountId: string): Promise<void> {
  if (!accountId.trim()) {
    return;
  }
  try {
    const accountPath = getAideckCodexAccountFilePath(accountId);
    const lease = await acquireMirrorLease(accountPath);
    if (!lease) {
      return;
    }
    try {
      await fs.rm(getAideckCodexTombstonePath(accountId), { force: true });
    } finally {
      await lease.release();
    }
  } catch {
    // Tombstone cleanup is best effort; a later synchronized write can retry it.
  }
}

export async function getAideckCodexStorageRevision(): Promise<string> {
  const root = getAideckCodexRoot();
  const accountDirectory = path.join(root, "accounts");
  const tombstoneDirectory = path.join(root, "tombstones");
  const revisions = await Promise.all([
    readPathRevision(path.join(root, "accounts-index.json")),
    readPathRevision(path.join(root, "current.json")),
    readPathRevision(accountDirectory),
    readPathRevision(tombstoneDirectory)
  ]);
  try {
    const entries = await fs.readdir(accountDirectory, { withFileTypes: true });
    const accountFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
    const fileRevisions = await Promise.all(
      accountFiles.map(async (name) => `${name}:${await readPathRevision(path.join(accountDirectory, name))}`)
    );
    revisions.push(...fileRevisions);
  } catch {
    // A missing account directory contributes no revision entries.
  }
  try {
    const tombstones = await fs.readdir(tombstoneDirectory, { withFileTypes: true });
    const tombstoneRevisions = await Promise.all(
      tombstones
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => `${entry.name}:${await readPathRevision(path.join(tombstoneDirectory, entry.name))}`)
    );
    revisions.push(...tombstoneRevisions.sort());
  } catch {
    // A missing tombstone directory contributes no revision entries.
  }
  return revisions.join("|");
}

function getAideckCodexTombstonePath(accountId: string): string {
  return path.join(getAideckCodexRoot(), "tombstones", `${sanitizeFileStem(accountId)}.json`);
}

async function hasAideckCodexAccountTombstone(accountId: string): Promise<boolean> {
  return (await readPathRevision(getAideckCodexTombstonePath(accountId))) !== "missing";
}

function getAideckCodexRoot(): string {
  return path.join(getAideckDataRoot(), "accounts", "codex");
}

function getAideckDataRoot(): string {
  const envDataRoot = process.env["AIDECK_DATA_DIR"]?.trim();
  return envDataRoot ? envDataRoot.replace(/^['"]|['"]$/g, "") : path.join(os.homedir(), ".ai_deck");
}

async function writeAideckCodexIndex(accountId: string, account: JsonRecord): Promise<void> {
  const indexPath = path.join(getAideckCodexRoot(), "accounts-index.json");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const lease = await acquireMirrorLease(indexPath);
  if (!lease) {
    return;
  }
  try {
    const existing = (await readJsonFile(indexPath)) ?? {};
    const accounts: unknown[] = Array.isArray(existing["accounts"]) ? existing["accounts"].slice() : [];
    const summary = buildAideckIndexRecord(account);
    const nextAccounts = accounts.filter((item) => getRecord(item)?.["id"] !== accountId);
    nextAccounts.push(summary);
    await writeJsonFile(indexPath, {
      ...existing,
      schema_version: readNumber(existing["schema_version"]) ?? 1,
      updated_at: Date.now(),
      accounts: nextAccounts
    });
  } finally {
    await lease.release();
  }
}

async function removeAideckCodexIndexRecord(accountId: string): Promise<void> {
  const indexPath = path.join(getAideckCodexRoot(), "accounts-index.json");
  const lease = await acquireMirrorLease(indexPath);
  if (!lease) {
    return;
  }
  try {
    const existing = await readJsonFile(indexPath);
    if (!existing) {
      return;
    }

    const accounts: unknown[] = Array.isArray(existing["accounts"]) ? existing["accounts"] : [];
    const nextAccounts = accounts.filter((item) => getRecord(item)?.["id"] !== accountId);
    if (nextAccounts.length === accounts.length) {
      return;
    }

    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await writeJsonFile(indexPath, {
      ...existing,
      schema_version: readNumber(existing["schema_version"]) ?? 1,
      updated_at: Date.now(),
      accounts: nextAccounts
    });
  } finally {
    await lease.release();
  }
}

async function clearAideckCurrentAccountIfMatches(accountId: string): Promise<void> {
  const currentPath = path.join(getAideckCodexRoot(), "current.json");
  const lease = await acquireMirrorLease(currentPath);
  if (!lease) {
    return;
  }
  try {
    const current = await readJsonFile(currentPath);
    if (readString(current?.["id"]) !== accountId) {
      return;
    }

    await fs.rm(currentPath, { force: true });
  } finally {
    await lease.release();
  }
}

function buildAideckIndexRecord(account: JsonRecord): JsonRecord {
  const quota = getRecord(account["quota"]);
  return {
    id: readString(account["id"]) ?? "",
    email: readString(account["email"]) ?? "",
    name: readString(account["name"]) ?? readString(account["account_name"]) ?? "",
    auth_mode: readString(account["auth_mode"]) ?? "",
    plan_type: readString(account["plan_type"]) ?? "",
    subscription_active_until: readString(account["subscription_active_until"]) ?? "",
    plan_name: readString(account["plan_name"]) ?? "",
    tier_id: readString(account["tier_id"]) ?? "",
    tags: Array.isArray(account["tags"]) ? account["tags"].slice(0, 50) : [],
    created_at: readNumber(account["created_at"]) ?? Date.now(),
    last_used: readNumber(account["last_used"]) ?? 0,
    updated_at: readNumber(account["updated_at"]) ?? Date.now(),
    has_quota: Boolean(
      quota &&
      (typeof quota["hourly_percentage"] === "number" ||
        typeof quota["weekly_percentage"] === "number" ||
        Array.isArray(quota["additional_rate_limits"]) ||
        typeof quota["code_review_percentage"] === "number")
    ),
    quota_updated_at: readNumber(quota?.["updated_at"]) ?? 0
  };
}

function toSharedCodexAccount(account: JsonRecord): SharedCodexAccountJson | undefined {
  const tokenSource = getRecord(account["tokens"]) ?? {};
  const idToken = readString(tokenSource["id_token"]) ?? readString(account["id_token"]);
  const accessToken =
    readString(tokenSource["access_token"]) ?? readString(account["access_token"]) ?? readString(account["token"]);
  const refreshToken = readString(tokenSource["refresh_token"]) ?? readString(account["refresh_token"]);
  const externalAccountId = readString(tokenSource["account_id"]) ?? readString(account["account_id"]) ?? undefined;

  if (!idToken || !accessToken) {
    return undefined;
  }

  return {
    id: readString(account["id"]),
    email: readString(account["email"]),
    auth_mode: readString(account["auth_mode"]),
    user_id: readString(account["user_id"]),
    plan_type: readString(account["plan_type"]),
    subscription_active_until:
      readString(account["subscription_active_until"]) ?? readNumber(account["subscription_active_until"]) ?? null,
    account_id: externalAccountId ?? null,
    organization_id: readString(account["organization_id"]) ?? null,
    account_name: readString(account["account_name"]) ?? readString(account["name"]) ?? null,
    account_structure: readString(account["account_structure"]) ?? null,
    added_via: readString(account["added_via"]) ?? "aideck",
    added_at: readNumber(account["added_at"]) ?? readNumber(account["created_at"]) ?? null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: externalAccountId ?? null
    },
    quota: getSharedQuota(account["quota"]),
    quota_error: getSharedQuotaError(account["quota_error"]),
    tags: getStringArray(account["tags"]) ?? null,
    created_at: readNumber(account["created_at"]),
    last_used: readNumber(account["last_used"]) ?? readNumber(account["updated_at"])
  };
}

function toAideckQuota(summary: CodexQuotaSummary, updatedAt?: number): JsonRecord {
  return {
    hourly_percentage: summary.hourlyPercentage,
    hourly_reset_time: summary.hourlyResetTime,
    hourly_requests_left: summary.hourlyRequestsLeft,
    hourly_requests_limit: summary.hourlyRequestsLimit,
    hourly_window_minutes: summary.hourlyWindowMinutes,
    weekly_percentage: summary.weeklyPercentage,
    weekly_reset_time: summary.weeklyResetTime,
    weekly_requests_left: summary.weeklyRequestsLeft,
    weekly_requests_limit: summary.weeklyRequestsLimit,
    weekly_window_minutes: summary.weeklyWindowMinutes,
    code_review_percentage: summary.codeReviewPercentage,
    code_review_reset_time: summary.codeReviewResetTime,
    code_review_requests_left: summary.codeReviewRequestsLeft,
    code_review_requests_limit: summary.codeReviewRequestsLimit,
    code_review_window_minutes: summary.codeReviewWindowMinutes,
    additional_rate_limits:
      summary.additionalRateLimits?.map((limit) => ({
        limit_name: limit.limitName,
        metered_feature: limit.meteredFeature,
        hourly_percentage: limit.hourlyPercentage,
        hourly_reset_time: limit.hourlyResetTime,
        hourly_requests_left: limit.hourlyRequestsLeft,
        hourly_requests_limit: limit.hourlyRequestsLimit,
        hourly_window_minutes: limit.hourlyWindowMinutes,
        weekly_percentage: limit.weeklyPercentage,
        weekly_reset_time: limit.weeklyResetTime,
        weekly_requests_left: limit.weeklyRequestsLeft,
        weekly_requests_limit: limit.weeklyRequestsLimit,
        weekly_window_minutes: limit.weeklyWindowMinutes
      })) ?? [],
    credits: summary.credits
      ? {
          has_credits: summary.credits.hasCredits,
          unlimited: summary.credits.unlimited,
          overage_limit_reached: summary.credits.overageLimitReached,
          balance: summary.credits.balance,
          approx_local_messages: summary.credits.approxLocalMessages,
          approx_cloud_messages: summary.credits.approxCloudMessages
        }
      : null,
    updated_at: updatedAt ?? Date.now()
  };
}

function getSharedQuota(value: unknown): SharedCodexAccountJson["quota"] {
  const quota = getRecord(value);
  return quota ? (quota as NonNullable<SharedCodexAccountJson["quota"]>) : null;
}

function getSharedQuotaError(value: unknown): SharedCodexAccountJson["quota_error"] {
  const error = getRecord(value);
  if (!error) {
    return null;
  }
  const message = readString(error["message"]);
  if (!message) {
    return null;
  }
  return {
    code: readString(error["code"]),
    message,
    timestamp: readNumber(error["timestamp"])
  };
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  return out.length ? out : undefined;
}

function shouldMirrorTokensForAccount(
  account: CodexAccountRecord,
  tokens: CodexTokens | undefined
): tokens is CodexTokens {
  if (!tokens?.idToken || !tokens.accessToken) {
    return false;
  }

  const claims = safeExtractMirrorClaims(tokens);
  if (!claims) {
    return false;
  }

  return !(
    hasRequiredIdentityMismatch(normalizeEmail(account.email), claims.email) ||
    hasRequiredIdentityMismatch(account.userId, claims.userId) ||
    hasRequiredIdentityMismatch(account.accountId, tokens.accountId ?? claims.accountId) ||
    hasRequiredIdentityMismatch(account.organizationId, claims.organizationId)
  );
}

function isMirrorSnapshotConsistent(snapshot: AideckMirrorTokenSnapshot): boolean {
  if (!snapshot.idToken) {
    return true;
  }

  const claims = safeExtractMirrorClaims(snapshot);
  if (!claims) {
    return false;
  }

  return !(
    hasPresentIdentityMismatch(normalizeEmail(snapshot.email), claims.email) ||
    hasPresentIdentityMismatch(snapshot.userId, claims.userId) ||
    hasPresentIdentityMismatch(snapshot.accountId, claims.accountId) ||
    hasPresentIdentityMismatch(snapshot.organizationId, claims.organizationId)
  );
}

function safeExtractMirrorClaims(tokens: Partial<CodexTokens> | undefined):
  | {
      email?: string;
      userId?: string;
      accountId?: string;
      organizationId?: string;
    }
  | undefined {
  if (!tokens?.idToken) {
    return undefined;
  }

  try {
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    return {
      email: normalizeEmail(claims.email),
      userId: claims.userId,
      accountId: claims.accountId,
      organizationId: claims.organizationId
    };
  } catch {
    return undefined;
  }
}

function normalizeEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || undefined;
}

function hasRequiredIdentityMismatch(expected: string | undefined, candidate: string | undefined): boolean {
  return Boolean(expected && expected !== candidate);
}

function hasPresentIdentityMismatch(expected: string | undefined, candidate: string | undefined): boolean {
  return Boolean(expected && candidate && expected !== candidate);
}

async function readJsonFile(filePath: string): Promise<JsonRecord | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return getRecord(parsed);
  } catch {
    return undefined;
  }
}

async function writeJsonFile(filePath: string, value: JsonRecord): Promise<void> {
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readPathRevision(filePath: string): Promise<string> {
  try {
    const stats = await fs.stat(filePath);
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch (error) {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable";
  }
}

async function acquireMirrorLease(filePath: string) {
  return tryAcquireSharedFileLease(`${filePath}.write-lock`, 10_000, 2_000);
}

function sanitizeFileStem(value: string): string {
  const raw = value.trim();
  if (!raw) {
    return "item";
  }
  const normalized = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized && normalized !== "." && normalized !== ".." ? normalized : "item";
}

function getRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
