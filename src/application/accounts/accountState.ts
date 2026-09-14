import { createHash } from "node:crypto";
import type { CodexAccountRecord, CodexTokens } from "../../core/types";
import { decodeJwtPayload, getTokenExpiryEpochSeconds } from "../../utils/jwt";

import type { AvailabilityKind, RenewalKind } from "../../domain/accountHealth";
export type { AvailabilityKind, RenewalKind } from "../../domain/accountHealth";
export type AvailabilityObservation = {
  localAccountId: string;
  accountId: string;
  credentialFingerprint: string;
  runtimeId: string;
  sequence: number;
  observedAt: number;
  kind: AvailabilityKind;
};

// This limits delivery lag for incoming runtime messages, NOT the lifetime of
// accepted evidence. Local evidence survives restarts, never account exports.
export const AVAILABILITY_TTL_MS = 15 * 60 * 1000;
const availability = new Map<string, AvailabilityObservation & { expiresAt?: number }>();
const renewals = new Map<string, { fingerprint: string; kind: RenewalKind; at: number }>();
const legacySuccessChecked = new Set<string>();
// A successful renewal is positive authentication evidence even without a
// resident model runtime. Later renewal failures must not erase that evidence.
const renewalConfirmations = new Map<
  string,
  {
    accountId: string;
    credentialFingerprint: string;
    observedAt: number;
    expiresAt?: number;
  }
>();
let runtimeId: string | undefined;
let revision = 0;
const STATE_PREFIX = "accountHealthEvidence.v1.";
type AccountStateStore = {
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
};
type SavedEvidence = {
  version: 1;
  availability?: ReturnType<typeof availability.get>;
  renewal?: ReturnType<typeof renewals.get>;
  confirmation?: ReturnType<typeof renewalConfirmations.get>;
  legacySuccessChecked?: boolean;
};
let persistence: AccountStateStore | undefined;
let pendingWrite = Promise.resolve();

/** VS Code's local extension storage, deliberately not registered for sync. */
export function initAccountStatePersistence(store: AccountStateStore): void {
  clearAccountStates();
  persistence = store;
  const validTime = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Date.now() + 5_000;
  const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  const validExpiry = (value: unknown): boolean => value === undefined || (typeof value === "number" && Number.isFinite(value));
  for (const key of store.keys().filter((key) => key.startsWith(STATE_PREFIX)).slice(0, 2_048)) {
    let id: string;
    try { id = decodeURIComponent(key.slice(STATE_PREFIX.length)); } catch { continue; }
    const saved = store.get<SavedEvidence>(key);
    if (!saved || saved.version !== 1) continue;
    if (saved.legacySuccessChecked) legacySuccessChecked.add(id);
    const a = saved.availability;
    if (a && a.localAccountId === id && typeof a.accountId === "string" && typeof a.runtimeId === "string" &&
      validHash(a.credentialFingerprint) && validTime(a.observedAt) && validExpiry(a.expiresAt) &&
      Number.isSafeInteger(a.sequence) && a.sequence > 0 &&
      ["unknown", "usable", "auth_unavailable", "quota_limited"].includes(a.kind)) availability.set(id, { ...a });
    const r = saved.renewal;
    if (r && validHash(r.fingerprint) && validTime(r.at) &&
      ["unknown", "refreshing", "succeeded", "unavailable", "network_failed"].includes(r.kind)) {
      renewals.set(id, { ...r, kind: r.kind === "refreshing" ? "unknown" : r.kind });
    }
    const c = saved.confirmation;
    if (c && typeof c.accountId === "string" && validHash(c.credentialFingerprint) &&
      validTime(c.observedAt) && validExpiry(c.expiresAt)) renewalConfirmations.set(id, { ...c });
  }
  accountStateRevision();
}

function persistAccountState(id: string): void {
  const store = persistence;
  if (!store) return;
  const snapshot: SavedEvidence = {
    version: 1,
    availability: availability.has(id) ? { ...availability.get(id)! } : undefined,
    renewal: renewals.has(id) ? { ...renewals.get(id)! } : undefined,
    confirmation: renewalConfirmations.has(id) ? { ...renewalConfirmations.get(id)! } : undefined,
    legacySuccessChecked: legacySuccessChecked.has(id)
  };
  // Per-account keys avoid overwriting other accounts updated by another window.
  pendingWrite = pendingWrite.then(() => store.update(STATE_PREFIX + encodeURIComponent(id), snapshot))
    .catch(() => { console.warn("[codexAccounts] could not persist local account health evidence"); });
}

export async function flushAccountStates(): Promise<void> {
  await pendingWrite;
}

export function clearAccountStates(): void {
  availability.clear();
  renewals.clear();
  renewalConfirmations.clear();
  legacySuccessChecked.clear();
  runtimeId = undefined;
  persistence = undefined;
  revision += 1;
}

/** Remove the local evidence belonging to an account that was deleted. */
export function forgetAccountState(accountId: string): void {
  if (!accountId) return;
  availability.delete(accountId);
  renewals.delete(accountId);
  renewalConfirmations.delete(accountId);
  legacySuccessChecked.delete(accountId);
  revision += 1;
  const store = persistence;
  if (!store) return;
  pendingWrite = pendingWrite
    .then(() => store.update(STATE_PREFIX + encodeURIComponent(accountId), undefined))
    .catch(() => {
      console.warn("[codexAccounts] could not remove local account health evidence");
    });
}

export function accessCredentialFingerprint(accountId: string, accessToken: string): string {
  return createHash("sha256")
    .update(JSON.stringify([accountId, accessToken]))
    .digest("hex");
}

function renewalFingerprint(tokens: CodexTokens): string {
  return createHash("sha256")
    .update(JSON.stringify([tokens.accountId ?? "", tokens.accessToken, tokens.refreshToken ?? ""]))
    .digest("hex");
}

/** Recover local renewal history once, then bind it to the exact current pair.
 * A success timestamp alone, an unexpired JWT, or a quota response is not proof.
 * The credential must have been issued during that same successful operation.
 */
export function restoreAccountRenewalEvidence(account: CodexAccountRecord, tokens: CodexTokens | undefined): void {
  if (!tokens?.accessToken) return;
  const previous = renewals.get(account.id);
  const errorAt = account.tokenRefreshLastErrorAt;
  // Repair the formerly omitted invalid_refresh_token classification without
  // applying an old error to another pair or to a different renewal operation.
  if (previous?.kind === "unknown" && previous.fingerprint === renewalFingerprint(tokens) &&
    typeof errorAt === "number" && errorAt >= previous.at && errorAt - previous.at <= 5_000 &&
    classifyRenewalFailure(new Error(account.tokenRefreshLastError ?? "")) === "unavailable") {
    renewals.set(account.id, { ...previous, kind: "unavailable" });
    revision += 1;
    persistAccountState(account.id);
  }
  if (legacySuccessChecked.has(account.id)) return;
  legacySuccessChecked.add(account.id);
  try {
    if (previous || availability.has(account.id) || renewalConfirmations.has(account.id)) return;
    const startedAt = account.tokenRefreshLastAttemptAt;
    const succeededAt = account.tokenRefreshLastSuccessAt;
    if (!startedAt || !succeededAt || succeededAt < startedAt || succeededAt - startedAt > 60_000 ||
      succeededAt > Date.now() || (errorAt !== undefined && errorAt >= succeededAt) ||
      account.tokenRefreshLastError || !account.accountId || tokens.accountId !== account.accountId) return;
    const payload = decodeJwtPayload(tokens.accessToken);
    const iat = payload["iat"], exp = payload["exp"];
    if (typeof iat !== "number" || !Number.isFinite(iat) || typeof exp !== "number" || !Number.isFinite(exp) ||
      iat * 1000 < startedAt - 5_000 || iat * 1000 > succeededAt + 5_000 ||
      exp * 1000 <= Date.now() || exp <= iat) return;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const providerAccountId = auth?.["chatgpt_account_id"] ?? auth?.["account_id"];
    const providerUserId = auth?.["chatgpt_user_id"] ?? auth?.["user_id"];
    if (providerAccountId !== undefined ? providerAccountId !== account.accountId :
      !account.userId || providerUserId !== account.userId) return;
    renewals.set(account.id, { fingerprint: renewalFingerprint(tokens), kind: "succeeded", at: succeededAt });
    recordAuthenticationSuccess(account.id, tokens, succeededAt);
  } catch {
    // Malformed/opaque legacy credentials cannot establish a historical match.
  } finally {
    revision += 1;
    persistAccountState(account.id);
  }
}

export function setAvailabilityRuntime(id: string | undefined): void {
  if (runtimeId !== id) {
    runtimeId = id;
    revision += 1;
  }
}

export function recordAvailability(observation: AvailabilityObservation, now = Date.now(), tokens?: CodexTokens): boolean {
  if (
    !Number.isSafeInteger(observation.sequence) ||
    observation.sequence <= 0 ||
    observation.runtimeId !== runtimeId ||
    !Number.isFinite(observation.observedAt) ||
    observation.observedAt > now + 5_000 ||
    now - observation.observedAt >= AVAILABILITY_TTL_MS
  )
    return false;
  const previous = availability.get(observation.localAccountId);
  if (
    previous &&
    (previous.observedAt > observation.observedAt ||
      (previous.runtimeId === observation.runtimeId &&
        (previous.sequence > observation.sequence ||
          (previous.sequence === observation.sequence &&
            (observation.kind === "unknown" || previous.kind === "usable" || previous.kind === observation.kind)))))
  )
    return false;
  const confirmation = renewalConfirmations.get(observation.localAccountId);
  if (
    confirmation?.accountId === observation.accountId &&
    confirmation.credentialFingerprint === observation.credentialFingerprint &&
    (observation.kind === "unknown" || observation.kind === "auth_unavailable")
  ) {
    if (observation.observedAt < confirmation.observedAt) return false;
    // A newer real authentication rejection invalidates earlier positive
    // evidence; it must not reappear when the rejection observation expires.
    renewalConfirmations.delete(observation.localAccountId);
  }
  availability.set(observation.localAccountId, {
    ...observation,
    expiresAt: observation.kind === "usable" ? credentialExpiry(tokens?.accessToken) : undefined
  });
  if (availability.size > 2_048) availability.delete(availability.keys().next().value!);
  revision += 1;
  persistAccountState(observation.localAccountId);
  return true;
}

export function readAvailability(
  localAccountId: string,
  accountId: string | undefined,
  tokens: CodexTokens | undefined,
  now = Date.now()
): { kind: AvailabilityKind; observedAt?: number } {
  const value = availability.get(localAccountId);
  const renewed = readRenewalAvailability(localAccountId, accountId, tokens, now);
  if (
    !value ||
    !accountId ||
    !tokens?.accessToken ||
    value.accountId !== accountId ||
    (value.kind !== "quota_limited" &&
      value.credentialFingerprint !== accessCredentialFingerprint(accountId, tokens.accessToken)) ||
    (value.kind === "usable" && value.expiresAt !== undefined && now >= value.expiresAt)
  )
    return renewed;
  if (value.kind !== "quota_limited" && renewed.observedAt !== undefined && renewed.observedAt >= value.observedAt)
    return renewed;
  return { kind: value.kind, observedAt: value.observedAt };
}

export function readRenewalAvailability(
  localAccountId: string,
  accountId: string | undefined,
  tokens: CodexTokens | undefined,
  now = Date.now()
): { kind: "usable" | "unknown"; observedAt?: number } {
  const value = renewalConfirmations.get(localAccountId);
  if (
    !value ||
    !accountId ||
    !tokens?.accessToken ||
    value.accountId !== accountId ||
    value.credentialFingerprint !== accessCredentialFingerprint(accountId, tokens.accessToken) ||
    (value.expiresAt !== undefined && now >= value.expiresAt)
  )
    return { kind: "unknown" };
  return { kind: "usable", observedAt: value.observedAt };
}

export function recordRenewal(accountId: string, tokens: CodexTokens, kind: RenewalKind): void {
  const now = Date.now();
  renewals.set(accountId, { fingerprint: renewalFingerprint(tokens), kind, at: now });
  if (kind === "succeeded") recordAuthenticationSuccess(accountId, tokens, now);
  if (renewals.size > 2_048) renewals.delete(renewals.keys().next().value!);
  revision += 1;
  persistAccountState(accountId);
}

/** A completed OAuth exchange is positive evidence, not a renewal attempt. */
export function recordAuthorization(accountId: string, tokens: CodexTokens): void {
  renewals.delete(accountId);
  recordAuthenticationSuccess(accountId, tokens, Date.now());
  revision += 1;
  persistAccountState(accountId);
}

function recordAuthenticationSuccess(accountId: string, tokens: CodexTokens, now: number): void {
  if (tokens.accountId && tokens.accessToken) {
    const previous = availability.get(accountId);
    if (previous && previous.kind !== "quota_limited" && previous.observedAt <= now) availability.delete(accountId);
    renewalConfirmations.set(accountId, {
      accountId: tokens.accountId,
      credentialFingerprint: accessCredentialFingerprint(tokens.accountId, tokens.accessToken),
      observedAt: now,
      expiresAt: credentialExpiry(tokens.accessToken)
    });
    if (renewalConfirmations.size > 2_048) renewalConfirmations.delete(renewalConfirmations.keys().next().value!);
  }
}

function credentialExpiry(token: string | undefined): number | undefined {
  if (!token) return undefined;
  try {
    const expiry = getTokenExpiryEpochSeconds(token);
    return typeof expiry === "number" && Number.isFinite(expiry) ? expiry * 1000 : undefined;
  } catch {
    // Do not invent a fifteen-minute expiry for an opaque bearer. A changed
    // credential or newer real rejection still supersedes its last success.
    return undefined;
  }
}

export function readRenewal(accountId: string, tokens: CodexTokens | undefined): RenewalKind | undefined {
  const value = renewals.get(accountId);
  return value && tokens && value.fingerprint === renewalFingerprint(tokens) ? value.kind : undefined;
}

export function accountStateRevision(): number {
  for (const [id, confirmation] of renewalConfirmations) {
    if (confirmation.expiresAt !== undefined && Date.now() >= confirmation.expiresAt) {
      renewalConfirmations.delete(id);
      revision += 1;
    }
  }
  for (const [id, observation] of availability) {
    if (observation.kind === "usable" && observation.expiresAt !== undefined && Date.now() >= observation.expiresAt) {
      availability.delete(id);
      revision += 1;
    }
  }
  return revision;
}

export function classifyRenewalFailure(error: unknown): RenewalKind {
  const value = error as { code?: string; statusCode?: number; context?: { errorCode?: string }; message?: string };
  const code = value?.context?.errorCode ?? value?.code ?? "";
  const message = value?.message ?? "";
  if (
    [
      "invalid_grant",
      "invalid_refresh_token",
      "refresh_token_reused",
      "refresh_token_invalidated",
      "refresh_token_expired",
      "refresh_token_revoked"
    ].includes(code) ||
    /no refresh token is available|\[error_code:invalid_refresh_token\]|refresh.token.(?:reused|invalidated|expired|revoked)/iu.test(message)
  )
    return "unavailable";
  if (
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
    /fetch failed|network|timed? ?out|timeout|socket hang up/iu.test(message)
  )
    return "network_failed";
  return "unknown";
}
