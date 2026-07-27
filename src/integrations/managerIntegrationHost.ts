import type * as vscode from "vscode";
import type { GatewayRuntimeStatus, RuntimeAccountSwitchOutcome } from "../codex/hotSwitchBridge";
import type { GatewayRuntimeConfig, HotSwitchSetupResult } from "../codex/hotSwitchRuntime";
import type { DashboardIntegrationViewModel } from "../domain/dashboard/types";

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
  activate: (config: GatewayRuntimeConfig, credential?: string) => Promise<HotSwitchSetupResult>;
  deactivate: () => Promise<HotSwitchSetupResult>;
  configureCredential: (credential: string) => Promise<GatewayRuntimeStatus>;
  getStatus: () => Promise<GatewayRuntimeStatus>;
  fallbackToChatGpt: () => Promise<RuntimeAccountSwitchOutcome>;
};

export type CodexAccountsIntegrationApi = {
  readonly apiVersion: typeof MANAGER_INTEGRATION_API_VERSION;
  registerDashboardIntegration: (registration: DashboardIntegrationRegistration) => vscode.Disposable;
  registerGateway: (integrationId: string) => GatewayRuntimeLease;
};

type GatewayRuntimeOperations = {
  isActive: () => boolean;
  isConfigured: () => boolean;
  activate: (config: GatewayRuntimeConfig, credential?: string) => Promise<HotSwitchSetupResult>;
  deactivate: () => Promise<HotSwitchSetupResult>;
  configureCredential: (credential: string) => Promise<GatewayRuntimeStatus>;
  getStatus: () => Promise<GatewayRuntimeStatus>;
  fallbackToChatGpt: () => Promise<RuntimeAccountSwitchOutcome>;
};

type RegisteredDashboardIntegration = DashboardIntegrationRegistration & {
  changeSubscription?: vscode.Disposable;
};

type GatewayRuntimeLeaseState = {
  disposed: boolean;
};

/**
 * The only Manager surface available to optional integrations. It deliberately
 * does not expose extension storage, account tokens, settings, workspace
 * paths, or any provider-specific controller.
 */
export class ManagerIntegrationHost implements vscode.Disposable {
  readonly api: CodexAccountsIntegrationApi;

  private readonly dashboardIntegrations = new Map<string, RegisteredDashboardIntegration>();
  private readonly gatewayLeases = new Map<string, GatewayRuntimeLeaseState>();
  private readonly changeListeners = new Set<() => void>();
  private configuredGatewayOwner: string | undefined;
  private activeGatewayOwner: string | undefined;
  private gatewayTransitionOwner: string | undefined;
  private disposed = false;

  constructor(private readonly gateway: GatewayRuntimeOperations) {
    this.api = {
      apiVersion: MANAGER_INTEGRATION_API_VERSION,
      registerDashboardIntegration: (registration) => this.registerDashboardIntegration(registration),
      registerGateway: (integrationId) => this.registerGateway(integrationId)
    };
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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const registration of this.dashboardIntegrations.values()) {
      registration.changeSubscription?.dispose();
    }
    this.dashboardIntegrations.clear();
    this.gatewayLeases.clear();
    this.changeListeners.clear();
    if (this.configuredGatewayOwner || this.gatewayTransitionOwner) {
      void this.gateway.deactivate().catch(() => undefined);
    }
    this.configuredGatewayOwner = undefined;
    this.activeGatewayOwner = undefined;
    this.gatewayTransitionOwner = undefined;
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
      activate: async (config, credential) => {
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
          const result = await this.gateway.activate(config, credential);
          if (result.error) {
            throw new Error(result.error);
          }
          shouldDeactivateOnFailure = true;
          assertLease();
          this.configuredGatewayOwner = id;
          this.activeGatewayOwner = this.gateway.isActive() ? id : undefined;
          shouldDeactivateOnFailure = false;
          this.fireDidChange();
          return result;
        } catch (error) {
          if (shouldDeactivateOnFailure) {
            void this.gateway.deactivate().catch(() => undefined);
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
