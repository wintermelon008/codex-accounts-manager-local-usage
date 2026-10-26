import { createRequire } from "node:module";
import * as path from "node:path";
import type { AccountsRepository } from "../storage";
import { resolveMailboxRuntimeRoot } from "../integrations/mailboxRuntimePath";
import { fetchWithConfiguredProxy } from "../utils/network";
import { withRenewingSchedulerLease } from "./schedulerLease";

type MailboxMetadata = {
  id: string;
  address: string;
  providerId: string;
  enabled?: boolean;
  autoRenewalNextAt?: number;
  autoRenewalBlocked?: boolean;
  openaiAccountDeactivated?: boolean;
};

type MailboxProvider = {
  id: string;
  renew?: (account: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
};

type MailboxPool = {
  load(): Promise<unknown>;
  reload(): Promise<unknown>;
  listMetadata(options?: { includeDisabled?: boolean }): MailboxMetadata[];
  initializeAutomaticRenewalSchedules(ids: string[], now?: number): Promise<unknown>;
};

type MailboxCoordinator = {
  isActive(mailboxId?: string): boolean;
  renew(
    ids: string[] | undefined,
    options?: { automatic?: boolean; maxConcurrent?: number }
  ): Promise<{ results?: unknown[] }>;
};

type MailboxModules = {
  createServerMailboxStores(options: { storageUri: { fsPath: string } }): {
    metadataStore: unknown;
    secretStore: unknown;
    migrateLegacy?: () => Promise<boolean>;
  };
  MailboxPool: new (options: { metadataStore: unknown; secretStore: unknown }) => MailboxPool;
  MailboxOperationCoordinator: new (options: {
    pool: MailboxPool;
    providers: { get(id: string): MailboxProvider | undefined };
    maxConcurrent?: number;
  }) => MailboxCoordinator;
  MailboxProviderRegistry: new (providers: MailboxProvider[]) => { get(id: string): MailboxProvider | undefined };
  providerConstructors: Array<new (options?: { fetchImpl?: typeof fetch }) => { asProvider(): MailboxProvider }>;
};

const MAILBOX_RENEWAL_LEASE_MS = 5 * 60 * 1000;
const requireModule = createRequire(__filename);

/** Headless Mailbox provider host. UI-only registration and clipboard flows stay in the extension. */
export class MailboxDaemonService {
  private readonly pool: MailboxPool;
  private readonly coordinator: MailboxCoordinator;
  private readonly providers: { get(id: string): MailboxProvider | undefined };
  private timer: NodeJS.Timeout | undefined;
  private scanInFlight: Promise<unknown> | undefined;
  private disposed = false;

  constructor(
    private readonly repo: AccountsRepository,
    privateRoot: string,
    private readonly scanIntervalMs: number
  ) {
    const modules = loadMailboxModules();
    const stores = modules.createServerMailboxStores({ storageUri: { fsPath: privateRoot } });
    this.pool = new modules.MailboxPool({
      metadataStore: stores.metadataStore,
      secretStore: stores.secretStore
    });
    this.providers = new modules.MailboxProviderRegistry(
      modules.providerConstructors
        .map((Provider) => new Provider({ fetchImpl: fetchWithConfiguredProxy }).asProvider())
    );
    this.coordinator = new modules.MailboxOperationCoordinator({
      pool: this.pool,
      providers: this.providers,
      maxConcurrent: 1
    });
    this.migrateLegacy = stores.migrateLegacy;
  }

  private readonly migrateLegacy?: () => Promise<boolean>;

  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.migrateLegacy?.();
    await this.pool.load();
    void this.runAutomaticRenewalScan().catch((error: unknown) => {
      console.warn(`[codexAccounts] daemon Mailbox renewal scan failed: ${getErrorMessage(error)}`);
    });
    this.timer = setInterval(() => {
      void this.runAutomaticRenewalScan().catch((error: unknown) => {
        console.warn(`[codexAccounts] daemon Mailbox renewal scan failed: ${getErrorMessage(error)}`);
      });
    }, this.scanIntervalMs);
    this.timer.unref?.();
  }

  async runAutomaticRenewalScan(now = Date.now()): Promise<unknown> {
    if (this.disposed || this.scanInFlight) {
      return this.scanInFlight;
    }
    const task = this.runScan(now);
    this.scanInFlight = task;
    try {
      return await task;
    } finally {
      if (this.scanInFlight === task) {
        this.scanInFlight = undefined;
      }
    }
  }

  async renew(mailboxIds?: readonly string[]): Promise<unknown> {
    const result = await withRenewingSchedulerLease(
      this.repo,
      "mailbox-renewal",
      MAILBOX_RENEWAL_LEASE_MS,
      250,
      async (leaseIsActive) => {
        if (!leaseIsActive()) {
          throw new Error("Mailbox renewal lease was lost before the operation started");
        }
        await this.pool.reload();
        if (!leaseIsActive()) {
          throw new Error("Mailbox renewal lease was lost before provider execution");
        }
        return this.coordinator.renew(mailboxIds ? [...mailboxIds] : undefined, {
          automatic: false,
          maxConcurrent: 1
        });
      }
    );
    if (result === undefined) {
      throw new Error("Another Mailbox renewal operation is already running");
    }
    return result;
  }

  getDeactivatedMailboxEmails(): readonly string[] {
    return this.pool
      .listMetadata({ includeDisabled: true })
      .filter((mailbox) => mailbox.enabled !== false && mailbox.openaiAccountDeactivated === true)
      .map((mailbox) => mailbox.address);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async runScan(now: number): Promise<unknown> {
    const result = await withRenewingSchedulerLease(
      this.repo,
      "mailbox-renewal",
      MAILBOX_RENEWAL_LEASE_MS,
      0,
      async (leaseIsActive) => {
        await this.pool.reload();
        if (!leaseIsActive()) {
          return { operation: "automatic-renewal", results: [], skipped: true };
        }
        const eligible = this.pool
          .listMetadata({ includeDisabled: false })
          .filter((mailbox) => {
            const provider = this.providers.get(mailbox.providerId);
            return typeof provider?.renew === "function";
          });
        const eligibleIds = eligible.map((mailbox) => mailbox.id);
        await this.pool.initializeAutomaticRenewalSchedules(eligibleIds, now);
        const eligibleIdSet = new Set(eligibleIds);
        const dueIds = this.pool
          .listMetadata({ includeDisabled: false })
          .filter(
            (mailbox) =>
              eligibleIdSet.has(mailbox.id) &&
              mailbox.autoRenewalBlocked !== true &&
              Number.isFinite(mailbox.autoRenewalNextAt) &&
              mailbox.autoRenewalNextAt! <= now &&
              !this.coordinator.isActive(mailbox.id)
          )
          .map((mailbox) => mailbox.id);
        if (dueIds.length === 0) {
          return { operation: "automatic-renewal", results: [], skipped: false };
        }
        if (!leaseIsActive()) {
          return { operation: "automatic-renewal", results: [], skipped: true };
        }
        return this.coordinator.renew(dueIds, { automatic: true, maxConcurrent: 1 });
      }
    );
    if (result === undefined) {
      return { operation: "automatic-renewal", results: [], skipped: true };
    }
    return result;
  }
}

function loadMailboxModules(): MailboxModules {
  // The provider implementation is copied into the Manager artifact during
  // compile so the VS Code and daemon paths share exactly one runtime module.
  const root = resolveMailboxRuntimeRoot();
  const storage = loadModule<Pick<MailboxModules, "createServerMailboxStores">>(
    path.join(root, "mailbox/server-storage.cjs")
  );
  const mailboxStorage = loadModule<Pick<MailboxModules, "MailboxPool">>(
    path.join(root, "mailbox/storage.cjs")
  );
  const coordinator = loadModule<Pick<MailboxModules, "MailboxOperationCoordinator">>(
    path.join(root, "operations/coordinator.cjs")
  );
  const registry = loadModule<Pick<MailboxModules, "MailboxProviderRegistry">>(
    path.join(root, "core/providers/index.cjs")
  );
  type ProviderModule = { Provider: MailboxModules["providerConstructors"][number] };
  const providerConstructors = [
    loadModule<{ Eight92Provider: ProviderModule["Provider"] }>(
      path.join(root, "core/providers/eight92.cjs")
    ).Eight92Provider,
    loadModule<{ OutlookLocalProvider: ProviderModule["Provider"] }>(
      path.join(root, "core/providers/outlook-local.cjs")
    ).OutlookLocalProvider,
    loadModule<{ BoyaProvider: ProviderModule["Provider"] }>(
      path.join(root, "core/providers/boya.cjs")
    ).BoyaProvider,
    loadModule<{ CdnsProvider: ProviderModule["Provider"] }>(
      path.join(root, "core/providers/cdns.cjs")
    ).CdnsProvider,
    loadModule<{ TototoIcloudProvider: ProviderModule["Provider"] }>(
      path.join(root, "core/providers/tototo-icloud.cjs")
    ).TototoIcloudProvider
  ];

  return {
    createServerMailboxStores: storage.createServerMailboxStores,
    MailboxPool: mailboxStorage.MailboxPool,
    MailboxOperationCoordinator: coordinator.MailboxOperationCoordinator,
    MailboxProviderRegistry: registry.MailboxProviderRegistry,
    providerConstructors
  };
}

function loadModule<T>(modulePath: string): T {
  return requireModule(modulePath) as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
