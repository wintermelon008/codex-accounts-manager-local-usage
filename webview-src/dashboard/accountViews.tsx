import type { DashboardCopy, DashboardState } from "../../src/domain/dashboard/types";
import { useEffect, useRef, useState } from "preact/hooks";
import { formatTemplate } from "./helpers";
import {
  CloseIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  renderRefreshIcon,
  renderRemoveIcon,
  renderResyncProfileIcon,
  SharingIcon
} from "./icons";
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
  shareAccountsPending: boolean;
  hidePending: boolean;
  unhidePending: boolean;
  groupPending: boolean;
  onRefresh: () => void;
  onResync: () => void;
  onRemove: () => void;
  onShare: () => void;
  onShareAccounts: () => void;
  onSetBalancePool: () => void;
  onRemoveFromBalancePool: () => void;
  onHide: () => void;
  onUnhide: () => void;
  onSetAccountGroup: (accountGroup: "A" | "B" | "C" | undefined) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const isZh = props.lang === "zh";
  const isTraditional = props.lang === "zh-hant";
  const clearLabel = isZh ? "清除选择" : isTraditional ? "清除選擇" : "Clear selection";
  const moreLabel = isZh ? "更多批量操作" : isTraditional ? "更多批次操作" : "More batch actions";
  const managementLabel = isZh ? "账号管理" : isTraditional ? "帳號管理" : "Account management";
  const poolInLabel = isZh ? "加入无感池" : isTraditional ? "加入無感池" : "Add to seamless pool";
  const poolOutLabel = isZh ? "移出无感池" : isTraditional ? "移出無感池" : "Remove from seamless pool";
  const hideLabel = isZh ? "隐藏账号" : isTraditional ? "隱藏帳號" : "Hide accounts";
  const showLabel = isZh ? "显示账号" : isTraditional ? "顯示帳號" : "Show accounts";
  const groupLabel = isZh ? "设置分组" : isTraditional ? "設定分組" : "Set group";

  useEffect(() => {
    if (!moreOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!moreRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMoreOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [moreOpen]);

  const runMoreAction = (action: () => void): void => {
    setMoreOpen(false);
    action();
  };

  return (
    <div class="batch-bar">
      <div class="batch-bar-selection">
        <span class="batch-bar-count" aria-live="polite">
          {formatTemplate(props.copy.batchSelectedCount, { count: props.selectedCount })}
        </span>
        <ActionButton
          class="batch-clear-btn"
          icon={<CloseIcon />}
          iconOnly
          label={clearLabel}
          tooltip={clearLabel}
          onClick={props.onClearSelection}
        />
      </div>
      <div class="batch-bar-actions">
        <ActionButton
          class="toolbar-btn batch-primary-btn"
          icon={renderRefreshIcon()}
          pending={props.refreshPending}
          onClick={props.onRefresh}
        >
          {props.copy.batchRefreshBtn}
        </ActionButton>
        <ActionButton
          class="toolbar-btn batch-primary-btn"
          icon={renderResyncProfileIcon()}
          pending={props.resyncPending}
          onClick={props.onResync}
        >
          {props.copy.batchResyncBtn}
        </ActionButton>
        <ActionButton
          class="toolbar-btn batch-secondary-btn"
          icon={<DownloadIcon />}
          pending={props.sharePending}
          onClick={props.onShare}
        >
          {props.copy.batchExportBtn}
        </ActionButton>
        <ActionButton
          class="toolbar-btn batch-secondary-btn"
          icon={<SharingIcon />}
          pending={props.shareAccountsPending}
          onClick={props.onShareAccounts}
        >
          {isZh || isTraditional ? "共享账号" : "Share accounts"}
        </ActionButton>
        <div ref={moreRef} class="batch-more-actions">
          <button
            class="toolbar-btn batch-more-btn"
            type="button"
            aria-label={moreLabel}
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            onClick={() => setMoreOpen((open) => !open)}
          >
            <span class="button-face">
              <span class="button-icon">
                <MoreHorizontalIcon />
              </span>
              <span class="button-label">{isZh ? "更多" : isTraditional ? "更多" : "More"}</span>
            </span>
          </button>
          {moreOpen ? (
            <div class="batch-more-menu" role="menu" aria-label={moreLabel}>
              <div class="batch-menu-section-title">{managementLabel}</div>
              <button
                type="button"
                role="menuitem"
                disabled={props.selectedCount < 2 || props.groupPending}
                onClick={() => runMoreAction(props.onSetBalancePool)}
              >
                {poolInLabel}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={props.groupPending}
                onClick={() => runMoreAction(props.onRemoveFromBalancePool)}
              >
                {poolOutLabel}
              </button>
              <div class="batch-menu-divider" />
              <button
                type="button"
                role="menuitem"
                disabled={props.hidePending || props.unhidePending}
                onClick={() => runMoreAction(props.onHide)}
              >
                {hideLabel}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={props.hidePending || props.unhidePending}
                onClick={() => runMoreAction(props.onUnhide)}
              >
                {showLabel}
              </button>
              <div class="batch-menu-divider" />
              <div class="batch-menu-section-title">{groupLabel}</div>
              <button
                type="button"
                role="menuitem"
                disabled={props.groupPending}
                onClick={() => runMoreAction(() => props.onSetAccountGroup("A"))}
              >
                {isZh || isTraditional ? "分组 A" : "Group A"}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={props.groupPending}
                onClick={() => runMoreAction(() => props.onSetAccountGroup("B"))}
              >
                {isZh || isTraditional ? "分组 B" : "Group B"}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={props.groupPending}
                onClick={() => runMoreAction(() => props.onSetAccountGroup("C"))}
              >
                {isZh || isTraditional ? "分组 C" : "Group C"}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={props.groupPending}
                onClick={() => runMoreAction(() => props.onSetAccountGroup(undefined))}
              >
                {isZh ? "移出分组" : isTraditional ? "移出分組" : "Remove Group"}
              </button>
            </div>
          ) : null}
        </div>
        <ActionButton
          class="toolbar-btn batch-danger-btn"
          icon={renderRemoveIcon()}
          pending={props.removePending}
          onClick={props.onRemove}
        >
          {props.copy.batchRemoveBtn}
        </ActionButton>
      </div>
    </div>
  );
}

export * from "./savedAccountCard";
