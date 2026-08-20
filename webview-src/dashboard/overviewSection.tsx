import type {
  DashboardAccountViewModel,
  DashboardCopy,
  DashboardSettings,
  DashboardState
} from "../../src/domain/dashboard/types";
import { getSensitiveDisplayValue } from "./helpers";
import { ActionButton } from "./primitives";

export function OverviewSection(props: {
  account?: DashboardAccountViewModel;
  hasAccounts: boolean;
  lang: DashboardState["lang"];
  copy: DashboardCopy;
  settings: DashboardSettings;
  now: number;
  privacyMode: boolean;
  disabled: boolean;
  addPending: boolean;
  importPending: boolean;
  refreshAllPending: boolean;
  refreshPageLabel: string;
  onToggleAutoSwitchLock: () => void;
  onAddAccount: () => void;
  onImportCurrent: () => void;
  onRefreshAll: () => void;
}) {
  const { account, copy, hasAccounts, privacyMode } = props;
  const emptyTitle = hasAccounts ? copy.noActiveAccountTitle : copy.empty;
  const emptySub = hasAccounts ? copy.noActiveAccountSub : copy.savedAccountsSub;

  return (
    <div class="overview-shell overview-shell-compact">
      <div class={`overview-account ${account ? "" : "overview-empty-panel"}`.trim()}>
        {account ? (
          <div class="overview-account-main">
            <div class="overview-account-email">{getSensitiveDisplayValue(account.email, privacyMode, "email")}</div>
          </div>
        ) : (
          <>
            <div class="overview-empty-title">{emptyTitle}</div>
            <div class="overview-empty-sub">{emptySub}</div>
          </>
        )}
      </div>
      <div class="overview-actions">
        <div class="toolbar">
          <ActionButton
            class="toolbar-btn primary-btn"
            pending={props.addPending}
            disabled={props.disabled}
            onClick={props.onAddAccount}
          >
            {copy.addAccount}
          </ActionButton>
          <ActionButton
            class="toolbar-btn"
            pending={props.importPending}
            disabled={props.disabled}
            onClick={props.onImportCurrent}
          >
            {copy.importCurrent}
          </ActionButton>
          <ActionButton
            class="toolbar-btn"
            pending={props.refreshAllPending}
            disabled={props.disabled}
            onClick={props.onRefreshAll}
          >
            {props.refreshPageLabel}
          </ActionButton>
          <ActionButton
            class="toolbar-btn"
            disabled={props.disabled || !account?.isActive}
            onClick={props.onToggleAutoSwitchLock}
          >
            {account?.autoSwitchLockedUntil ? copy.unlockAutoSwitchBtn : copy.lockAutoSwitchBtn}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
