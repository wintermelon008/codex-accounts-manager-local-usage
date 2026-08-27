import type * as vscode from "vscode";
import type {
  GatewayRuntimeStatus,
  HotSwitchAccountResult,
  RuntimeAccountSwitchOutcome
} from "../codex/hotSwitchBridge";
import type {
  GatewayRuntimeConfig,
  HotSwitchSetupResult,
  RuntimeAccountSwitchOptions
} from "../codex/hotSwitchRuntime";
import type {
  DashboardIntegrationSettingViewModel,
  DashboardIntegrationViewModel,
  DashboardProviderAccountCardViewModel
} from "../domain/dashboard/types";
import type { CodexVirtualRouteDescriptor, SharedCodexAccountJson } from "../core/types";

const INTEGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const MANAGER_INTEGRATION_API_VERSION = 1 as const;

export type IntegrationChangeEvent = (listener: () => void) => vscode.Disposable;

export type DashboardIntegrationRegistration = {
  id: string;
  getViewModel: () => DashboardIntegrationViewModel;
  runAction: (actionId: string) => void | Promise<void>;
  onDidChange?: IntegrationChangeEvent;
};

export type GatewayRuntimeLease = vscode.Disposable & {
  readonly integrationId: string;
  isActive: () => boolean;
  isConfigured: () => boolean;
  activate: (
    config: GatewayRuntimeConfig,
    credential?: string,
    options?: RuntimeAccountSwitchOptions
  ) => Promise<HotSwitchSetupResult>;
  deactivate: (options?: RuntimeAccountSwitchOptions) => Promise<HotSwitchSetupResult>;
  configureCredential: (credential: string) => Promise<GatewayRuntimeStatus>;
  getStatus: () => Promise<GatewayRuntimeStatus>;
  fallbackToChatGpt: () => Promise<RuntimeAccountSwitchOutcome>;
};

/**
 * A provider-owned route handle. The callback is deliberately opaque to the
 * Manager: it may load a credential from the integration's SecretStorage and
 * must complete the runtime's safe route transaction.
 */
export type VirtualAccountRegistration = {
  id: string;
  displayName: string;
  descriptor: CodexVirtualRouteDescriptor;
  activate: (options?: RuntimeAccountSwitchOptions) => Promise<HotSwitchSetupResult>;
  /** Provider-owned, sanitized card data rendered inside the saved account card. */
  getCardView?: () => DashboardProviderAccountCardViewModel;
  /** Executes a declared provider-owned card action without exposing secrets to Manager. */
  runCardAction?: (actionId: string) => void | Promise<void>;
  /** Provider-owned safe return route used by the dynamic setting toggle. */
  deactivate?: (options?: RuntimeAccountSwitchOptions) => Promise<HotSwitchSetupResult>;
  onDidChange?: IntegrationChangeEvent;
  /** A provider-owned card-visibility setting shown only while this virtual account is registered. */
  setting?: VirtualAccountSettingRegistration;
};

export type VirtualAccountSettingRegistration = {
  id: string;
  title: string;
  description?: string;
  /** Whether the virtual account card is shown; this must not select a provider route. */
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void | Promise<void>;
};

export type VirtualAccountOperations = {
  upsert: (descriptor: CodexVirtualRouteDescriptor, displayName: string) => Promise<void>;
  activate: (accountId: string) => Promise<void>;
  deactivate: () => Promise<void>;
};

export type OAuthAccountImportOptions = {
  /** Optional opaque operation id used by an optional integration to cancel the browser wait. */
  operationId?: string;
  /** Optional mailbox identity used to prevent importing the wrong account. */
  expectedEmail?: string;
  /** Text copied before the browser flow starts, normally the mailbox address. */
  clipboardText?: string;
};

export type OAuthAccountImportResult = {
  accountId: string;
  email: string;
  quotaRefreshed: boolean;
  quotaError?: string;
};

export type RegistrationBrowserOptions = {
  /** Text copied before opening the standalone registration page. */
  clipboardText?: string;
};

export type RegistrationBrowserResult = {
  opened: boolean;
};

export type BalancePoolImportResult = {
  status: "completed" | "partial" | "failed";
  total: number;
  imported: number;
  poolEnabled: number;
  refreshFailed: number;
  notEligible: number;
  authFailed: number;
  importFailed: number;
  accounts: BalancePoolAccountResult[];
};

export type BalancePoolAccountResult = {
  accountId?: string;
  email?: string;
  planType?: string;
  hourlyPercentage?: number;
  weeklyPercentage?: number;
  creditsBalance?: string;
  poolEnabled: boolean;
  status: "ready" | "refresh_failed" | "not_eligible" | "import_failed";
};

export type AccountImportOperations = {
  getManagedAccountEmails: () => Promise<readonly string[]>;
  startOAuthAccountImport: (options?: OAuthAccountImportOptions) => Promise<OAuthAccountImportResult>;
  cancelOAuthAccountImport?: (operationId: string) => void;
  /** Opens the standalone GPT registration page without starting an OAuth callback waiter. */
  openRegistrationBrowser?: (
    options?: RegistrationBrowserOptions
  ) => Promise<RegistrationBrowserResult>;
  /** Controlled credential-bearing handoff for trusted local integrations. */
  importSharedAccountsToBalancePool?: (
    input: SharedCodexAccountJson | SharedCodexAccountJson[]
  ) => Promise<BalancePoolImportResult>;
};

export type CodexAccountsIntegrationApi = {
  readonly apiVersion: typeof MANAGER_INTEGRATION_API_VERSION;
  registerDashboardIntegration: (registration: DashboardIntegrationRegistration) => vscode.Disposable;
  registerGateway: (integrationId: string) => GatewayRuntimeLease;
  registerVirtualAccount: (registration: VirtualAccountRegistration) => Promise<vscode.Disposable>;
  /** Optional sanitized account-directory capability for integrations such as Mailbox. */
  getManagedAccountEmails?: () => Promise<readonly string[]>;
  /** Optional direct OAuth handoff; this intentionally does not open the Dashboard modal. */
  startOAuthAccountImport?: (options?: OAuthAccountImportOptions) => Promise<OAuthAccountImportResult>;
  /** Optional cancellation for an in-flight direct OAuth handoff. */
  cancelOAuthAccountImport?: (operationId: string) => void;
  /** Optional browser-only GPT registration handoff; it never waits for OAuth or imports an account. */
  openRegistrationBrowser?: (
    options?: RegistrationBrowserOptions
  ) => Promise<RegistrationBrowserResult>;
  /** Optional controlled handoff that quarantines, validates, and enables pool accounts. */
  importSharedAccountsToBalancePool?: (
    input: SharedCodexAccountJson | SharedCodexAccountJson[]
  ) => Promise<BalancePoolImportResult>;
};

type GatewayRuntimeOperations = {
  isActive: () => boolean;
  isConfigured: () => boolean;
  activate: (
    config: GatewayRuntimeConfig,
    credential?: string,
    options?: RuntimeAccountSwitchOptions
  ) => Promise<HotSwitchSetupResult>;
  deactivate: (options?: RuntimeAccountSwitchOptions) => Promise<HotSwitchSetupResult>;
  configureCredential: (credential: string) => Promise<GatewayRuntimeStatus>;
  getStatus: () => Promise<GatewayRuntimeStatus>;
  fallbackToChatGpt: () => Promise<RuntimeAccountSwitchOutcome>;
};

type RegisteredDashboardIntegration = DashboardIntegrationRegistration & {
  changeSubscription?: vscode.Disposable;
};

type RegisteredVirtualAccount = VirtualAccountRegistration & {
  changeSubscription?: vscode.Disposable;
};

type GatewayRuntimeLeaseState = {
  disposed: boolean;
};

/**
 * The only Manager surface available to optional integrations. It deliberately
 * does not expose extension storage, account tokens, settings, workspace
 * paths, or any provider-specific controller. Optional account-import helpers
 * expose only sanitized mailbox matching, a controlled OAuth handoff, and a
 * quarantined credential-bearing shared-account import that validates live quota before pool enrollment.
 */
export class ManagerIntegrationHost implements vscode.Disposable {
  readonly api: CodexAccountsIntegrationApi;

  private readonly dashboardIntegrations = new Map<string, RegisteredDashboardIntegration>();
  private readonly gatewayLeases = new Map<string, GatewayRuntimeLeaseState>();
  private readonly virtualAccounts = new Map<string, RegisteredVirtualAccount>();
  private readonly changeListeners = new Set<() => void>();
  private virtualSwitchInFlight: Promise<RuntimeAccountSwitchOutcome> | undefined;
  private configuredGatewayOwner: string | undefined;
  private activeGatewayOwner: string | undefined;
  private gatewayTransitionOwner: string | undefined;
  private disposed = false;

  constructor(
    private readonly gateway: GatewayRuntimeOperations,
    private readonly virtualAccountOperations?: VirtualAccountOperations,
    private readonly accountImportOperations?: AccountImportOperations
  ) {
    this.api = {
      apiVersion: MANAGER_INTEGRATION_API_VERSION,
      registerDashboardIntegration: (registration) => this.registerDashboardIntegration(registration),
      registerGateway: (integrationId) => this.registerGateway(integrationId),
      registerVirtualAccount: (registration) => this.registerVirtualAccount(registration),
      ...(this.accountImportOperations
        ? {
            getManagedAccountEmails: () => this.getManagedAccountEmails(),
            startOAuthAccountImport: (options?: OAuthAccountImportOptions) => this.startOAuthAccountImport(options),
            ...(this.accountImportOperations.cancelOAuthAccountImport
              ? { cancelOAuthAccountImport: (operationId: string) => this.cancelOAuthAccountImport(operationId) }
              : {}),
            ...(this.accountImportOperations.openRegistrationBrowser
              ? {
                  openRegistrationBrowser: (options?: RegistrationBrowserOptions) =>
                    this.openRegistrationBrowser(options)
                }
              : {}),
            ...(this.accountImportOperations.importSharedAccountsToBalancePool
              ? {
                  importSharedAccountsToBalancePool: (input: SharedCodexAccountJson | SharedCodexAccountJson[]) =>
                    this.importSharedAccountsToBalancePool(input)
                }
              : {})
          }
        : {})
    };
  }

  async getManagedAccountEmails(): Promise<readonly string[]> {
    this.throwIfDisposed();
    if (!this.accountImportOperations) {
      return [];
    }
    return this.accountImportOperations.getManagedAccountEmails();
  }

  async startOAuthAccountImport(options?: OAuthAccountImportOptions): Promise<OAuthAccountImportResult> {
    this.throwIfDisposed();
    if (!this.accountImportOperations) {
      throw new Error("OAuth account import is unavailable in this Manager build");
    }
    return this.accountImportOperations.startOAuthAccountImport(options);
  }

  cancelOAuthAccountImport(operationId: string): void {
    this.throwIfDisposed();
    this.accountImportOperations?.cancelOAuthAccountImport?.(operationId);
  }

  async openRegistrationBrowser(
    options?: RegistrationBrowserOptions
  ): Promise<RegistrationBrowserResult> {
    this.throwIfDisposed();
    const opener = this.accountImportOperations?.openRegistrationBrowser;
    if (!opener) {
      throw new Error("Standalone GPT registration browser is unavailable in this Manager build");
    }
    return opener(options);
  }

  async importSharedAccountsToBalancePool(
    input: SharedCodexAccountJson | SharedCodexAccountJson[]
  ): Promise<BalancePoolImportResult> {
    this.throwIfDisposed();
    const importer = this.accountImportOperations?.importSharedAccountsToBalancePool;
    if (!importer) {
      throw new Error("Balance-pool account import is unavailable in this Manager build");
    }
    const result = await importer(input);
    this.fireDidChange();
    return result;
  }

  onDidChange(listener: () => void): vscode.Disposable {
    this.throwIfDisposed();
    this.changeListeners.add(listener);
    return {
      dispose: () => {
        this.changeListeners.delete(listener);
      }
    };
  }

  getDashboardIntegrations(): DashboardIntegrationViewModel[] {
    if (this.disposed) {
      return [];
    }
    return [...this.dashboardIntegrations.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((registration) => this.readDashboardViewModel(registration));
  }

  getVirtualAccountCards(): Array<{ accountId: string; card: DashboardProviderAccountCardViewModel }> {
    if (this.disposed) {
      return [];
    }
    const cards: Array<{ accountId: string; card: DashboardProviderAccountCardViewModel }> = [];
    for (const [accountId, registration] of this.virtualAccounts) {
      if (!this.isVirtualAccountVisible(registration)) {
        continue;
      }
      if (!registration.getCardView) {
        continue;
      }
      try {
        const card = registration.getCardView();
        if (card.integrationId !== registration.id) {
          continue;
        }
        cards.push({ accountId, card });
      } catch {
        // Provider card data is optional; a broken card must not break the Dashboard.
      }
    }
    return cards;
  }

  getVisibleVirtualAccountIds(): ReadonlySet<string> {
    if (this.disposed) {
      return new Set<string>();
    }
    const accountIds = new Set<string>();
    for (const [accountId, registration] of this.virtualAccounts) {
      if (this.isVirtualAccountVisible(registration)) {
        accountIds.add(accountId);
      }
    }
    return accountIds;
  }

  getIntegrationSettings(): DashboardIntegrationSettingViewModel[] {
    if (this.disposed) {
      return [];
    }
    const settings: DashboardIntegrationSettingViewModel[] = [];
    for (const registration of this.virtualAccounts.values()) {
      const setting = registration.setting;
      if (!setting) {
        continue;
      }
      try {
        settings.push({
          id: setting.id,
          title: setting.title,
          description: setting.description,
          enabled: setting.getEnabled()
        });
      } catch {
        // An unavailable optional setting is omitted from the core UI.
      }
    }
    return settings;
  }

  async runDashboardAction(integrationId: string, actionId: string): Promise<void> {
    this.throwIfDisposed();
    const registration = this.dashboardIntegrations.get(normalizeIntegrationId(integrationId));
    if (!registration) {
      throw new Error("The requested Manager integration is unavailable");
    }
    const viewModel = this.readDashboardViewModel(registration);
    if (!viewModel.actions.some((action) => action.id === actionId && action.enabled !== false)) {
      throw new Error("The requested Manager integration action is unavailable");
    }
    await registration.runAction(actionId);
    this.fireDidChange();
  }

  async runVirtualAccountAction(accountId: string, actionId: string): Promise<void> {
    this.throwIfDisposed();
    const registration = this.virtualAccounts.get(accountId);
    if (!registration?.runCardAction || !registration.getCardView) {
      throw new Error("The requested virtual account action is unavailable");
    }
    const card = registration.getCardView();
    if (!card.actions?.some((action) => action.id === actionId && action.enabled !== false)) {
      throw new Error("The requested virtual account action is unavailable");
    }
    await registration.runCardAction(actionId);
    this.fireDidChange();
  }

  async updateIntegrationSetting(settingId: string, enabled: boolean): Promise<void> {
    this.throwIfDisposed();
    const entry = [...this.virtualAccounts.entries()].find(([, item]) => item.setting?.id === settingId);
    const registration = entry?.[1];
    if (!registration?.setting) {
      throw new Error("The requested Manager integration setting is unavailable");
    }
    await registration.setting.setEnabled(enabled);
    this.fireDidChange();
  }

  async deactivateVirtualAccount(
    accountId: string,
    options?: RuntimeAccountSwitchOptions
  ): Promise<RuntimeAccountSwitchOutcome> {
    this.throwIfDisposed();
    const registration = this.virtualAccounts.get(accountId);
    if (!registration) {
      return { status: "failed", message: "The virtual provider integration is unavailable" };
    }
    try {
      const result = registration.deactivate
        ? await registration.deactivate(options)
        : await this.gateway.deactivate(options);
      if (result.error) {
        return { status: "failed", message: result.error };
      }
      if (result.requiresReload) {
        return {
          status: "failed",
          message: "The seamless runtime was installed or changed; reload once before returning to ChatGPT Auth"
        };
      }
      this.activeGatewayOwner = undefined;
      await this.virtualAccountOperations?.deactivate();
      this.fireDidChange();
      return {
        status: "switched",
        accountId: accountId,
        email: null,
        activeTurns: 0,
        interruptedTurns: 0,
        continuedThreads: 0
      } satisfies HotSwitchAccountResult;
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const registration of this.dashboardIntegrations.values()) {
      registration.changeSubscription?.dispose();
    }
    for (const registration of this.virtualAccounts.values()) {
      registration.changeSubscription?.dispose();
    }
    this.dashboardIntegrations.clear();
    this.virtualAccounts.clear();
    this.gatewayLeases.clear();
    this.changeListeners.clear();
    if (this.configuredGatewayOwner || this.gatewayTransitionOwner) {
      void this.gateway.deactivate().catch(() => undefined);
    }
    this.configuredGatewayOwner = undefined;
    this.activeGatewayOwner = undefined;
    this.gatewayTransitionOwner = undefined;
  }

  async switchVirtualAccount(
    accountId: string,
    options?: RuntimeAccountSwitchOptions
  ): Promise<RuntimeAccountSwitchOutcome> {
    this.throwIfDisposed();
    const registration = this.virtualAccounts.get(accountId);
    if (!registration) {
      return { status: "failed", message: "The virtual provider integration is unavailable" };
    }
    if (this.virtualSwitchInFlight) {
      return { status: "suppressed", reason: "operationInProgress" };
    }
    const attempt = (async (): Promise<RuntimeAccountSwitchOutcome> => {
      const result = await registration.activate(options);
      if (result.error) {
        return { status: "failed", message: result.error };
      }
      if (result.requiresReload) {
        return {
          status: "failed",
          message: "The seamless runtime was installed or changed; reload once before selecting the Gateway"
        };
      }
      await this.virtualAccountOperations?.activate(accountId);
      this.activeGatewayOwner = registration.descriptor.integrationId;
      this.fireDidChange();
      return {
        status: "switched",
        accountId,
        email: null,
        activeTurns: 0,
        interruptedTurns: 0,
        continuedThreads: 0
      } satisfies HotSwitchAccountResult;
    })();
    this.virtualSwitchInFlight = attempt;
    try {
      return await attempt;
    } catch (error) {
      // Persisting the provider marker is part of the same user-visible
      // switch. If that commit fails after the runtime route changed, restore
      // ChatGPT before reporting failure.
      await this.gateway.deactivate().catch(() => undefined);
      await this.virtualAccountOperations?.deactivate().catch(() => undefined);
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.virtualSwitchInFlight === attempt) {
        this.virtualSwitchInFlight = undefined;
      }
    }
  }

  private async registerVirtualAccount(registration: VirtualAccountRegistration): Promise<vscode.Disposable> {
    this.throwIfDisposed();
    const id = registration.id.trim();
    if (!id || !INTEGRATION_ID_PATTERN.test(id)) {
      throw new Error("Virtual account IDs must use lowercase letters, digits, dots, underscores, or hyphens");
    }
    if (
      !registration.descriptor ||
      typeof registration.descriptor.integrationId !== "string" ||
      typeof registration.descriptor.baseUrl !== "string" ||
      typeof registration.descriptor.model !== "string" ||
      typeof registration.descriptor.credentialRef !== "string" ||
      registration.descriptor.integrationId.trim() !== id
    ) {
      throw new Error("The virtual account descriptor is invalid");
    }
    if (!this.virtualAccountOperations) {
      throw new Error("Virtual account registration is unavailable in this Manager build");
    }
    await this.virtualAccountOperations.upsert(registration.descriptor, registration.displayName);
    const accountId = `virtual:${id}`;
    const normalized: RegisteredVirtualAccount = { ...registration, id };
    normalized.changeSubscription = registration.onDidChange?.(() => this.fireDidChange());
    this.virtualAccounts.set(accountId, normalized);
    this.fireDidChange();
    return {
      dispose: () => {
        const current = this.virtualAccounts.get(accountId);
        if (current?.activate === registration.activate) {
          current.changeSubscription?.dispose();
          this.virtualAccounts.delete(accountId);
          this.fireDidChange();
        }
      }
    };
  }

  private isVirtualAccountVisible(registration: RegisteredVirtualAccount): boolean {
    if (!registration.setting) {
      return true;
    }
    try {
      return registration.setting.getEnabled();
    } catch {
      return false;
    }
  }

  private registerDashboardIntegration(registration: DashboardIntegrationRegistration): vscode.Disposable {
    this.throwIfDisposed();
    const id = normalizeIntegrationId(registration.id);
    if (this.dashboardIntegrations.has(id)) {
      throw new Error(`Manager integration '${id}' is already registered`);
    }
    const normalized: RegisteredDashboardIntegration = { ...registration, id };
    normalized.changeSubscription = registration.onDidChange?.(() => this.fireDidChange());
    this.dashboardIntegrations.set(id, normalized);
    this.fireDidChange();
    return {
      dispose: () => {
        const current = this.dashboardIntegrations.get(id);
        if (current !== normalized) {
          return;
        }
        current.changeSubscription?.dispose();
        this.dashboardIntegrations.delete(id);
        this.fireDidChange();
      }
    };
  }

  private registerGateway(integrationId: string): GatewayRuntimeLease {
    this.throwIfDisposed();
    const id = normalizeIntegrationId(integrationId);
    if (this.gatewayLeases.has(id)) {
      throw new Error(`Manager Gateway integration '${id}' is already registered`);
    }
    const state: GatewayRuntimeLeaseState = { disposed: false };
    this.gatewayLeases.set(id, state);
    const assertLease = () => {
      this.throwIfDisposed();
      if (state.disposed || this.gatewayLeases.get(id) !== state) {
        throw new Error(`Manager Gateway integration '${id}' is no longer registered`);
      }
    };
    return {
      integrationId: id,
      isActive: () => !state.disposed && this.activeGatewayOwner === id && this.gateway.isActive(),
      isConfigured: () => !state.disposed && this.configuredGatewayOwner === id && this.gateway.isConfigured(),
      activate: async (config, credential, options) => {
        assertLease();
        if (this.configuredGatewayOwner && this.configuredGatewayOwner !== id) {
          throw new Error("Another Manager Gateway integration already owns the local runtime");
        }
        if (this.gatewayTransitionOwner) {
          throw new Error("A Manager Gateway lifecycle transition is already in progress");
        }
        this.gatewayTransitionOwner = id;
        let shouldDeactivateOnFailure = false;
        try {
          const result = await this.gateway.activate(config, credential, options);
          if (result.error) {
            throw new Error(result.error);
          }
          shouldDeactivateOnFailure = true;
          assertLease();
          this.configuredGatewayOwner = id;
          this.activeGatewayOwner = !result.requiresReload && this.gateway.isActive() ? id : undefined;
          if (this.activeGatewayOwner && this.virtualAccounts.has(`virtual:${id}`)) {
            await this.virtualAccountOperations?.activate(`virtual:${id}`);
          } else if (result.requiresReload && this.virtualAccounts.has(`virtual:${id}`)) {
            await this.virtualAccountOperations?.deactivate();
          }
          shouldDeactivateOnFailure = false;
          this.fireDidChange();
          return result;
        } catch (error) {
          if (shouldDeactivateOnFailure) {
            void this.gateway.deactivate().catch(() => undefined);
            void this.virtualAccountOperations?.deactivate().catch(() => undefined);
          }
          throw error;
        } finally {
          if (this.gatewayTransitionOwner === id) {
            this.gatewayTransitionOwner = undefined;
          }
        }
      },
      deactivate: async () => {
        assertLease();
        if (this.gatewayTransitionOwner) {
          throw new Error("A Manager Gateway lifecycle transition is already in progress");
        }
        if (this.configuredGatewayOwner !== id) {
          return {
            enabled: false,
            configured: false,
            requiresReload: false
          };
        }
        const result = await this.gateway.deactivate();
        if (result.error) {
          throw new Error(result.error);
        }
        this.configuredGatewayOwner = undefined;
        this.activeGatewayOwner = undefined;
        await this.virtualAccountOperations?.deactivate();
        this.fireDidChange();
        return result;
      },
      configureCredential: async (credential) => {
        assertLease();
        if (this.configuredGatewayOwner !== id) {
          throw new Error("Configure the Manager Gateway before setting its credential");
        }
        return this.gateway.configureCredential(credential);
      },
      getStatus: async () => {
        assertLease();
        return this.gateway.getStatus();
      },
      fallbackToChatGpt: async () => {
        assertLease();
        if (this.gatewayTransitionOwner) {
          throw new Error("A Manager Gateway lifecycle transition is already in progress");
        }
        if (this.activeGatewayOwner !== id) {
          throw new Error("This Manager Gateway integration is not active");
        }
        const result = await this.gateway.fallbackToChatGpt();
        if (result.status === "switched") {
          this.activeGatewayOwner = undefined;
          await this.virtualAccountOperations?.deactivate();
          this.fireDidChange();
        }
        return result;
      },
      dispose: () => {
        if (state.disposed) {
          return;
        }
        state.disposed = true;
        this.gatewayLeases.delete(id);
        if (this.configuredGatewayOwner === id || this.gatewayTransitionOwner === id) {
          this.configuredGatewayOwner = undefined;
          this.activeGatewayOwner = undefined;
          if (this.gatewayTransitionOwner === id) {
            this.gatewayTransitionOwner = undefined;
          }
          void this.gateway.deactivate().catch(() => undefined);
        }
        this.fireDidChange();
      }
    };
  }

  private readDashboardViewModel(registration: DashboardIntegrationRegistration): DashboardIntegrationViewModel {
    try {
      const viewModel = registration.getViewModel();
      if (viewModel.id !== registration.id || !viewModel.title.trim() || !Array.isArray(viewModel.actions)) {
        throw new Error("invalid dashboard integration view model");
      }
      return viewModel;
    } catch {
      return {
        id: registration.id,
        title: registration.id,
        status: "error",
        statusMessage: "The integration did not provide a safe dashboard view",
        actions: []
      };
    }
  }

  private fireDidChange(): void {
    if (this.disposed) {
      return;
    }
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // An optional integration must not break the Manager host event loop.
      }
    }
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Error("Codex Accounts Manager integration host is unavailable");
    }
  }
}

let activeIntegrationHost: ManagerIntegrationHost | undefined;

export function setActiveManagerIntegrationHost(host: ManagerIntegrationHost | undefined): void {
  activeIntegrationHost = host;
}

export function getActiveManagerIntegrationHost(): ManagerIntegrationHost | undefined {
  return activeIntegrationHost;
}

function normalizeIntegrationId(value: string): string {
  const id = value.trim();
  if (!INTEGRATION_ID_PATTERN.test(id)) {
    throw new Error("Manager integration IDs must use lowercase letters, digits, dots, underscores, or hyphens");
  }
  return id;
}
