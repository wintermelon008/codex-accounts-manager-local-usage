import * as path from "node:path";
import { AccountsRepository } from "../storage";
import { getErrorMessage } from "../core/errors";
import { isSub2ApiAccount } from "../core/types";
import { initAccountStatePersistence, flushAccountStates } from "../application/accounts/accountState";
import { resolveAccountHealth } from "../application/accounts/health";
import { getTokenAutomationSnapshot, configureTokenAutomation } from "../presentation/workbench/tokenAutomationState";
import {
  LocalImportInbox,
  enqueueLocalImportJob,
  readLocalImportStatus
} from "../presentation/workbench/localImportInbox";
import { ManagerControlServer, type ManagerControlProxySettings } from "../integrations/managerControlServer";
import { loadManagerControlEnvironment } from "../infrastructure/config/managerControlEnvironment";
import {
  disposeCodexProxyEnvironment,
  getConfiguredProxySettings,
  initializeCodexProxyEnvironment
} from "../infrastructure/config/proxyEnvironment";
import { readManagerProxySelection } from "../infrastructure/config/managerProxySelection";
import { LocalUsageAnalyticsService } from "../services/localUsageAnalytics";
import { createNodeAccountsContext, NodeJsonKeyValueStore } from "./nodeHost";
import { refreshAllQuotasHeadlessly } from "./headlessQuota";
import { refreshImportedAccountQuotaHeadlessly } from "../application/accounts/headlessQuota";
import { HeadlessTokenRefreshScheduler } from "./tokenRefreshScheduler";
import { MailboxDaemonService } from "./mailboxDaemon";
import { HeadlessQuotaCountdownScheduler } from "./quotaCountdownScheduler";
import { configureHeadlessNetworkDebug } from "../utils/networkDebug";
import { readManagerAutomationSettings } from "../infrastructure/config/managerAutomationSettings";
import { readManagerMailboxEnabled } from "../infrastructure/config/managerMailboxSettings";

const CONTROL_HOST = "127.0.0.1" as const;
const DEFAULT_PORT = 43117;
const DEFAULT_QUOTA_REFRESH_MINUTES = 15;
const DEFAULT_TOKEN_REFRESH_INTERVAL_SECONDS = 300;
const DEFAULT_MAILBOX_SCAN_INTERVAL_SECONDS = 60;
const DEFAULT_QUOTA_COUNTDOWN_CHECK_INTERVAL_SECONDS = 60;
const PROXY_SELECTION_REFRESH_INTERVAL_MS = 30_000;
const AUTOMATION_SETTINGS_REFRESH_INTERVAL_MS = 5_000;

export type ManagerDaemonConfig = {
  privateRoot: string;
  port: number;
  token: string;
  quotaRefreshIntervalMs: number;
  tokenRefreshIntervalMs: number;
  mailboxScanIntervalMs: number;
  autoStartQuotaCountdown: boolean;
  quotaCountdownCheckIntervalMs: number;
  debugNetwork: boolean;
};

export function resolveManagerDaemonConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): ManagerDaemonConfig {
  const privateRoot = resolvePrivateRoot(env, cwd);
  const port = parseInteger(
    env["MANAGER_DAEMON_PORT"] ?? env["CODEX_ACCOUNTS_MANAGER_CONTROL_PORT"],
    DEFAULT_PORT,
    0,
    65535
  );
  const quotaMinutes = parseInteger(
    env["MANAGER_DAEMON_QUOTA_REFRESH_MINUTES"],
    DEFAULT_QUOTA_REFRESH_MINUTES,
    0,
    24 * 60
  );
  const tokenSeconds = parseInteger(
    env["MANAGER_DAEMON_TOKEN_REFRESH_INTERVAL_SECONDS"],
    DEFAULT_TOKEN_REFRESH_INTERVAL_SECONDS,
    30,
    24 * 60 * 60
  );
  const mailboxSeconds = parseInteger(
    env["MANAGER_DAEMON_MAILBOX_SCAN_INTERVAL_SECONDS"],
    DEFAULT_MAILBOX_SCAN_INTERVAL_SECONDS,
    10,
    24 * 60 * 60
  );
  const quotaCountdownSeconds = parseInteger(
    env["MANAGER_DAEMON_QUOTA_COUNTDOWN_CHECK_INTERVAL_SECONDS"],
    DEFAULT_QUOTA_COUNTDOWN_CHECK_INTERVAL_SECONDS,
    10,
    24 * 60 * 60
  );
  const token = (env["CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN"] ?? env["MANAGER_CONTROL_TOKEN"] ?? "").trim();
  if (!token) {
    throw new Error("CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN or MANAGER_CONTROL_TOKEN is required");
  }

  return {
    privateRoot,
    port,
    token,
    quotaRefreshIntervalMs: quotaMinutes * 60 * 1000,
    tokenRefreshIntervalMs: tokenSeconds * 1000,
    mailboxScanIntervalMs: mailboxSeconds * 1000,
    autoStartQuotaCountdown: env["MANAGER_DAEMON_AUTO_START_QUOTA_COUNTDOWN"] === "1",
    quotaCountdownCheckIntervalMs: quotaCountdownSeconds * 1000,
    debugNetwork: env["MANAGER_DAEMON_DEBUG_NETWORK"] === "1"
  };
}

export class ManagerDaemon {
  private readonly context: ReturnType<typeof createNodeAccountsContext>;
  private readonly repo: AccountsRepository;
  private readonly accountStateStore: NodeJsonKeyValueStore;
  private readonly managerControlServer: ManagerControlServer;
  private readonly usage: LocalUsageAnalyticsService;
  private readonly localImportInbox: LocalImportInbox;
  private readonly tokenScheduler: HeadlessTokenRefreshScheduler;
  private mailbox: MailboxDaemonService | undefined;
  private quotaCountdownScheduler: HeadlessQuotaCountdownScheduler | undefined;
  private quotaTimer: NodeJS.Timeout | undefined;
  private proxySelectionTimer: NodeJS.Timeout | undefined;
  private automationSettingsTimer: NodeJS.Timeout | undefined;
  private appliedProxySelection: string | undefined;
  private appliedQuotaCountdownAutomation: boolean | undefined;
  private appliedMailboxEnabled: boolean | undefined;
  private mailboxSyncPromise: Promise<void> | undefined;
  private started = false;
  private stopping = false;

  constructor(private readonly config: ManagerDaemonConfig) {
    this.context = createNodeAccountsContext(config.privateRoot);
    this.repo = new AccountsRepository(this.context);
    this.accountStateStore = new NodeJsonKeyValueStore(
      path.join(config.privateRoot, "account-health-evidence.v1.json")
    );
    this.usage = new LocalUsageAnalyticsService({
      globalStoragePath: config.privateRoot,
      backgroundRefreshEnabled: true
    });
    this.localImportInbox = new LocalImportInbox(this.repo, () => undefined, {
      queuePath: path.join(config.privateRoot, "import-inbox"),
      refreshQuota: refreshImportedAccountQuotaHeadlessly
    });
    this.tokenScheduler = new HeadlessTokenRefreshScheduler(this.repo, config.tokenRefreshIntervalMs);
    this.managerControlServer = new ManagerControlServer({
      repo: this.repo,
      usage: this.usage,
      refreshQuotas: (accountIds) => refreshAllQuotasHeadlessly(this.repo, accountIds),
      enqueueImport: (accounts) => enqueueLocalImportJob(accounts, this.localImportInboxPath()),
      getImportStatus: (jobId) => readLocalImportStatus(jobId, this.localImportInboxPath()),
      getAccountHealth: async (account) => {
        const tokens = isSub2ApiAccount(account) ? undefined : await this.repo.getTokens(account.id);
        const accountEmail = account.email.trim().toLowerCase();
        const deactivatedMailboxEmails = new Set(
          (this.mailbox?.getDeactivatedMailboxEmails() ?? [])
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
        );
        return resolveAccountHealth(account, tokens, getTokenAutomationSnapshot(), {
          mailboxDeactivated: deactivatedMailboxEmails.has(accountEmail)
        });
      },
      getDeactivatedMailboxEmails: () => this.mailbox?.getDeactivatedMailboxEmails() ?? [],
      switchAccount: async (accountId) => {
        const account = await this.repo.getAccount(accountId);
        if (!account) {
          return { status: "failed", message: "The requested Manager account was not found" };
        }
        if (isSub2ApiAccount(account)) {
          return { status: "failed", message: "Gateway session switching only supports ChatGPT accounts" };
        }
        try {
          const switched = await this.repo.switchAccount(accountId);
          return {
            status: "switched",
            accountId: switched.id,
            email: switched.email,
            activeTurns: 0,
            interruptedTurns: 0,
            continuedThreads: 0
          };
        } catch (error) {
          return { status: "failed", message: getErrorMessage(error) };
        }
      },
      getProxySettings: async (): Promise<ManagerControlProxySettings> => {
        const selectedProxy = await readManagerProxySelection(this.config.privateRoot);
        const proxy = await getConfiguredProxySettings(selectedProxy);
        return {
          httpsProxy: proxy.httpsProxy,
          noProxy: proxy.noProxy
        };
      }
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Manager daemon is already running");
    }
    this.started = true;
    this.stopping = false;
    try {
      configureHeadlessNetworkDebug(this.config.debugNetwork);
      await loadManagerControlEnvironment({ privateRoot: this.config.privateRoot });
      await this.refreshProxyEnvironment(true);
      await this.accountStateStore.load();
      initAccountStatePersistence(this.accountStateStore);
      configureTokenAutomation(true, this.config.tokenRefreshIntervalMs, 5 * 60);
      await this.repo.init();
      await this.syncMailboxEnabled(true);
      await this.localImportInbox.start();
      await this.syncQuotaCountdownAutomation(true);
      this.tokenScheduler.start();
      if (this.config.quotaRefreshIntervalMs > 0) {
        void this.runQuotaSweep();
        this.quotaTimer = setInterval(() => {
          void this.runQuotaSweep();
        }, this.config.quotaRefreshIntervalMs);
        this.quotaTimer.unref?.();
      }
      this.proxySelectionTimer = setInterval(() => {
        void this.refreshProxyEnvironment();
      }, PROXY_SELECTION_REFRESH_INTERVAL_MS);
      this.proxySelectionTimer.unref?.();
      this.automationSettingsTimer = setInterval(() => {
        void this.syncMailboxEnabled();
        void this.syncQuotaCountdownAutomation();
      }, AUTOMATION_SETTINGS_REFRESH_INTERVAL_MS);
      this.automationSettingsTimer.unref?.();
      await this.managerControlServer.start(this.config.port, this.config.token);
      console.info(`[codexAccounts] manager daemon listening on ${CONTROL_HOST}:${this.config.port}`);
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.proxySelectionTimer) {
      clearInterval(this.proxySelectionTimer);
      this.proxySelectionTimer = undefined;
    }
    if (this.automationSettingsTimer) {
      clearInterval(this.automationSettingsTimer);
      this.automationSettingsTimer = undefined;
    }
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer);
      this.quotaTimer = undefined;
    }
    this.tokenScheduler.dispose();
    this.quotaCountdownScheduler?.dispose();
    this.quotaCountdownScheduler = undefined;
    this.appliedQuotaCountdownAutomation = undefined;
    this.mailbox?.dispose();
    this.mailbox = undefined;
    this.appliedMailboxEnabled = undefined;
    this.localImportInbox.dispose();
    this.managerControlServer.dispose();
    this.repo.dispose();
    await flushAccountStates().catch((error) => {
      console.warn(`[codexAccounts] daemon account-state flush failed: ${getErrorMessage(error)}`);
    });
    await this.accountStateStore.flush().catch((error) => {
      console.warn(`[codexAccounts] daemon state flush failed: ${getErrorMessage(error)}`);
    });
    disposeCodexProxyEnvironment();
    this.started = false;
  }

  private async refreshProxyEnvironment(force = false): Promise<void> {
    const selectedProxy = await readManagerProxySelection(this.config.privateRoot);
    if (!force && selectedProxy === this.appliedProxySelection) {
      return;
    }

    const initialized = await initializeCodexProxyEnvironment(selectedProxy);
    if (initialized || !selectedProxy) {
      this.appliedProxySelection = selectedProxy;
      if (!force) {
        console.info("[codexAccounts] manager daemon applied the Dashboard proxy selection");
      }
    }
  }

  private syncMailboxEnabled(force = false): Promise<void> {
    if (this.mailboxSyncPromise) {
      return this.mailboxSyncPromise;
    }
    const task = this.applyMailboxEnabled(force);
    const tracked = task.finally(() => {
      if (this.mailboxSyncPromise === tracked) {
        this.mailboxSyncPromise = undefined;
      }
    });
    this.mailboxSyncPromise = tracked;
    return tracked;
  }

  private async applyMailboxEnabled(force = false): Promise<void> {
    if (this.stopping) {
      return;
    }
    const sharedSetting = await readManagerMailboxEnabled(this.config.privateRoot);
    const enabled = resolveManagerMailboxEnabled(sharedSetting);
    if (!force && this.appliedMailboxEnabled === enabled) {
      return;
    }

    if (!enabled) {
      this.mailbox?.dispose();
      this.mailbox = undefined;
      this.appliedMailboxEnabled = false;
      console.info("[codexAccounts] daemon Mailbox disabled");
      return;
    }

    if (this.mailbox) {
      this.appliedMailboxEnabled = true;
      return;
    }

    const mailbox = new MailboxDaemonService(this.repo, this.config.privateRoot, this.config.mailboxScanIntervalMs);
    try {
      await mailbox.start();
      if (this.stopping) {
        mailbox.dispose();
        return;
      }
      this.mailbox = mailbox;
      this.appliedMailboxEnabled = true;
      console.info("[codexAccounts] daemon Mailbox enabled");
    } catch (error) {
      mailbox.dispose();
      this.appliedMailboxEnabled = false;
      console.warn(`[codexAccounts] daemon Mailbox start failed: ${getErrorMessage(error)}`);
    }
  }

  private async syncQuotaCountdownAutomation(force = false): Promise<void> {
    const sharedSetting = await readManagerAutomationSettings(this.config.privateRoot);
    const enabled = resolveQuotaCountdownAutomationEnabled(sharedSetting, this.config.autoStartQuotaCountdown);
    if (!force && this.appliedQuotaCountdownAutomation === enabled) {
      return;
    }

    this.quotaCountdownScheduler?.dispose();
    this.quotaCountdownScheduler = undefined;
    this.appliedQuotaCountdownAutomation = enabled;
    if (enabled) {
      this.quotaCountdownScheduler = new HeadlessQuotaCountdownScheduler(
        this.repo,
        this.config.quotaCountdownCheckIntervalMs
      );
      this.quotaCountdownScheduler.start();
    }
    console.info(
      `[codexAccounts] daemon quota countdown automation ${enabled ? "enabled" : "disabled"} (${sharedSetting === undefined ? "environment fallback" : "Dashboard setting"})`
    );
  }

  private async runQuotaSweep(): Promise<void> {
    try {
      const result = await refreshAllQuotasHeadlessly(this.repo);
      console.info(
        `[codexAccounts] daemon quota sweep: total=${result.total}, succeeded=${result.succeeded}, failed=${result.failed}`
      );
    } catch (error) {
      console.warn(`[codexAccounts] daemon quota sweep failed: ${getErrorMessage(error)}`);
    }
  }

  private localImportInboxPath(): string {
    return path.join(this.config.privateRoot, "import-inbox");
  }
}

export function resolveQuotaCountdownAutomationEnabled(
  sharedSetting: boolean | undefined,
  environmentSetting: boolean
): boolean {
  return sharedSetting ?? environmentSetting;
}

export function resolveManagerMailboxEnabled(sharedSetting: boolean | undefined): boolean {
  return sharedSetting === true;
}

export async function main(): Promise<void> {
  const privateRoot = resolvePrivateRoot(process.env, process.cwd());
  await loadManagerControlEnvironment({ privateRoot });
  const config = resolveManagerDaemonConfig();
  const daemon = new ManagerDaemon(config);
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void daemon.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await daemon.start();
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`[codexAccounts] manager daemon failed to start: ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

function requireAbsolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function resolvePrivateRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  const configuredRoot = env["CODEX_ACCOUNTS_PRIVATE_DIR"]?.trim();
  return configuredRoot
    ? requireAbsolutePath(configuredRoot, "CODEX_ACCOUNTS_PRIVATE_DIR")
    : path.resolve(cwd, "private");
}

function parseInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
