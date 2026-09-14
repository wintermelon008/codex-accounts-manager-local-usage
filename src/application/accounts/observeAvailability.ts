import type { TokenRefreshAccountRepository } from "../../auth/tokenRefreshCoordinator";
import type { CodexAccountRecord } from "../../core/types";
import type { HotSwitchAvailabilityEvent } from "../../codex/hotSwitchBridge";
import {
  accessCredentialFingerprint,
  classifyRenewalFailure,
  readRenewal,
  recordAvailability
} from "./accountState";

type Repository = TokenRefreshAccountRepository & {
  getAccount(id: string): Promise<CodexAccountRecord | undefined>;
};

/** Only the resident runtime may supply observations; quota calls never enter here. */
export async function observeAccountAvailability(repo: Repository, event: HotSwitchAvailabilityEvent): Promise<void> {
  const account = await repo.getAccount(event.localAccountId);
  const tokens = await repo.getTokens(event.localAccountId, { forceReload: true });
  if (
    !account ||
    !tokens?.accessToken ||
    (account.accountId ?? tokens.accountId) !== event.accountId ||
    event.credentialFingerprint !== accessCredentialFingerprint(event.accountId, tokens.accessToken)
  )
    return;

  if (event.kind !== "auth_rejected") {
    recordAvailability({ ...event, kind: event.kind }, Date.now(), tokens);
    return;
  }

  // A terminal inference rejection is still not proof that the ACCOUNT cannot
  // recover. Reconcile another process's credentials and try normal renewal once.
  if (!recordAvailability({ ...event, kind: "unknown" })) return;
  if (tokens.refreshToken && readRenewal(account.id, tokens) !== "unavailable") {
    try {
      const { ensureFreshAccountTokens } = await import("../../auth/tokenRefreshCoordinator");
      await ensureFreshAccountTokens(repo, account.id, {
        fallbackTokens: tokens,
        providerAccountId: event.accountId,
        forceRefresh: true
      });
      return; // Successful renewal records positive evidence for the issued credentials.
    } catch (error) {
      if (classifyRenewalFailure(error) !== "unavailable") return;
    }
  }
  const latest = await repo.getTokens(account.id, { forceReload: true });
  if (
    !latest?.accessToken ||
    accessCredentialFingerprint(event.accountId, latest.accessToken) !== event.credentialFingerprint
  )
    return;
  recordAvailability({ ...event, kind: "auth_unavailable" });
}
