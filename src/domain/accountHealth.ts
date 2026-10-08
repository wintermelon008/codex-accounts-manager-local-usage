export type AvailabilityKind = "unknown" | "usable" | "auth_unavailable" | "quota_limited";
export type RenewalKind = "unknown" | "refreshing" | "succeeded" | "unavailable" | "network_failed";

export type AccountHealthKind =
  | "healthy"
  | "unverified"
  | "refreshing"
  | "refresh_unavailable_unverified"
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
  | "unverified"
  | "availability_unknown"
  | "expiring"
  | "temporary_error"
  | "credential_invalid"
  | "disabled"
  | "quota_limited";

/** Stable four-state account classification for local integrations. */
export type ManagedAccountState = "usable" | "usable_no_renewal" | "unknown" | "auth_invalid";

/**
 * Collapse detailed diagnostics into the four-state contract shared by the
 * Dashboard and local integrations. Quota is deliberately not a state.
 */
export function getManagedAccountState(health: {
  kind: AccountHealthKind;
  availability?: AvailabilityKind;
  renewal?: RenewalKind;
}): ManagedAccountState {
  if (
    health.kind === "reauthorize" ||
    health.kind === "access_token_invalid" ||
    health.kind === "disabled" ||
    health.availability === "auth_unavailable"
  ) {
    return "auth_invalid";
  }
  if (
    (health.availability === "usable" || health.availability === "quota_limited" || health.kind === "quota") &&
    health.renewal === "unavailable"
  ) {
    return "usable_no_renewal";
  }
  // Older Dashboard snapshots exposed this detailed kind without the two
  // evidence fields. Preserve its established meaning for those snapshots.
  if (health.kind === "refresh_unavailable") {
    return "usable_no_renewal";
  }
  if (
    health.kind === "refreshing" ||
    health.kind === "refresh_failed" ||
    health.kind === "refresh_token_invalid" ||
    health.kind === "refresh_unavailable_unverified" ||
    health.kind === "unverified" ||
    health.availability === "unknown"
  ) {
    return "unknown";
  }
  if (
    health.availability === "usable" ||
    health.availability === "quota_limited" ||
    health.renewal === "succeeded" ||
    health.kind === "healthy" ||
    health.kind === "expiring" ||
    health.kind === "quota"
  ) {
    return "usable";
  }
  return "unknown";
}

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
    case "refresh_unavailable_unverified":
    case "unverified":
      return "availability_unknown";
    case "refreshing":
      return "unverified";
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
