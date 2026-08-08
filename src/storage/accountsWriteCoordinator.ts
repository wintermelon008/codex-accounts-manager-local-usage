import { randomUUID } from "node:crypto";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { isDeepStrictEqual } from "node:util";
import { cloneIndex, createEmptyIndex, parseAccountsIndex } from "./accountsIndex";
import {
  backupCurrentIndex,
  backupCurrentIndexSync,
  countAvailableBackups,
  countAvailableBackupsSyncSafe,
  isFileNotFoundError,
  readIndexSnapshot,
  writeIndexAtomically,
  writeIndexAtomicallySync
} from "./accountsPersistence";
import type { CodexAccountRecord, CodexAccountsIndex } from "../core/types";
import { createError } from "../core/errors";
import type { AccountsRepositoryState } from "./accountsRepositoryState";

const WRITE_LOCK_LEASE_MS = 15_000;
const WRITE_LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;

export type SharedFileLease = {
  /**
   * Extend the lease while the caller is still the recorded owner. A failed
   * renewal means ownership may have been lost and the caller must not start
   * another shared transaction from the same decision.
   */
  renew(leaseMs?: number): Promise<boolean>;
  release(): Promise<void>;
};

export function disposeWriteCoordinator(
  state: AccountsRepositoryState,
  persistSync: (index: CodexAccountsIndex, baseIndex: CodexAccountsIndex) => CodexAccountsIndex,
  persistAsync?: (index: CodexAccountsIndex, baseIndex: CodexAccountsIndex) => Promise<CodexAccountsIndex>
): void {
  if (state.saveDebounceTimer) {
    clearTimeout(state.saveDebounceTimer);
    state.saveDebounceTimer = null;
  }

  if (!state.isDirty) {
    return;
  }

  const latestIndex = state.pendingSave ?? state.cache?.data;
  if (latestIndex) {
    const baseIndex = state.pendingSaveBase ?? state.cache?.data ?? createEmptyIndex();
    try {
      const persisted = persistSync(latestIndex, baseIndex);
      state.cache = { data: cloneIndex(persisted), timestamp: Date.now() };
    } catch (error) {
      if (!persistAsync || !isSharedWriteLockBusy(error)) {
        throw error;
      }

      // VS Code does not await Disposable.dispose(). If another extension host
      // is finishing an async write, synchronously spinning would block that
      // very host from releasing the lock. Queue one merged retry instead.
      const retryIndex = cloneIndex(latestIndex);
      const retryBaseIndex = cloneIndex(baseIndex);
      void persistAsync(retryIndex, retryBaseIndex).catch((retryError: unknown) => {
        console.error("[codexAccounts] failed to persist the final accounts index retry:", retryError);
      });
    }
  }
  state.pendingSave = null;
  state.pendingSaveBase = null;
  state.isDirty = false;
}

function isSharedWriteLockBusy(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (current instanceof Error && current.message === "The shared accounts index write lock is busy") {
      return true;
    }
    if (!current || typeof current !== "object" || !("cause" in current)) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

export function readPendingOrCachedIndex(
  state: AccountsRepositoryState,
  cacheTtlMs: number
): CodexAccountsIndex | undefined {
  if (state.pendingSave) {
    return cloneIndex(state.pendingSave);
  }

  if (!state.cache) {
    return undefined;
  }

  const age = Date.now() - state.cache.timestamp;
  if (age >= cacheTtlMs) {
    return undefined;
  }

  return cloneIndex(state.cache.data);
}

export function setCachedIndex(state: AccountsRepositoryState, index: CodexAccountsIndex): void {
  state.cache = {
    data: cloneIndex(index),
    timestamp: Date.now()
  };
}

export function markPendingSave(
  state: AccountsRepositoryState,
  index: CodexAccountsIndex,
  debounceDelayMs: number,
  flush: () => void
): void {
  if (!state.pendingSave) {
    state.pendingSaveBase = cloneIndex(state.cache?.data ?? createEmptyIndex());
  }
  const snapshot = cloneIndex(index);
  state.cache = {
    data: snapshot,
    timestamp: Date.now()
  };
  state.isDirty = true;

  if (state.saveDebounceTimer) {
    clearTimeout(state.saveDebounceTimer);
  }

  state.pendingSave = snapshot;
  state.saveDebounceTimer = setTimeout(flush, debounceDelayMs);
}

export function markRecoveryPending(state: AccountsRepositoryState, index: CodexAccountsIndex): void {
  if (state.saveDebounceTimer) {
    clearTimeout(state.saveDebounceTimer);
    state.saveDebounceTimer = null;
  }

  const baseSnapshot = cloneIndex(state.cache?.data ?? createEmptyIndex());
  const snapshot = cloneIndex(index);
  state.cache = {
    data: snapshot,
    timestamp: Date.now()
  };
  state.pendingSave = snapshot;
  state.pendingSaveBase = baseSnapshot;
  state.isDirty = true;
}

export async function flushPendingSave(
  state: AccountsRepositoryState,
  persistIndex: (index: CodexAccountsIndex, baseIndex: CodexAccountsIndex) => Promise<CodexAccountsIndex>
): Promise<void> {
  const snapshot = state.pendingSave;
  const baseSnapshot = state.pendingSaveBase;
  state.saveDebounceTimer = null;

  if (!snapshot || !baseSnapshot) {
    return;
  }

  let persisted: CodexAccountsIndex | undefined;
  const persistTask = state.persistChain
    .catch(() => undefined)
    .then(async () => {
      persisted = await persistIndex(snapshot, baseSnapshot);
    });
  state.persistChain = persistTask;

  try {
    await persistTask;
    if (!persisted) {
      throw new Error("Accounts index persistence did not return a merged snapshot");
    }
    if (state.pendingSave === snapshot) {
      state.pendingSave = null;
      state.pendingSaveBase = null;
      state.cache = {
        data: cloneIndex(persisted),
        timestamp: Date.now()
      };
    } else if (state.pendingSave) {
      const rebased = mergeAccountsIndexChanges(snapshot, state.pendingSave, persisted);
      state.pendingSave = rebased;
      state.pendingSaveBase = cloneIndex(persisted);
      state.cache = {
        data: cloneIndex(rebased),
        timestamp: Date.now()
      };
    }
    if (!state.pendingSave) {
      state.isDirty = false;
    }
  } catch (error) {
    console.error("[codexAccounts] failed to persist accounts index:", error);
  }
}

export function assertWriteAllowed(state: AccountsRepositoryState): void {
  if (state.indexHealth.status === "corrupted_unrecoverable") {
    console.warn("[codexAccounts] blocked write because accounts index is corrupted");
    throw createError.storageWriteBlocked("Accounts index is corrupted. Restore accounts before writing again.");
  }
}

export async function persistIndexWithBackups(params: {
  state: AccountsRepositoryState;
  indexPath: string;
  index: CodexAccountsIndex;
  baseIndex?: CodexAccountsIndex;
  tempSuffix: string;
  backupCount: number;
}): Promise<CodexAccountsIndex> {
  let lease: SharedFileLease | undefined;
  try {
    await fs.mkdir(path.dirname(params.indexPath), { recursive: true });
    lease = await tryAcquireSharedFileLease(`${params.indexPath}.write-lock`, WRITE_LOCK_LEASE_MS, WRITE_LOCK_WAIT_MS);
    if (!lease) {
      throw new Error("Timed out waiting for the shared accounts index write lock");
    }
    const latest = await readLatestIndex(params.indexPath);
    const merged = mergeAccountsIndexChanges(params.baseIndex ?? latest, params.index, latest);
    await backupCurrentIndex(params.indexPath, params.backupCount);
    await writeIndexAtomically(params.indexPath, merged, params.tempSuffix);
    const availableBackups = await countAvailableBackups(params.indexPath, params.backupCount);
    params.state.indexHealth =
      params.state.indexHealth.status === "corrupted_unrecoverable"
        ? { status: "healthy", availableBackups }
        : { ...params.state.indexHealth, availableBackups };
    return merged;
  } catch (cause) {
    throw createError.storageWriteFailed(params.indexPath, cause);
  } finally {
    await lease?.release();
  }
}

export function persistIndexSyncWithBackups(params: {
  state: AccountsRepositoryState;
  indexPath: string;
  index: CodexAccountsIndex;
  baseIndex?: CodexAccountsIndex;
  tempSuffix: string;
  backupCount: number;
}): CodexAccountsIndex {
  let releaseLease: (() => void) | undefined;
  try {
    fsSync.mkdirSync(path.dirname(params.indexPath), { recursive: true });
    releaseLease = tryAcquireSharedFileLeaseSync(`${params.indexPath}.write-lock`, WRITE_LOCK_LEASE_MS);
    if (!releaseLease) {
      throw new Error("The shared accounts index write lock is busy");
    }
    const latest = readLatestIndexSync(params.indexPath);
    const merged = mergeAccountsIndexChanges(params.baseIndex ?? latest, params.index, latest);
    backupCurrentIndexSync(params.indexPath, params.backupCount);
    writeIndexAtomicallySync(params.indexPath, merged, params.tempSuffix);
    const availableBackups = countAvailableBackupsSyncSafe(params.indexPath, params.backupCount);
    params.state.indexHealth =
      params.state.indexHealth.status === "corrupted_unrecoverable"
        ? { status: "healthy", availableBackups }
        : { ...params.state.indexHealth, availableBackups };
    return merged;
  } catch (cause) {
    throw createError.storageWriteFailed(params.indexPath, cause);
  } finally {
    releaseLease?.();
  }
}

export function mergeAccountsIndexChanges(
  baseIndex: CodexAccountsIndex,
  localIndex: CodexAccountsIndex,
  latestIndex: CodexAccountsIndex
): CodexAccountsIndex {
  const base = cloneIndex(baseIndex);
  const local = cloneIndex(localIndex);
  const latest = cloneIndex(latestIndex);
  const baseById = new Map(base.accounts.map((account) => [account.id, account]));
  const localById = new Map(local.accounts.map((account) => [account.id, account]));
  const latestById = new Map(latest.accounts.map((account) => [account.id, account]));

  for (const [accountId, baseAccount] of baseById) {
    const localAccount = localById.get(accountId);
    if (!localAccount) {
      latestById.delete(accountId);
      continue;
    }

    const latestAccount = latestById.get(accountId);
    if (!latestAccount) {
      continue;
    }
    latestById.set(accountId, mergeAccountChanges(baseAccount, localAccount, latestAccount));
  }

  for (const localAccount of local.accounts) {
    if (baseById.has(localAccount.id)) {
      continue;
    }
    const latestAccount = latestById.get(localAccount.id);
    if (!latestAccount) {
      latestById.set(localAccount.id, structuredClone(localAccount));
      continue;
    }
    latestById.set(
      localAccount.id,
      localAccount.updatedAt >= latestAccount.updatedAt ? structuredClone(localAccount) : latestAccount
    );
  }

  const currentAccountId = mergeScalarChange(
    base.currentAccountId,
    local.currentAccountId,
    latest.currentAccountId,
    true
  );
  const currentProviderRoute = mergeScalarChange(
    base.currentProviderRoute,
    local.currentProviderRoute,
    latest.currentProviderRoute,
    true
  );
  const currentProviderAccountId = mergeScalarChange(
    base.currentProviderAccountId,
    local.currentProviderAccountId,
    latest.currentProviderAccountId,
    true
  );
  const accounts = latest.accounts
    .map((account) => latestById.get(account.id))
    .filter((account): account is CodexAccountRecord => Boolean(account));
  for (const account of local.accounts) {
    if (!accounts.some((candidate) => candidate.id === account.id) && latestById.has(account.id)) {
      accounts.push(latestById.get(account.id)!);
    }
  }

  const effectiveCurrentAccountId = accounts.some((account) => account.id === currentAccountId)
    ? currentAccountId
    : undefined;
  for (const account of accounts) {
    account.isActive = account.id === effectiveCurrentAccountId;
    account.providerActive =
      currentProviderRoute === "sub2api"
        ? account.id === currentProviderAccountId
        : account.id === effectiveCurrentAccountId;
  }
  return cloneIndex({
    currentAccountId: effectiveCurrentAccountId,
    currentProviderRoute: currentProviderRoute === "sub2api" ? "sub2api" : "chatgpt",
    currentProviderAccountId:
      currentProviderRoute === "sub2api" && accounts.some((account) => account.id === currentProviderAccountId)
        ? currentProviderAccountId
        : effectiveCurrentAccountId,
    accounts
  });
}

export async function tryAcquireSharedFileLease(
  lockPath: string,
  leaseMs: number,
  waitTimeoutMs = 0
): Promise<SharedFileLease | undefined> {
  const effectiveLeaseMs = Math.max(50, Math.floor(leaseMs));
  const deadline = Date.now() + Math.max(0, Math.floor(waitTimeoutMs));
  const token = randomUUID();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      await fs.mkdir(lockPath);
      try {
        await fs.writeFile(
          path.join(lockPath, "owner.json"),
          JSON.stringify({ token, pid: process.pid, expiresAt: Date.now() + effectiveLeaseMs }),
          "utf8"
        );
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return {
        renew: async (nextLeaseMs = effectiveLeaseMs) =>
          renewSharedFileLease(lockPath, token, Math.max(50, Math.floor(nextLeaseMs))),
        release: async () => releaseSharedFileLease(lockPath, token)
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    if (await reapExpiredSharedFileLease(lockPath, effectiveLeaseMs)) {
      continue;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await delay(Math.min(LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
  }
}

async function renewSharedFileLease(lockPath: string, token: string, leaseMs: number): Promise<boolean> {
  const ownerPath = path.join(lockPath, "owner.json");
  let handle: fs.FileHandle | undefined;
  try {
    // Keep the descriptor for the full read/write sequence. If another host
    // has already reaped and replaced the directory, this descriptor still
    // refers to the old owner file instead of accidentally extending the new
    // owner's lease through the reused path.
    handle = await fs.open(ownerPath, "r+");
    const raw = await handle.readFile("utf8");
    const owner = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
    if (
      owner.token !== token ||
      typeof owner.expiresAt !== "number" ||
      !Number.isFinite(owner.expiresAt) ||
      owner.expiresAt <= Date.now()
    ) {
      return false;
    }

    const next = JSON.stringify({ token, pid: process.pid, expiresAt: Date.now() + leaseMs });
    await handle.truncate(0);
    await handle.write(next, 0, "utf8");
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }
}

function mergeAccountChanges(
  base: CodexAccountRecord,
  local: CodexAccountRecord,
  latest: CodexAccountRecord
): CodexAccountRecord {
  const preferLocal = local.updatedAt >= latest.updatedAt;
  const merged = mergeRecordChanges(
    base as unknown as Record<string, unknown>,
    local as unknown as Record<string, unknown>,
    latest as unknown as Record<string, unknown>,
    preferLocal
  ) as unknown as CodexAccountRecord;
  merged.id = local.id;
  merged.updatedAt = Math.max(local.updatedAt, latest.updatedAt);
  return merged;
}

function mergeRecordChanges(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  latest: Record<string, unknown>,
  preferLocal: boolean
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(latest)]);
  for (const key of keys) {
    const next = mergePropertyChange(base, local, latest, key, preferLocal);
    if (next.present) {
      merged[key] = next.value;
    }
  }
  return merged;
}

function mergePropertyChange(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  latest: Record<string, unknown>,
  key: string,
  preferLocal: boolean
): { present: boolean; value?: unknown } {
  const basePresent = Object.prototype.hasOwnProperty.call(base, key);
  const localPresent = Object.prototype.hasOwnProperty.call(local, key);
  const latestPresent = Object.prototype.hasOwnProperty.call(latest, key);
  const localChanged = basePresent !== localPresent || !isDeepStrictEqual(base[key], local[key]);
  if (!localChanged) {
    return latestPresent ? { present: true, value: structuredClone(latest[key]) } : { present: false };
  }

  const latestChanged = basePresent !== latestPresent || !isDeepStrictEqual(base[key], latest[key]);
  if (!latestChanged || (localPresent === latestPresent && isDeepStrictEqual(local[key], latest[key]))) {
    return localPresent ? { present: true, value: structuredClone(local[key]) } : { present: false };
  }

  if (localPresent && latestPresent && isPlainRecord(local[key]) && isPlainRecord(latest[key])) {
    return {
      present: true,
      value: mergeRecordChanges(isPlainRecord(base[key]) ? base[key] : {}, local[key], latest[key], preferLocal)
    };
  }
  if (key === "updatedAt" && typeof local[key] === "number" && typeof latest[key] === "number") {
    return { present: true, value: Math.max(local[key], latest[key]) };
  }
  if (preferLocal) {
    return localPresent ? { present: true, value: structuredClone(local[key]) } : { present: false };
  }
  return latestPresent ? { present: true, value: structuredClone(latest[key]) } : { present: false };
}

function mergeScalarChange<T>(base: T, local: T, latest: T, preferLocal: boolean): T {
  if (isDeepStrictEqual(local, base)) {
    return latest;
  }
  if (isDeepStrictEqual(latest, base) || isDeepStrictEqual(local, latest) || preferLocal) {
    return local;
  }
  return latest;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readLatestIndex(indexPath: string): Promise<CodexAccountsIndex> {
  try {
    return await readIndexSnapshot(indexPath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createEmptyIndex();
    }
    throw error;
  }
}

function readLatestIndexSync(indexPath: string): CodexAccountsIndex {
  try {
    return parseAccountsIndex(fsSync.readFileSync(indexPath, "utf8"), indexPath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createEmptyIndex();
    }
    throw error;
  }
}

async function reapExpiredSharedFileLease(lockPath: string, fallbackLeaseMs: number): Promise<boolean> {
  let expired = false;
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as {
      expiresAt?: unknown;
    };
    expired = typeof owner.expiresAt === "number" && owner.expiresAt <= Date.now();
  } catch {
    try {
      const stats = await fs.stat(lockPath);
      expired = stats.mtimeMs + fallbackLeaseMs <= Date.now();
    } catch (error) {
      return isFileNotFoundError(error);
    }
  }
  if (!expired) {
    return false;
  }

  const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await fs.rename(lockPath, stalePath);
    await fs.rm(stalePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    return isFileNotFoundError(error);
  }
}

async function releaseSharedFileLease(lockPath: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as { token?: unknown };
    if (owner.token !== token) {
      return;
    }
    await fs.rm(lockPath, { recursive: true, force: true });
  } catch {
    // Lease cleanup is best effort and must not mask the caller's result.
  }
}

function tryAcquireSharedFileLeaseSync(lockPath: string, leaseMs: number): (() => void) | undefined {
  const token = randomUUID();
  fsSync.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    fsSync.mkdirSync(lockPath);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    if (!reapExpiredSharedFileLeaseSync(lockPath, leaseMs)) {
      return undefined;
    }
    try {
      fsSync.mkdirSync(lockPath);
    } catch (retryError) {
      if (isAlreadyExistsError(retryError)) {
        return undefined;
      }
      throw retryError;
    }
  }
  try {
    fsSync.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ token, pid: process.pid, expiresAt: Date.now() + leaseMs }),
      "utf8"
    );
  } catch (error) {
    fsSync.rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
  return () => {
    try {
      const owner = JSON.parse(fsSync.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
        token?: unknown;
      };
      if (owner.token === token) {
        fsSync.rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Lease cleanup is best effort and safe after expiry or ownership loss.
    }
  };
}

function reapExpiredSharedFileLeaseSync(lockPath: string, fallbackLeaseMs: number): boolean {
  let expired = false;
  try {
    const owner = JSON.parse(fsSync.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as {
      expiresAt?: unknown;
    };
    expired = typeof owner.expiresAt === "number" && owner.expiresAt <= Date.now();
  } catch {
    try {
      expired = fsSync.statSync(lockPath).mtimeMs + fallbackLeaseMs <= Date.now();
    } catch (error) {
      return isFileNotFoundError(error);
    }
  }
  if (!expired) {
    return false;
  }
  const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    fsSync.renameSync(lockPath, stalePath);
    fsSync.rmSync(stalePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    return isFileNotFoundError(error);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
