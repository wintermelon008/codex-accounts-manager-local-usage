import * as path from "path";
import * as vscode from "vscode";
import { refreshImportedAccountQuota } from "../../commands";
import { RuntimeAccountSwitchOptions, RuntimeAccountSwitchOutcome, getAuthJsonPath, readAuthFile } from "../../codex";
import { getErrorMessage } from "../../core";
import type { AccountsRepository } from "../../storage";
import { readCurrentAuthAccountStorageId } from "../../utils/accountIdentity";
import { getExternalAuthSyncCopy, getLocalAccountCopy } from "../../utils";
import { refreshQuotaSummaryPanel } from "../dashboard";
import { AccountsStatusBarProvider, refreshDetailsPanel } from "../../ui";
import { needsWindowReloadForAccount, setCurrentWindowRuntimeAccountId } from "./windowRuntimeAccount";
import { buildWorkbenchRefreshSignature } from "./refreshSignature";
import { getTokenAutomationSnapshot } from "./tokenAutomationState";
import { promptWindowReloadForAccount } from "../../application/accounts/switchEffects";
import type { RuntimeSwitchSource } from "../../application/accounts/runtimeSwitchCoordinator";

const EXTERNAL_RUNTIME_RETRY_DELAY_MS = 1_000;
export const EXTERNAL_STATE_POLL_INTERVAL_MS = 2_000;

type RefreshView = {
  refresh: () => void;
  markObservedAuthIdentity: (accountId?: string) => void;
  switchRuntimeAccount?: (
    accountId: string,
    options?: RuntimeAccountSwitchOptions,
    source?: RuntimeSwitchSource
  ) => Promise<RuntimeAccountSwitchOutcome>;
};

export class WorkbenchRefreshCoordinator {
  private lastObservedAuthIdentity?: string;
  private lastExternalStateRevision?: string;
  private lastRefreshSignature?: string;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repo: AccountsRepository,
    private readonly statusBar: AccountsStatusBarProvider
  ) {}

  async initializeObservedAuthIdentity(): Promise<void> {
    this.lastObservedAuthIdentity = await this.readObservedAuthIdentity();
    this.lastExternalStateRevision = await this.repo
      .getExternalStateRevision([getAuthJsonPath()])
      .catch(() => undefined);
    setCurrentWindowRuntimeAccountId(this.lastObservedAuthIdentity);
  }

  createRefreshView(): RefreshView {
    return {
      refresh: (): void => {
        if (this.refreshTimer) {
          return;
        }
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          void this.refreshViewsIfNeeded();
        }, 0);
      },
      markObservedAuthIdentity: (accountId?: string): void => {
        this.lastObservedAuthIdentity = accountId;
      }
    };
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async refreshViewsIfNeeded(): Promise<void> {
    const accounts = await this.repo.listAccounts();
    const indexHealth = await this.repo.getIndexHealthSummary();
    const signature = buildWorkbenchRefreshSignature({
      observedAuthIdentity: this.lastObservedAuthIdentity,
      indexHealth,
      accounts,
      tokenAutomation: getTokenAutomationSnapshot()
    });
    if (signature === this.lastRefreshSignature) {
      return;
    }

    this.lastRefreshSignature = signature;
    await Promise.all([this.statusBar.refresh(), refreshDetailsPanel(), refreshQuotaSummaryPanel()]);
  }

  async promptImportCurrentAccountIfNeeded(view: RefreshView): Promise<void> {
    const accounts = await this.repo.listAccounts();
    if (accounts.length > 0 && accounts.some((account) => account.isActive)) {
      return;
    }

    await this.promptImportCurrentAccount(view);
  }

  registerAuthFileWatcher(view: RefreshView): vscode.Disposable {
    const authPath = getAuthJsonPath();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(authPath), path.basename(authPath))
    );

    let syncTimer: NodeJS.Timeout | undefined;
    let syncInFlight = false;
    let pollInFlight = false;
    let disposed = false;
    let promptVisible = false;

    const scheduleSync = (delayMs = 300): void => {
      if (disposed) {
        return;
      }
      if (syncTimer) {
        clearTimeout(syncTimer);
      }

      syncTimer = setTimeout(() => {
        syncTimer = undefined;
        if (syncInFlight) {
          scheduleSync(delayMs);
          return;
        }
        syncInFlight = true;
        this.repo.invalidateExternalStateCaches();
        void this.syncActiveAccountFromExternalChange(
          view,
          () => {
            promptVisible = true;
          },
          () => {
            promptVisible = false;
          },
          () => promptVisible
        ).then(
          (shouldRetry) => {
            syncInFlight = false;
            if (shouldRetry) {
              scheduleSync(EXTERNAL_RUNTIME_RETRY_DELAY_MS);
            }
          },
          (error) => {
            syncInFlight = false;
            console.warn("[codexAccounts] external account synchronization failed:", getErrorMessage(error));
          }
        );
      }, delayMs);
    };

    watcher.onDidChange(() => scheduleSync(), null, this.context.subscriptions);
    watcher.onDidCreate(() => scheduleSync(), null, this.context.subscriptions);
    watcher.onDidDelete(() => scheduleSync(), null, this.context.subscriptions);

    const pollExternalState = async (): Promise<void> => {
      if (disposed || pollInFlight) {
        return;
      }
      pollInFlight = true;
      try {
        const nextRevision = await this.repo.getExternalStateRevision([authPath]);
        if (this.lastExternalStateRevision === undefined) {
          this.lastExternalStateRevision = nextRevision;
          return;
        }
        if (nextRevision !== this.lastExternalStateRevision) {
          this.lastExternalStateRevision = nextRevision;
          scheduleSync(0);
        }
      } catch (error) {
        console.warn("[codexAccounts] external state polling failed:", getErrorMessage(error));
      } finally {
        pollInFlight = false;
      }
    };
    const pollTimer = setInterval(() => {
      void pollExternalState();
    }, EXTERNAL_STATE_POLL_INTERVAL_MS);
    void pollExternalState();

    return {
      dispose: (): void => {
        disposed = true;
        watcher.dispose();
        if (syncTimer) {
          clearTimeout(syncTimer);
        }
        clearInterval(pollTimer);
      }
    };
  }

  private async promptImportCurrentAccount(view: RefreshView): Promise<void> {
    const auth = await readAuthFile();
    const hasOauth = Boolean(auth?.tokens?.id_token && auth.tokens.access_token);
    if (!hasOauth) {
      return;
    }

    const copy = getLocalAccountCopy();
    const choice = await vscode.window.showInformationMessage(copy.message, copy.action);
    if (choice !== copy.action) {
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: copy.title,
          cancellable: false
        },
        async () => {
          const account = await this.repo.importCurrentAuth();
          this.lastObservedAuthIdentity = account.id;
          const result = await refreshImportedAccountQuota(this.repo, account.id);
          view.refresh();
          await promptWindowReloadForAccount(account);

          if (result.error) {
            void vscode.window.showWarningMessage(copy.partial(account.email, result.error.message));
          } else {
            void vscode.window.showInformationMessage(copy.success(account.email));
          }
        }
      );
    } catch (error) {
      void vscode.window.showErrorMessage(copy.failed(getErrorMessage(error)));
    }
  }

  private async syncActiveAccountFromExternalChange(
    view: RefreshView,
    markVisible: () => void,
    markHidden: () => void,
    isVisible: () => boolean
  ): Promise<boolean> {
    const previousObservedIdentity = this.lastObservedAuthIdentity;
    const nextObservedIdentity = await this.readObservedAuthIdentity();
    this.lastObservedAuthIdentity = nextObservedIdentity;

    await this.repo.syncFromAideckMirror();
    await this.repo.syncActiveAccountFromAuthFile();
    view.refresh();

    const afterAccounts = await this.repo.listAccounts();
    const nextActive = afterAccounts.find((account) => account.isActive);

    if (isVisible()) {
      return false;
    }

    try {
      if (!nextActive && afterAccounts.length > 0) {
        if (previousObservedIdentity === nextObservedIdentity) {
          return false;
        }
        markVisible();
        await this.promptImportCurrentAccount(view);
        return false;
      }

      if (!nextActive) {
        return false;
      }

      if (!needsWindowReloadForAccount(nextActive.id)) {
        return false;
      }

      const runtimeOutcome = (await view.switchRuntimeAccount?.(nextActive.id, undefined, "external")) ?? {
        status: "unavailable" as const
      };
      if (runtimeOutcome.status === "switched") {
        return false;
      }
      if (runtimeOutcome.status === "deferred") {
        console.warn(
          "[codexAccounts] external account change is waiting for a safe runtime boundary:",
          runtimeOutcome.reason
        );
        return true;
      }
      if (runtimeOutcome.status === "failed") {
        console.warn(
          "[codexAccounts] external account change failed before reaching the target runtime:",
          runtimeOutcome.message
        );
        return false;
      }
      if (runtimeOutcome.status === "suppressed") {
        // A separate local or cross-host transaction may have won the lease
        // between observing the auth file and reaching this handoff. Retry
        // once that transaction has had time to settle; the Gateway route is
        // intentionally a stable owner and must not cause a retry loop.
        return runtimeOutcome.reason === "operationInProgress";
      }

      const copy = getExternalAuthSyncCopy();
      markVisible();

      const choice = await vscode.window.showInformationMessage(
        copy.message(nextActive.accountName ?? nextActive.email),
        copy.reloadNow,
        copy.later
      );

      if (choice === copy.reloadNow) {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
      return false;
    } finally {
      markHidden();
    }
  }

  private async readObservedAuthIdentity(): Promise<string | undefined> {
    return readCurrentAuthAccountStorageId();
  }
}
