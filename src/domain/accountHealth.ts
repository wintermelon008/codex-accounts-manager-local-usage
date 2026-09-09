export type AccountHealthKind =
  | "healthy"
  | "expiring"
  | "refresh_failed"
  | "refresh_unavailable"
  | "refresh_token_invalid"
  | "access_token_invalid"
  | "reauthorize"
  | "disabled"
  | "quota";

/** Keeps reauthorization-dependent integrations aligned with actual credential availability. */
export function isAccountReauthorizationRequired(kind: AccountHealthKind): boolean {
  return kind === "reauthorize" || kind === "access_token_invalid";
}
