import type { DashboardState } from "../../src/domain/dashboard/types";
import { ActionButton } from "./primitives";
import type { FailedDashboardAction } from "./state";

export function ActionRetryBanner(props: {
  failedAction: FailedDashboardAction;
  lang: DashboardState["lang"];
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const copy = resolveActionRetryCopy(props.lang, props.failedAction);
  return (
    <section class="section action-retry-section">
      <div class="recovery-banner is-danger" role="alert">
        <div class="recovery-banner-body">
          <div class="recovery-banner-title">{copy.title}</div>
          <div class="recovery-banner-desc">{copy.description}</div>
          {props.failedAction.error ? (
            <div class="recovery-banner-meta">
              <span>{truncateError(props.failedAction.error)}</span>
            </div>
          ) : null}
        </div>
        <div class="recovery-banner-actions">
          <ActionButton class="toolbar-btn primary-btn" onClick={props.onRetry}>
            {copy.retry}
          </ActionButton>
          <ActionButton class="toolbar-btn" onClick={props.onDismiss}>
            {copy.dismiss}
          </ActionButton>
        </div>
      </div>
    </section>
  );
}

function resolveActionRetryCopy(
  lang: DashboardState["lang"],
  failedAction: FailedDashboardAction
): { title: string; description: string; retry: string; dismiss: string } {
  const action = resolveActionLabel(lang, failedAction.action);
  if (lang === "zh") {
    return {
      title: "操作失败",
      description: `“${action}”没有完成，可以直接重试。`,
      retry: "重试",
      dismiss: "忽略"
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "操作失敗",
      description: `「${action}」未完成，可以直接重試。`,
      retry: "重試",
      dismiss: "忽略"
    };
  }
  return {
    title: "Action failed",
    description: `${action} did not complete. You can retry it directly.`,
    retry: "Retry",
    dismiss: "Dismiss"
  };
}

function resolveActionLabel(lang: DashboardState["lang"], action: FailedDashboardAction["action"]): string {
  if (lang === "zh") {
    switch (action) {
      case "refreshAll":
        return "刷新全部额度";
      case "batchRefresh":
        return "批量刷新额度";
      case "batchResyncProfile":
        return "批量同步资料";
      case "refreshView":
        return "刷新 Dashboard";
      case "refreshLocalUsage":
        return "刷新本地用量";
      case "refresh":
        return "刷新账号";
      case "resyncProfile":
        return "同步账号资料";
      case "details":
        return "打开账号详情";
      case "getResetCredits":
        return "查询重置额度";
      default:
        return "操作";
    }
  }
  if (lang === "zh-hant") {
    switch (action) {
      case "refreshAll":
        return "重新整理全部額度";
      case "batchRefresh":
        return "批次重新整理額度";
      case "batchResyncProfile":
        return "批次同步資料";
      case "refreshView":
        return "重新整理 Dashboard";
      case "refreshLocalUsage":
        return "重新整理本機用量";
      case "refresh":
        return "重新整理帳號";
      case "resyncProfile":
        return "同步帳號資料";
      case "details":
        return "開啟帳號詳細資料";
      case "getResetCredits":
        return "查詢重置額度";
      default:
        return "操作";
    }
  }
  switch (action) {
    case "refreshAll":
      return "Refresh all quotas";
    case "batchRefresh":
      return "Refresh selected quotas";
    case "batchResyncProfile":
      return "Resync selected profiles";
    case "refreshView":
      return "Refresh Dashboard";
    case "refreshLocalUsage":
      return "Refresh local usage";
    case "refresh":
      return "Refresh account";
    case "resyncProfile":
      return "Resync account profile";
    case "details":
      return "Open account details";
    case "getResetCredits":
      return "Read reset credits";
    default:
      return "Action";
  }
}

function truncateError(error: string): string {
  const normalized = error.trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 240)}…`;
}
