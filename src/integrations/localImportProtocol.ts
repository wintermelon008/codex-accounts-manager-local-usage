import type { SharedCodexAccountJson } from "../core/types";

const MAX_ACCOUNTS_PER_JOB = 50;

/** Normalize provider output while dropping unsupported/raw fields. */
export function normalizeLocalImportAccounts(input: unknown): SharedCodexAccountJson[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ACCOUNTS_PER_JOB) {
    throw new Error(`local import accepts 1-${MAX_ACCOUNTS_PER_JOB} accounts`);
  }
  return input.map((value, index) => normalizeLocalImportAccount(value, index));
}

function normalizeLocalImportAccount(value: unknown, index: number): SharedCodexAccountJson {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`local import account ${index + 1} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const tokenRecord = record["tokens"];
  if (!tokenRecord || typeof tokenRecord !== "object" || Array.isArray(tokenRecord)) {
    throw new Error(`local import account ${index + 1} is missing OAuth tokens`);
  }
  const tokens = tokenRecord as Record<string, unknown>;
  const idToken = optionalString(tokens["id_token"]);
  const accessToken = optionalString(tokens["access_token"]);
  const email = optionalString(record["email"]);
  if (!idToken || !accessToken || !email) {
    throw new Error(`local import account ${index + 1} is missing canonical OAuth fields`);
  }
  const accountId = optionalString(record["account_id"]) ?? optionalString(tokens["account_id"]);
  const userId = optionalString(record["user_id"]);
  const planType = optionalString(record["plan_type"]);
  const organizationId = optionalString(record["organization_id"]);
  const refreshToken = optionalString(tokens["refresh_token"]);
  return {
    email,
    auth_mode: "oauth",
    ...(accountId ? { account_id: accountId } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(planType ? { plan_type: planType } : {}),
    ...(organizationId ? { organization_id: organizationId } : {}),
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(accountId ? { account_id: accountId } : {})
    }
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
