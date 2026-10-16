import type { CodexAccountRecord, CodexTokens } from "../../core/types";
import type { AccountsRepository } from "../../storage";
import { recordAuthorization } from "./accountState";

export type OAuthAccountPersistenceOptions = {
  forceActive?: boolean;
  registrationAt?: number;
  addedVia?: CodexAccountRecord["addedVia"];
};

/** Persist an OAuth result and record the credential as freshly authorized. */
export async function persistOAuthAccount(
  repo: AccountsRepository,
  tokens: CodexTokens,
  options: OAuthAccountPersistenceOptions = {}
): Promise<CodexAccountRecord> {
  const account = await repo.upsertFromTokens(tokens, options.forceActive ?? false, {
    ...(options.registrationAt !== undefined ? { registrationAt: options.registrationAt } : {}),
    ...(options.addedVia !== undefined ? { addedVia: options.addedVia } : {})
  });
  recordAuthorization(account.id, { ...tokens, accountId: account.accountId ?? tokens.accountId });
  return account;
}
