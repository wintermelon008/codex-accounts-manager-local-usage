export type AccountHealthKind =
  | "healthy"
  | "expiring"
  | "refresh_failed"
  | "refresh_token_invalid"
  | "access_token_invalid"
  | "reauthorize"
  | "disabled"
  | "quota";

/** Keeps all reauthorization-dependent integrations aligned with Dashboard health. */
export function isAccountReauthorizationRequired(kind: AccountHealthKind): boolean {
  return kind === "reauthorize" || kind === "refresh_token_invalid" || kind === "access_token_invalid";
}
