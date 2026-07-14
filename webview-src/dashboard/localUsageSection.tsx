import type { ComponentChildren } from "preact";
import type {
  DashboardCopy,
  DashboardLocalUsageRangeDays,
  DashboardLocalUsageViewModel,
  DashboardSettings
} from "../../src/domain/dashboard/types";
import { deriveLocalUsageRange, estimateStandardApiCost, LOCAL_USAGE_RANGE_OPTIONS } from "./localUsageInsights";

export function LocalUsageSection(props: {
  usage?: DashboardLocalUsageViewModel;
  copy: DashboardCopy;
  settings: DashboardSettings;
  onRangeChange: (days: DashboardLocalUsageRangeDays) => void;
}) {
  const { usage, copy, settings } = props;
  if (!usage) {
    return null;
  }

  const range = deriveLocalUsageRange(usage, settings.localUsageDefaultRangeDays);
  const price = estimateStandardApiCost(range.byModel);
  const subtitle = copy.localUsageSub.replace("{days}", String(range.days));
  const freshness = usage.isRefreshing
    ? copy.localUsageRefreshing
    : usage.calculatedAt != null
      ? `${copy.localUsageUpdated}: ${formatTimestamp(usage.calculatedAt)}`
      : undefined;
  const priceSub = price.unpricedTokens > 0 ? copy.localUsagePriceUnpriced : copy.localUsagePriceSub;

  return (
    <section class="section local-usage-section">
      <div class="header local-usage-header">
        <div>
          <div class="header-title">{copy.localUsageTitle}</div>
          <div class="header-sub">{subtitle}</div>
        </div>
        {freshness ? (
          <div class={`local-usage-freshness ${usage.isRefreshing ? "is-refreshing" : ""}`}>{freshness}</div>
        ) : null}
      </div>

      {usage.status === "loading" ? <div class="local-usage-status">{copy.localUsageLoading}</div> : null}
      {usage.status === "unavailable" ? <div class="local-usage-status">{copy.localUsageUnavailable}</div> : null}

      {usage.status === "ready" || usage.isRefreshing ? (
        <>
          <div class="local-usage-cards">
            <UsageMetric label={copy.localUsageTotal} value={range.total.totalTokens} tone="primary" />
            {settings.localUsageShowEquivalentPrice ? (
              <UsageMetric
                label={copy.localUsagePrice}
                value={formatUsd(price.amountUsd)}
                sub={priceSub}
                title={copy.localUsagePriceNote}
                tone="price"
              />
            ) : null}
            <UsageMetric label={copy.localUsageInput} value={range.total.inputTokens} />
            <UsageMetric label={copy.localUsageOutput} value={range.total.outputTokens} />
            <UsageMetric label={copy.localUsageCached} value={range.total.cachedInputTokens} />
          </div>

          <div class="local-usage-layout">
            <UsageBars
              title={copy.localUsageDaily}
              rows={range.byDay.map((row) => ({ label: row.date, value: row.totalTokens }))}
              control={
                <RangeSelector
                  copy={copy}
                  selectedDays={settings.localUsageDefaultRangeDays}
                  onChange={props.onRangeChange}
                />
              }
              scrollable={range.days > 7}
            />
            <UsageBars
              title={copy.localUsageByModel}
              titleMeta={copy.localUsageSameRange}
              rows={range.byModel.slice(0, 8).map((row) => ({
                label: row.model === "unknown" ? copy.localUsageModelUnknown : row.model,
                value: row.totalTokens
              }))}
              emptyLabel={copy.localUsageUnavailable}
            />
          </div>

          <div class="local-usage-footer">
            <span>
              {copy.localUsageEvents}: {formatNumber(range.eventCount)}
            </span>
            <span>{copy.localUsageNote}</span>
          </div>
        </>
      ) : null}
    </section>
  );
}

function RangeSelector(props: {
  copy: DashboardCopy;
  selectedDays: DashboardLocalUsageRangeDays;
  onChange: (days: DashboardLocalUsageRangeDays) => void;
}) {
  return (
    <div class="local-usage-range" aria-label={props.copy.localUsageDefaultRangeTitle}>
      {LOCAL_USAGE_RANGE_OPTIONS.map((days) => (
        <button
          key={days}
          class={`local-usage-range-btn ${props.selectedDays === days ? "active" : ""}`}
          type="button"
          aria-pressed={props.selectedDays === days}
          onClick={() => props.onChange(days)}
        >
          {rangeLabel(props.copy, days)}
        </button>
      ))}
    </div>
  );
}

function UsageMetric(props: {
  label: string;
  value: number | string;
  sub?: string;
  title?: string;
  tone?: "primary" | "price";
}) {
  return (
    <div
      class={`local-usage-card ${props.tone === "primary" ? "is-primary" : ""} ${props.tone === "price" ? "is-price" : ""}`}
      title={props.title}
    >
      <div class="local-usage-card-label">{props.label}</div>
      <div class="local-usage-card-value">
        {typeof props.value === "number" ? formatNumber(props.value) : props.value}
      </div>
      {props.sub ? <div class="local-usage-card-sub">{props.sub}</div> : null}
    </div>
  );
}

function UsageBars(props: {
  title: string;
  titleMeta?: string;
  control?: ComponentChildren;
  rows: Array<{ label: string; value: number }>;
  emptyLabel?: string;
  scrollable?: boolean;
}) {
  const max = Math.max(...props.rows.map((row) => row.value), 0);
  return (
    <div class="local-usage-panel">
      <div class="local-usage-panel-head">
        <div class="local-usage-panel-title">
          {props.title}
          {props.titleMeta ? <span>{props.titleMeta}</span> : null}
        </div>
        {props.control}
      </div>
      {props.rows.length > 0 ? (
        <div class={`local-usage-bars ${props.scrollable ? "is-scrollable" : ""}`}>
          {props.rows.map((row) => (
            <div class="local-usage-bar-row" key={row.label}>
              <span class="local-usage-bar-label" title={row.label}>
                {row.label}
              </span>
              <div class="local-usage-bar-track" aria-label={`${row.label}: ${formatNumber(row.value)}`}>
                <div class="local-usage-bar-fill" style={{ width: `${barWidth(row.value, max)}%` }}></div>
              </div>
              <span class="local-usage-bar-value">{formatNumber(row.value)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div class="local-usage-empty">{props.emptyLabel}</div>
      )}
    </div>
  );
}

function rangeLabel(copy: DashboardCopy, days: DashboardLocalUsageRangeDays): string {
  switch (days) {
    case 14:
      return copy.localUsageRange14Days;
    case 30:
      return copy.localUsageRange30Days;
    default:
      return copy.localUsageRange7Days;
  }
}

function barWidth(value: number, max: number): number {
  if (max <= 0 || value <= 0) {
    return 0;
  }
  return Math.max(2, Math.min(100, (value / max) * 100));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatUsd(value: number): string {
  return `US$${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}
