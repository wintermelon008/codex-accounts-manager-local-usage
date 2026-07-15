import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
  DashboardCopy,
  DashboardLocalUsageRange,
  DashboardLocalUsageViewModel,
  DashboardSettings
} from "../../src/domain/dashboard/types";
import {
  deriveLocalUsageRange,
  estimateStandardApiCost,
  LOCAL_USAGE_RANGE_OPTIONS,
  type LocalUsagePriceEstimate
} from "./localUsageInsights";

export function LocalUsageSection(props: {
  usage?: DashboardLocalUsageViewModel;
  copy: DashboardCopy;
  settings: DashboardSettings;
  onRangeChange: (range: DashboardLocalUsageRange) => void;
}) {
  const { usage, copy, settings } = props;
  const [selectedRange, setSelectedRange] = useState(settings.localUsageDefaultRange);

  useEffect(() => {
    setSelectedRange(settings.localUsageDefaultRange);
  }, [settings.localUsageDefaultRange]);

  if (!usage) {
    return null;
  }

  const range = deriveLocalUsageRange(usage, selectedRange);
  const price = estimateStandardApiCost(range.byModel);
  const subtitle = copy.localUsageSub.replace("{range}", rangeLabel(copy, range.range));
  const freshness = usage.isRefreshing
    ? copy.localUsageRefreshing
    : usage.calculatedAt != null
      ? `${copy.localUsageUpdated}: ${formatTimestamp(usage.calculatedAt)}`
      : undefined;
  const priceSub = price.unpricedTokens > 0 ? copy.localUsagePriceUnpriced : copy.localUsagePriceSub;
  const showPrice = settings.localUsageShowEquivalentPrice;
  const visibleModels = range.byModel.filter((row) => row.model !== "unknown");

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
            {showPrice ? (
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
              title={range.range === "24h" ? copy.localUsageThreeHour : copy.localUsageDaily}
              rows={range.bars.map((row) => ({
                key: row.key,
                label: row.startAt != null && row.endAt != null ? formatThreeHourRange(row.startAt, row.endAt) : row.date ?? "",
                value: row.total.totalTokens,
                price: row.price
              }))}
              control={
                <RangeSelector
                  copy={copy}
                  selectedRange={selectedRange}
                  onChange={(nextRange) => {
                    setSelectedRange(nextRange);
                    props.onRangeChange(nextRange);
                  }}
                />
              }
              scrollable={range.range === "14d"}
              showPrice={showPrice}
              animationKey={range.range}
            />
            <UsageBars
              title={copy.localUsageByModel}
              titleMeta={copy.localUsageSameRange}
              rows={visibleModels.slice(0, 8).map((row) => ({
                key: `model-${row.model}`,
                label: row.model,
                value: row.totalTokens,
                price: estimateStandardApiCost([row])
              }))}
              emptyLabel={copy.localUsageUnavailable}
              showPrice={showPrice}
              animationKey={range.range}
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
  selectedRange: DashboardLocalUsageRange;
  onChange: (range: DashboardLocalUsageRange) => void;
}) {
  return (
    <div class="local-usage-range" aria-label={props.copy.localUsageDefaultRangeTitle}>
      {LOCAL_USAGE_RANGE_OPTIONS.map((range) => (
        <button
          key={range}
          class={`local-usage-range-btn ${props.selectedRange === range ? "active" : ""}`}
          type="button"
          aria-pressed={props.selectedRange === range}
          onClick={() => props.onChange(range)}
        >
          {rangeLabel(props.copy, range)}
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
  rows: Array<{ key: string; label: string; value: number; price?: LocalUsagePriceEstimate }>;
  emptyLabel?: string;
  scrollable?: boolean;
  showPrice: boolean;
  animationKey: string;
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
        <div key={props.animationKey} class={`local-usage-bars is-range-transition ${props.scrollable ? "is-scrollable" : ""}`}>
          {props.rows.map((row) => {
            const value = formatTokenAndPrice(row.value, row.price, props.showPrice);
            return (
              <div class="local-usage-bar-row" key={row.key}>
                <span class="local-usage-bar-label" title={row.label}>
                  {row.label}
                </span>
                <div class="local-usage-bar-track" aria-label={`${row.label}: ${value}`}>
                  <div class="local-usage-bar-fill" style={{ width: `${barWidth(row.value, max)}%` }}></div>
                </div>
                <span class="local-usage-bar-value" title={value}>
                  {value}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div class="local-usage-empty">{props.emptyLabel}</div>
      )}
    </div>
  );
}

function rangeLabel(copy: DashboardCopy, range: DashboardLocalUsageRange): string {
  switch (range) {
    case "24h":
      return copy.localUsageRange24Hours;
    case "14d":
      return copy.localUsageRange14Days;
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

function formatTokenAndPrice(
  tokens: number,
  price: LocalUsagePriceEstimate | undefined,
  showPrice: boolean
): string {
  const tokenText = formatNumber(tokens);
  if (!showPrice || !price) {
    return tokenText;
  }
  if (price.pricedTokens <= 0) {
    return `${tokenText} (—)`;
  }
  return `${tokenText} (${formatCompactUsd(price.amountUsd)})`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

function formatUsd(value: number): string {
  return `US$${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

function formatCompactUsd(value: number): string {
  return `US$${new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}`;
}

function formatThreeHourRange(startAt: number, endAt: number): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit" });
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const startDate = dateFormatter.format(start);
  const endDate = dateFormatter.format(end);
  const startTime = timeFormatter.format(start);
  const endTime = timeFormatter.format(end);
  return startDate === endDate
    ? `${startDate} ${startTime}–${endTime}`
    : `${startDate} ${startTime}–${endDate} ${endTime}`;
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}
