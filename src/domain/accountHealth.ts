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

/** User-facing health categories shared by Dashboard and control consumers. */
export type AccountHealthCategory =
  | "healthy"
  | "expiring"
  | "temporary_error"
  | "credential_invalid"
  | "disabled"
  | "quota_limited";

/** Keeps reauthorization-dependent integrations aligned with actual credential availability. */
export function isAccountReauthorizationRequired(kind: AccountHealthKind): boolean {
  return kind === "reauthorize" || kind === "access_token_invalid";
}

/** Maps the detailed diagnostic state to the stable user-facing category. */
export function getAccountHealthCategory(kind: AccountHealthKind): AccountHealthCategory {
  if (isAccountReauthorizationRequired(kind)) {
    return "credential_invalid";
  }
  switch (kind) {
    case "expiring":
      return "expiring";
    case "refresh_token_invalid":
    case "refresh_failed":
    case "refresh_unavailable":
      return "temporary_error";
    case "disabled":
      return "disabled";
    case "quota":
      return "quota_limited";
    default:
      return "healthy";
  }
}

/** True only when the account credentials or workspace are presently unusable. */
export function isAccountInvalid(kind: AccountHealthKind): boolean {
  const category = getAccountHealthCategory(kind);
  return category === "credential_invalid" || category === "disabled";
}
