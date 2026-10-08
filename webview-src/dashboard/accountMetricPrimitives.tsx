import type {
  DashboardAccountViewModel,
  DashboardCopy,
  DashboardMetricViewModel,
  DashboardState,
  DashboardSettings
} from "../../src/domain/dashboard/types";
import {
  clampPercent,
  colorForPercentage,
  formatPercent,
  formatRequestsLabel,
  formatResetLabel,
  getDashboardHealthFilter
} from "./helpers";

export function renderHealthPill(account: DashboardAccountViewModel, lang: DashboardState["lang"] = "en") {
  const state = getDashboardHealthFilter(account);
  if (!state) {
    return null;
  }

  const labels =
    lang === "zh"
      ? { usable: "正常", usable_no_renewal: "不可续期", unknown: "未知", auth_invalid: "失效" }
      : lang === "zh-hant"
        ? { usable: "正常", usable_no_renewal: "不可續期", unknown: "未知", auth_invalid: "失效" }
        : { usable: "Usable", usable_no_renewal: "No renewal", unknown: "Unknown", auth_invalid: "Invalid" };
  const className =
    state === "usable"
      ? "pill ok"
      : state === "usable_no_renewal"
        ? "pill health-usable"
        : state === "unknown"
          ? "pill health-unknown"
          : "pill error";
  return <span class={className}>{labels[state]}</span>;
}

export function MetricGauge(props: {
  metric: DashboardMetricViewModel;
  lang: DashboardState["lang"];
  settings: DashboardSettings;
  copy: DashboardCopy;
  now: number;
}) {
  const clamped = clampPercent(props.metric.percentage);
  const color = colorForPercentage(props.metric.percentage, props.settings);
  const style = {
    "--pct": String(clamped),
    "--gauge-color": color
  } as Record<string, string>;

  return (
    <div class="metric-gauge">
      <div class="metric-gauge-ring" style={style}>
        <div class="metric-gauge-value">{formatPercent(props.metric.percentage)}</div>
      </div>
      <div class="metric-gauge-label">{props.metric.label}</div>
      <div class="metric-gauge-foot">
        {formatResetLabel(props.metric.resetAt, props.copy.resetUnknown, props.now, props.lang)}
      </div>
    </div>
  );
}

export function MetricRow(props: {
  metric: DashboardMetricViewModel;
  lang: DashboardState["lang"];
  settings: DashboardSettings;
  copy: DashboardCopy;
  now: number;
}) {
  const clamped = clampPercent(props.metric.percentage);
  const color = colorForPercentage(props.metric.percentage, props.settings);
  const percentStyle = { "--metric-color": color } as Record<string, string>;
  const barStyle = { width: `${clamped}%`, "--metric-color": color } as Record<string, string>;
  const requestsLabel = formatRequestsLabel(props.metric.requestsLeft, props.metric.requestsLimit);
  const resetLabel = formatResetLabel(props.metric.resetAt, props.copy.resetUnknown, props.now, props.lang);

  return (
    <div class="row">
      <div class="row-head">
        <div class="label-wrap">
          <span class="metric-label">{props.metric.label}</span>
        </div>
        <span class="percent" style={percentStyle}>
          {formatPercent(props.metric.percentage)}
        </span>
      </div>
      <div class="bar">
        <span style={barStyle}></span>
      </div>
      <div class="foot">
        {requestsLabel ? <span>{requestsLabel}</span> : null}
        <span>{resetLabel}</span>
      </div>
    </div>
  );
}
