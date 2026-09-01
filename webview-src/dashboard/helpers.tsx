import type { ComponentChildren } from "preact";
import {
  DASHBOARD_ACCOUNTS_PAGE_SIZE,
  DEFAULT_WEEKLY_QUOTA_HIDE_THRESHOLD,
  DEFAULT_WEEKLY_QUOTA_UNHIDE_THRESHOLD,
  type DashboardAccountViewModel,
  type DashboardAccountPlanFilter,
  type DashboardIntegrationViewModel,
  type DashboardSettings,
  type DashboardState
} from "../../src/domain/dashboard/types";
import { formatResetRelativeTime } from "../../src/utils/resetTime";

type SensitiveKind = "email" | "id" | "name";

export const LOW_WEEKLY_QUOTA_HIDE_THRESHOLD = DEFAULT_WEEKLY_QUOTA_HIDE_THRESHOLD;
export const HIGH_WEEKLY_QUOTA_UNHIDE_THRESHOLD = DEFAULT_WEEKLY_QUOTA_UNHIDE_THRESHOLD;

export type DashboardAccountPage<T> = {
  page: number;
  pageCount: number;
  startIndex: number;
  endIndex: number;
  accounts: T[];
};

export type DashboardAccountSortKey = "name" | "createdAt" | "quota" | "quotaUpdatedAt";
export type DashboardAccountSortDirection = "asc" | "desc";
export type DashboardAccountSort = {
  key: DashboardAccountSortKey;
  direction: DashboardAccountSortDirection;
};

/**
 * Slices the currently displayed account set into a bounded page. The page is
 * clamped after filter or account changes so a removal can never leave the
 * Dashboard on an empty, stale page.
 */
export function getDashboardAccountPage<T>(
  accounts: readonly T[],
  requestedPage: number,
  pageSize = DASHBOARD_ACCOUNTS_PAGE_SIZE
): DashboardAccountPage<T> {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(accounts.length / normalizedPageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(requestedPage)));
  const startIndex = (page - 1) * normalizedPageSize;
  const endIndex = Math.min(accounts.length, startIndex + normalizedPageSize);

  return {
    page,
    pageCount,
    startIndex,
    endIndex,
    accounts: accounts.slice(startIndex, endIndex)
  };
}

/**
 * Returns the account set currently exposed by the Dashboard's hidden, group,
 * and optional plan filters. Pagination deliberately does not participate so
 * batch selection can remain useful across pages within the same visible scope.
 */
export function getDashboardVisibleAccounts(
  accounts: readonly DashboardAccountViewModel[],
  settings: DashboardSettings,
  showHiddenAccounts: boolean,
  selectedPlanFilters: readonly DashboardAccountPlanFilter[] = []
): DashboardAccountViewModel[] {
  const selectedPlans = new Set<DashboardAccountPlanFilter>(selectedPlanFilters);
  return accounts.filter(
    (account) =>
      isAccountInVisibleGroup(account, settings) &&
      (showHiddenAccounts || !account.isHidden) &&
      isAccountInSelectedPlan(account, selectedPlans)
  );
}

/** Sorts the already-filtered Dashboard account list without changing persisted account order. */
export function sortDashboardAccountsForDisplay(
  accounts: readonly DashboardAccountViewModel[],
  sort: DashboardAccountSort | undefined
): DashboardAccountViewModel[] {
  return [...accounts].sort((left, right) => {
    const activeDifference = getDashboardAccountActivityRank(right) - getDashboardAccountActivityRank(left);
    if (activeDifference !== 0) {
      return activeDifference;
    }
    if (!sort) {
      return 0;
    }

    const direction = sort.direction === "asc" ? 1 : -1;
    let primaryDifference: number;
    switch (sort.key) {
      case "name":
        primaryDifference = direction * compareDashboardAccountName(left, right);
        break;
      case "createdAt":
        primaryDifference = compareOptionalNumbers(left.createdAt, right.createdAt, direction);
        break;
      case "quota":
        primaryDifference = compareOptionalNumbers(getRemainingQuota(left), getRemainingQuota(right), direction);
        break;
      case "quotaUpdatedAt":
        primaryDifference = compareOptionalNumbers(getQuotaResetAt(left), getQuotaResetAt(right), direction);
        break;
    }
    if (primaryDifference !== 0) {
      return primaryDifference;
    }
    return compareDashboardAccountIdentity(left, right);
  });
}

function getDashboardAccountActivityRank(account: DashboardAccountViewModel): number {
  if (account.isCurrentWindowAccount) {
    return 3;
  }
  return account.providerActive === true ? 2 : account.isActive ? 1 : 0;
}

function compareDashboardAccountIdentity(left: DashboardAccountViewModel, right: DashboardAccountViewModel): number {
  return (
    compareDashboardAccountName(left, right) ||
    left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

function compareDashboardAccountName(left: DashboardAccountViewModel, right: DashboardAccountViewModel): number {
  return getDashboardAccountName(left).localeCompare(getDashboardAccountName(right), undefined, {
    sensitivity: "base"
  });
}

function getDashboardAccountName(account: DashboardAccountViewModel): string {
  return account.email.trim() || account.displayName.trim();
}

function getRemainingQuota(account: DashboardAccountViewModel): number | undefined {
  const weeklyMetric = account.metrics.find((metric) => metric.key === "weekly");
  return weeklyMetric?.visible &&
    typeof weeklyMetric.percentage === "number" &&
    Number.isFinite(weeklyMetric.percentage)
    ? weeklyMetric.percentage
    : undefined;
}

function getQuotaResetAt(account: DashboardAccountViewModel): number | undefined {
  const weeklyMetric = account.metrics.find(
    (metric) => metric.key === "weekly" && metric.visible && typeof metric.resetAt === "number" && Number.isFinite(metric.resetAt)
  );
  return weeklyMetric?.resetAt;
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined, direction: number): number {
  if (left === undefined || right === undefined) {
    if (left === right) {
      return 0;
    }
    return left === undefined ? 1 : -1;
  }

  return direction * (left - right);
}

/** Returns real accounts that need reauthorization and have a matching deactivation notice in Mailbox. */
export function getBlockedAccountIds(accounts: readonly DashboardAccountViewModel[]): string[] {
  return accounts.flatMap((account) =>
    account.accountKind !== "sub2api" &&
    account.healthKind === "reauthorize" &&
    account.mailboxDeactivated === true
      ? [account.id]
      : []
  );
}

/** The optional Mailbox extension must be registered and usable before blocked-account actions are exposed. */
export function isMailboxIntegrationActive(
  integrations: readonly Pick<DashboardIntegrationViewModel, "id" | "status">[] | undefined
): boolean {
  return (
    integrations?.some(
      (integration) =>
        integration.id === "mailbox" && (integration.status === "ready" || integration.status === "active")
    ) ?? false
  );
}

function isAccountInVisibleGroup(account: DashboardAccountViewModel, settings: DashboardSettings): boolean {
  switch (account.accountGroup) {
    case "A":
      return settings.seamlessSwitchGroupAVisible;
    case "B":
      return settings.seamlessSwitchGroupBVisible;
    case "C":
      return settings.seamlessSwitchGroupCVisible;
    default:
      return true;
  }
}

function isAccountInSelectedPlan(
  account: DashboardAccountViewModel,
  selectedPlans: ReadonlySet<DashboardAccountPlanFilter>
): boolean {
  if (account.accountKind === "sub2api" || account.manualOnly === true) {
    return true;
  }
  if (selectedPlans.size === 0) {
    return true;
  }
  const plan = resolveDashboardAccountPlanFilter(account.planType);
  return plan !== undefined && selectedPlans.has(plan);
}

function resolveDashboardAccountPlanFilter(planType: string | undefined): DashboardAccountPlanFilter | undefined {
  const normalized = planType?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("pro")) {
    return "pro";
  }
  if (normalized.includes("plus")) {
    return "plus";
  }
  return normalized.includes("free") ? "free" : undefined;
}

/**
 * Finds non-hidden accounts whose reported weekly window is at or below the bulk-hide threshold.
 * The caller supplies the current display scope, so group filters remain respected.
 */
export function getLowWeeklyQuotaAccountIds(
  accounts: DashboardAccountViewModel[],
  threshold = LOW_WEEKLY_QUOTA_HIDE_THRESHOLD
): string[] {
  return accounts.flatMap((account) => {
    const weeklyMetric = account.metrics.find((metric) => metric.key === "weekly");
    const isAtOrBelowThreshold =
      weeklyMetric?.visible === true &&
      typeof weeklyMetric.percentage === "number" &&
      Number.isFinite(weeklyMetric.percentage) &&
      weeklyMetric.percentage <= threshold;

    return !account.isHidden && isAtOrBelowThreshold ? [account.id] : [];
  });
}

/**
 * Finds hidden accounts whose reported weekly window is at or above the bulk-unhide threshold.
 * Hidden accounts are considered across the full snapshot so a disabled group cannot trap them.
 */
export function getHighWeeklyQuotaHiddenAccountIds(
  accounts: DashboardAccountViewModel[],
  threshold = HIGH_WEEKLY_QUOTA_UNHIDE_THRESHOLD
): string[] {
  return accounts.flatMap((account) => {
    const weeklyMetric = account.metrics.find((metric) => metric.key === "weekly");
    const isAtOrAboveThreshold =
      weeklyMetric?.visible === true &&
      typeof weeklyMetric.percentage === "number" &&
      Number.isFinite(weeklyMetric.percentage) &&
      weeklyMetric.percentage >= threshold;

    return account.isHidden && isAtOrAboveThreshold ? [account.id] : [];
  });
}

export function createShareFileName(): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const second = String(now.getSeconds()).padStart(2, "0");
  return `codex-accounts-share-${year}${month}${day}-${hour}${minute}${second}.json`;
}

export function maskSharedJson(raw: string): string {
  if (!raw.trim()) {
    return raw;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return JSON.stringify(maskSharedValue(parsed), null, 2);
  } catch {
    return raw;
  }
}

export function clampPercent(value?: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}

export function colorForPercentage(value: number | undefined, settings: DashboardSettings): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "#2a6e3f";
  }
  if (value >= settings.quotaGreenThreshold) {
    return "#2a6e3f";
  }
  if (value >= settings.quotaYellowThreshold) {
    return "#e18a3b";
  }
  return "#c12c1f";
}

export function formatPercent(value?: number): string {
  return typeof value === "number" ? `${value}%` : "--";
}

export function parsePercentageInput(value: string): number | undefined {
  const trimmed = value.trim();
  const match = trimmed.match(/^(?:\d+(?:\.\d+)?|\.\d+)%$/);
  if (!match) {
    return undefined;
  }

  const parsed = Number(trimmed.slice(0, -1));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

export function formatRequestsLabel(requestsLeft?: number, requestsLimit?: number): string {
  if (typeof requestsLeft !== "number" || typeof requestsLimit !== "number") {
    return "";
  }

  return `${requestsLeft} / ${requestsLimit}`;
}

export function formatTimestamp(epochMs: number | undefined, fallback: string): string {
  if (!epochMs) {
    return fallback;
  }

  return new Date(epochMs).toLocaleString();
}

export function formatResetLabel(
  resetAt: number | undefined,
  fallback: string,
  now: number,
  lang: DashboardState["lang"]
): string {
  if (!resetAt) {
    return fallback;
  }

  const target = new Date(resetAt * 1000);
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  const hour = String(target.getHours()).padStart(2, "0");
  const minute = String(target.getMinutes()).padStart(2, "0");

  return `${formatResetRelativeTime(resetAt, now, lang)} (${month}/${day} ${hour}:${minute})`;
}

export function formatTemplate(template: string, value: number | Record<string, string | number>): string {
  if (typeof value === "number") {
    return template.replace("{value}", String(value));
  }

  return Object.entries(value).reduce(
    (result, [key, item]) => result.replace(new RegExp(`\\{${key}\\}`, "g"), String(item)),
    template
  );
}

export function formatSavedAccountsSummary(
  lang: DashboardState["lang"],
  count: number,
  validCount: number,
  invalidCount: number
): string {
  switch (lang) {
    case "zh":
      return `共 ${count} 个，有效 ${validCount}，失效 ${invalidCount}`;
    case "zh-hant":
      return `共 ${count} 個，有效 ${validCount}，失效 ${invalidCount}`;
    case "ja":
      return `合計 ${count} 件・有効 ${validCount}・無効 ${invalidCount}`;
    default:
      return `${count} total · ${validCount} valid · ${invalidCount} invalid`;
  }
}

export function resolveOverviewAccount(accounts: DashboardAccountViewModel[]): DashboardAccountViewModel | undefined {
  return accounts.find((account) => account.isActive) ?? accounts.find((account) => account.isCurrentWindowAccount);
}

export function normalizeThresholds(green: number, yellow: number): { green: number; yellow: number } {
  const safeYellowBase = Number.isFinite(yellow) ? Math.max(0, Math.min(99, yellow)) : 20;
  const safeGreenBase = Number.isFinite(green) ? Math.max(1, Math.min(100, green)) : 60;
  const safeYellow = Math.min(safeYellowBase, safeGreenBase - 10);
  const safeGreen = Math.max(safeGreenBase, safeYellow + 10);

  return {
    green: safeGreen,
    yellow: safeYellow
  };
}

export function renderTagList(tags: string[]): ComponentChildren {
  if (!tags.length) {
    return null;
  }

  const visible = tags.slice(0, 2);
  const remaining = tags.length - visible.length;
  return (
    <>
      {visible.map((tag) => (
        <span key={tag} class="tag-pill">
          {tag}
        </span>
      ))}
      {remaining > 0 ? <span class="tag-pill muted">+{remaining}</span> : null}
    </>
  );
}

export function resolveLockMinutes(value: number): number {
  return value > 0 ? value : 15;
}

export function resolveDiscreteIndex(values: number[], currentValue: number): number {
  const matchedIndex = values.indexOf(currentValue);
  if (matchedIndex >= 0) {
    return matchedIndex;
  }

  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  values.forEach((value, index) => {
    const distance = Math.abs(value - currentValue);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  return nearestIndex;
}

export function resolveNearestDiscreteValue(values: number[], rawValue: number): number {
  const nearestIndex = resolveDiscreteIndex(values, rawValue);
  return values[nearestIndex] ?? values[0] ?? 0;
}

export function getSensitiveDisplayValue(
  value: string | undefined,
  hidden: boolean,
  kind: SensitiveKind,
  fallback = "—"
): string {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  return hidden ? maskSensitiveValue(normalized, kind) : normalized;
}

export function resolveDiscretePercent(values: number[], currentValue: number): number {
  const first = values[0];
  const last = values[values.length - 1];
  if (typeof first !== "number" || typeof last !== "number" || first === last) {
    return 0;
  }

  return ((currentValue - first) / (last - first)) * 100;
}

export function pickSparseScaleValues(values: number[]): number[] {
  if (values.length <= 3) {
    return values;
  }

  const first = values[0];
  const middle = values[Math.floor((values.length - 1) / 2)];
  const last = values[values.length - 1];

  return [first, middle, last].filter(
    (value, index, array): value is number => typeof value === "number" && array.indexOf(value) === index
  );
}

function maskSharedValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskSharedValue(item, parentKey));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, maskSharedValue(item, key)])
    );
  }

  if (typeof value !== "string" || !value) {
    return value;
  }

  const sensitiveKeys = new Set([
    "email",
    "user_id",
    "account_id",
    "organization_id",
    "account_name",
    "id_token",
    "access_token",
    "refresh_token",
    "id"
  ]);

  if (parentKey && sensitiveKeys.has(parentKey)) {
    return maskSensitiveString(value);
  }

  return value;
}

function maskSensitiveString(value: string): string {
  if (value.length <= 8) {
    return `${value.slice(0, 1)}***${value.slice(-1)}`;
  }

  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function maskSensitiveValue(value: string, kind: SensitiveKind): string {
  switch (kind) {
    case "email":
    case "name":
    case "id":
      return maskSensitiveString(value);
    default:
      return maskSensitiveString(value);
  }
}
