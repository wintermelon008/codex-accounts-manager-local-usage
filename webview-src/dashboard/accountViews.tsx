import type { DashboardCopy, DashboardState } from "../../src/domain/dashboard/types";
import { formatTemplate } from "./helpers";
import { ActionButton } from "./primitives";

export * from "./overviewSection";

export function RecoveryPanel(props: {
  copy: DashboardCopy;
  health: DashboardState["indexHealth"];
  restoreBackupPending: boolean;
  restoreAuthPending: boolean;
  restoreJsonPending: boolean;
  onRestoreBackup: () => void;
  onRestoreAuth: () => void;
  onImportJson: () => void;
}) {
  const description =
    props.health.status === "restored_from_backup" ? props.copy.recoveryRestored : props.copy.recoveryCorrupted;

  return (
    <div class={`recovery-banner ${props.health.status === "corrupted_unrecoverable" ? "is-danger" : ""}`}>
      <div class="recovery-banner-body">
        <div class="recovery-banner-title">{props.copy.recoveryTitle}</div>
        <div class="recovery-banner-desc">{description}</div>
        <div class="recovery-banner-meta">
          <span>
            {props.copy.recoveryBackups}: {props.health.availableBackups}
          </span>
          {props.health.lastErrorMessage ? (
            <span>
              {props.copy.recoveryLastError}: {props.health.lastErrorMessage}
            </span>
          ) : null}
        </div>
      </div>
      <div class="recovery-banner-actions">
        <ActionButton
          class="toolbar-btn"
          pending={props.restoreBackupPending}
          onClick={props.onRestoreBackup}
          disabled={props.restoreAuthPending || props.restoreJsonPending}
        >
          {props.copy.recoveryRestoreBackupBtn}
        </ActionButton>
        <ActionButton
          class="toolbar-btn"
          pending={props.restoreAuthPending}
          onClick={props.onRestoreAuth}
          disabled={props.restoreBackupPending || props.restoreJsonPending}
        >
          {props.copy.recoveryRestoreAuthBtn}
        </ActionButton>
        <ActionButton
          class="toolbar-btn"
          pending={props.restoreJsonPending}
          onClick={props.onImportJson}
          disabled={props.restoreBackupPending || props.restoreAuthPending}
        >
          {props.copy.recoveryImportJsonBtn}
        </ActionButton>
      </div>
    </div>
  );
}

export function BatchSelectionBar(props: {
  copy: DashboardCopy;
  lang: DashboardState["lang"];
  selectedCount: number;
  onClearSelection: () => void;
  refreshPending: boolean;
  resyncPending: boolean;
  removePending: boolean;
  sharePending: boolean;
  hidePending: boolean;
  unhidePending: boolean;
  groupPending: boolean;
  onRefresh: () => void;
  onResync: () => void;
  onRemove: () => void;
  onShare: () => void;
  onSetBalancePool: () => void;
  onRemoveFromBalancePool: () => void;
  onHide: () => void;
  onUnhide: () => void;
  onSetAccountGroup: (accountGroup: "A" | "B" | "C" | undefined) => void;
}) {
  return (
    <div class="batch-bar">
      <div class="batch-bar-actions">
        <ActionButton class="toolbar-btn" onClick={props.onClearSelection}>
          {props.lang === "zh" ? "取消选择" : props.lang === "zh-hant" ? "取消選擇" : "Clear selection"}
        </ActionButton>
        <ActionButton class="toolbar-btn" disabled={props.selectedCount < 2} onClick={props.onSetBalancePool}>
          {props.lang === "zh" ? "移入无感池" : props.lang === "zh-hant" ? "移入無感池" : "Move into Seamless Pool"}
        </ActionButton>
        <ActionButton class="toolbar-btn" onClick={props.onRemoveFromBalancePool}>
          {props.lang === "zh" ? "移出无感池" : props.lang === "zh-hant" ? "移出無感池" : "Move out of Seamless Pool"}
        </ActionButton>
        <ActionButton
          class="toolbar-btn"
          pending={props.hidePending}
          disabled={props.unhidePending}
          onClick={props.onHide}
        >
          {props.lang === "zh" ? "隐藏账号" : props.lang === "zh-hant" ? "隱藏帳號" : "Hide Accounts"}
        </ActionButton>
        <ActionButton
          class="toolbar-btn"
          pending={props.unhidePending}
          disabled={props.hidePending}
          onClick={props.onUnhide}
        >
          {props.lang === "zh" ? "显示账号" : props.lang === "zh-hant" ? "顯示帳號" : "Show Accounts"}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.groupPending} onClick={() => props.onSetAccountGroup("A")}>
          {props.lang === "zh" ? "分组 A" : props.lang === "zh-hant" ? "分組 A" : "Group A"}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.groupPending} onClick={() => props.onSetAccountGroup("B")}>
          {props.lang === "zh" ? "分组 B" : props.lang === "zh-hant" ? "分組 B" : "Group B"}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.groupPending} onClick={() => props.onSetAccountGroup("C")}>
          {props.lang === "zh" ? "分组 C" : props.lang === "zh-hant" ? "分組 C" : "Group C"}
        </ActionButton>
        <ActionButton
          class="toolbar-btn"
          pending={props.groupPending}
          onClick={() => props.onSetAccountGroup(undefined)}
        >
          {props.lang === "zh" ? "移出分组" : props.lang === "zh-hant" ? "移出分組" : "Remove Group"}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.refreshPending} onClick={props.onRefresh}>
          {props.copy.batchRefreshBtn}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.resyncPending} onClick={props.onResync}>
          {props.copy.batchResyncBtn}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.sharePending} onClick={props.onShare}>
          {props.copy.batchExportBtn}
        </ActionButton>
        <ActionButton class="toolbar-btn" pending={props.removePending} onClick={props.onRemove}>
          {props.copy.batchRemoveBtn}
        </ActionButton>
      </div>
      <div class="batch-bar-count">{formatTemplate(props.copy.batchSelectedCount, { count: props.selectedCount })}</div>
    </div>
  );
}

export * from "./savedAccountCard";
