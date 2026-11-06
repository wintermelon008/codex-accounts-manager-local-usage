import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchWithTimeoutMock } = vi.hoisted(() => ({
  fetchWithTimeoutMock: vi.fn()
}));

vi.mock("../src/utils/network", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/network")>("../src/utils/network");
  return { ...actual, fetchWithTimeout: fetchWithTimeoutMock };
});

vi.mock("../src/auth/tokenRefreshCoordinator", () => ({
  ensureFreshAccountTokens: vi.fn(
    async (_repo: unknown, _accountId: string, options: { fallbackTokens?: unknown }) => options.fallbackTokens
  )
}));

import { AccountSharingService } from "../src/sharing/accountSharingService";
import type { CodexAccountRecord, SharedCodexAccountJson } from "../src/core/types";
import type { CredentialSyncRecord, SharingLease, SharingTransfer } from "../src/sharing/types";

const directories: string[] = [];

afterEach(async () => {
  fetchWithTimeoutMock.mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AccountSharingService local identity state", () => {
  it("isolates identities per extension host and recovers expired owner metadata", async () => {
    const firstDirectory = await mkdtemp(path.join(tmpdir(), "codex-sharing-host-a-"));
    const secondDirectory = await mkdtemp(path.join(tmpdir(), "codex-sharing-host-b-"));
    directories.push(firstDirectory, secondDirectory);

    const expiredAccount: CodexAccountRecord = {
      id: "account-expired",
      email: "expired@example.invalid",
      isActive: false,
      isHidden: true,
      balancePoolEnabled: false,
      createdAt: 1,
      updatedAt: 1,
      sharing: {
        leaseId: "lease-expired",
        transferId: "transfer-expired",
        direction: "outgoing",
        state: "shared",
        peerUserId: "rw_peer_1234567890",
        expiresAt: 100,
        sharedAt: 1
      }
    };
    const createRepository = () => ({
      listAccounts: vi.fn(async () => [expiredAccount]),
      onDidChangeAccounts: vi.fn(() => ({ dispose: vi.fn() })),
      setAccountSharingInfo: vi.fn(async () => expiredAccount),
      unhideAccounts: vi.fn(async () => [expiredAccount]),
      removeFromBalancePool: vi.fn(async () => [expiredAccount])
    });
    const createContext = (directory: string) => ({
      globalStorageUri: { fsPath: directory },
      globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
      secrets: { delete: vi.fn(async () => undefined) }
    });

    const firstRepository = createRepository();
    const secondRepository = createRepository();
    const first = new AccountSharingService(createContext(firstDirectory) as never, firstRepository as never, vi.fn(), {
      now: () => 200
    });
    const second = new AccountSharingService(
      createContext(secondDirectory) as never,
      secondRepository as never,
      vi.fn(),
      {
        now: () => 200
      }
    );

    await first.initialize();
    await second.initialize();

    expect(first.getProfile().userId).not.toBe(second.getProfile().userId);
    expect(firstRepository.setAccountSharingInfo).toHaveBeenCalledWith("account-expired", undefined);
    expect(firstRepository.unhideAccounts).toHaveBeenCalledWith(["account-expired"]);
    expect(firstRepository.removeFromBalancePool).toHaveBeenCalledWith(["account-expired"]);

    const localState = JSON.parse(await readFile(path.join(firstDirectory, "sharing-local-state-v1.json"), "utf8")) as {
      version: number;
      keys: Record<string, string>;
      state: { profile: { userId: string } };
    };
    expect(localState.version).toBe(1);
    expect(localState.state.profile.userId).toBe(first.getProfile().userId);
    expect(
      (await stat(path.join(firstDirectory, "sharing-local-state-v1.json")).then((item) => item.mode)) & 0o777
    ).toBe(0o600);
  });

  it("repairs owner metadata after a terminal return outlives the sent-transfer listing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-sharing-owner-repair-"));
    directories.push(directory);

    const accountId = "account-owner-repair";
    const leaseId = "lease-owner-repair";
    const account: CodexAccountRecord = {
      id: accountId,
      email: "owner-repair@example.invalid",
      isActive: false,
      isHidden: true,
      balancePoolEnabled: false,
      createdAt: 1,
      updatedAt: 1,
      sharing: {
        leaseId,
        transferId: "transfer-owner-repair",
        direction: "outgoing",
        state: "shared",
        peerUserId: "rw_peer_1234567890",
        expiresAt: 10_000,
        sharedAt: 1
      }
    };
    const repo = {
      listAccounts: vi.fn(async () => [account]),
      onDidChangeAccounts: vi.fn(() => ({ dispose: vi.fn() })),
      getAccount: vi.fn(async (id: string) => (id === accountId ? account : undefined)),
      setAccountSharingInfo: vi.fn(async (_id: string, sharing: CodexAccountRecord["sharing"]) => {
        account.sharing = sharing;
        return account;
      }),
      unhideAccounts: vi.fn(async () => {
        account.isHidden = false;
        return [account];
      }),
      setBalancePoolMembership: vi.fn(async (_id: string, enabled: boolean) => {
        account.balancePoolEnabled = enabled;
        return account;
      })
    };
    const context = {
      globalStorageUri: { fsPath: directory },
      globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
      secrets: { delete: vi.fn(async () => undefined) }
    };
    const service = new AccountSharingService(context as never, repo as never, vi.fn(), {
      now: () => 100,
      relayUrl: () => "https://relay.example.invalid"
    });
    await service.initialize();

    const internals = service as unknown as {
      relayToken: string;
      relayRegistrationValidatedAt: number;
      state: { leases: SharingLease[] };
    };
    internals.relayToken = "relay-token";
    internals.relayRegistrationValidatedAt = 100;
    internals.state.leases = [
      {
        leaseId,
        transferId: "transfer-owner-repair",
        direction: "outgoing",
        state: "returned",
        peerUserId: "rw_peer_1234567890",
        accountIds: [],
        expiresAt: 10_000,
        createdAt: 1,
        ownerAccountStates: [{ accountId, isHidden: false, balancePoolEnabled: true }]
      }
    ];

    fetchWithTimeoutMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.endsWith("/transfers/inbox")
        ? { transfers: [] }
        : url.endsWith("/requests/inbox") || url.endsWith("/requests/mine")
          ? { requests: [] }
          : url.endsWith("/transfers/sent")
            ? { transfers: [] }
            : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });

    await service.poll();

    expect(account.sharing).toBeUndefined();
    expect(account.isHidden).toBe(false);
    expect(account.balancePoolEnabled).toBe(true);
    expect(repo.setAccountSharingInfo).toHaveBeenCalledWith(accountId, undefined);
    expect(repo.setBalancePoolMembership).toHaveBeenCalledWith(accountId, true);
    service.dispose();
    fetchWithTimeoutMock.mockReset();
  });
});

describe("AccountSharingService feature toggle compatibility", () => {
  it("keeps active leases enabled and preserves local state when toggled off", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-sharing-toggle-"));
    directories.push(directory);
    const globalState = {
      get: vi.fn(() => undefined),
      update: vi.fn(async () => undefined)
    };
    const repo = {
      listAccounts: vi.fn(async () => []),
      onDidChangeAccounts: vi.fn(() => ({ dispose: vi.fn() }))
    };
    const service = new AccountSharingService(
      {
        globalStorageUri: { fsPath: directory },
        globalState,
        secrets: { delete: vi.fn(async () => undefined) }
      } as never,
      repo as never,
      vi.fn()
    );
    await service.initialize();

    const internals = service as unknown as { state: { leases: SharingLease[] } };
    internals.state.leases = [{ state: "shared" } as SharingLease];
    await expect(service.setEnabled(false)).rejects.toThrow("活动共享租约");
    expect(service.isEnabled()).toBe(true);

    internals.state.leases = [];
    await service.setEnabled(false);
    expect(service.isEnabled()).toBe(false);
    expect(globalState.update).toHaveBeenCalledWith("codexAccounts.accountSharing.enabled.v1", false);
    await service.setEnabled(true);
    expect(service.isEnabled()).toBe(true);
    service.dispose();
  });
});

describe("AccountSharingService manual remote usage reads", () => {
  it("stores request metadata separately and leaves credential sync state unchanged", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-sharing-usage-request-"));
    directories.push(directory);
    const repo = {
      listAccounts: vi.fn(async () => []),
      onDidChangeAccounts: vi.fn(() => ({ dispose: vi.fn() }))
    };
    const context = {
      globalStorageUri: { fsPath: directory },
      globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
      secrets: { delete: vi.fn(async () => undefined) }
    };
    const service = new AccountSharingService(context as never, repo as never, vi.fn(), {
      now: () => 1_000,
      relayUrl: () => "https://relay.example.invalid",
      bootstrapToken: () => "bootstrap-token"
    });
    await service.initialize();

    const sync: CredentialSyncRecord = {
      syncId: "sync-primary-1234567890",
      role: "primary",
      state: "active",
      peerUserId: "rw_peer_1234567890",
      peerDisplayName: "U280",
      accountIds: ["account-1"],
      version: 4,
      createdAt: 900
    };
    const internals = service as unknown as { state: { credentialSyncs: CredentialSyncRecord[] } };
    internals.state.credentialSyncs = [sync];
    await (service as unknown as { persistState: () => Promise<void> }).persistState();
    const sharingStatePath = path.join(directory, "sharing-local-state-v1.json");
    const before = JSON.parse(await readFile(sharingStatePath, "utf8")) as { state: unknown };
    const poll = vi.spyOn(service, "poll").mockResolvedValue(undefined);
    const calls: Array<{ url: string; body?: string }> = [];
    fetchWithTimeoutMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/v1/sharing/register")) {
        return new Response(JSON.stringify({ mailboxToken: "mailbox-token" }), { status: 200 });
      }
      if (url.endsWith("/v1/sharing/usage-requests")) {
        return new Response(
          JSON.stringify({
            requests: [
              {
                id: "usage-request-1",
                syncId: sync.syncId,
                fromUserId: service.getProfile().userId,
                toUserId: sync.peerUserId,
                state: "pending",
                createdAt: 1_000,
                expiresAt: 61_000
              }
            ]
          }),
          { status: 201 }
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await service.refreshRemoteAccountUsage();

    expect(poll).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.url)).toEqual([
      "https://relay.example.invalid/v1/sharing/register",
      "https://relay.example.invalid/v1/sharing/usage-requests"
    ]);
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ syncIds: [sync.syncId] });

    const after = JSON.parse(await readFile(sharingStatePath, "utf8")) as { state: unknown };
    expect(after.state).toEqual(before.state);
    await expect(readFile(path.join(directory, "shared-account-usage-v1.json"), "utf8")).resolves.toContain(
      '"requestId":"usage-request-1"'
    );
    expect(service.getDashboardView()).toMatchObject({
      usageReadAvailable: true,
      usageReadPending: true,
      accountUsageSources: []
    });
    service.dispose();
  });
});

describe("AccountSharingService multi-device credential sync", () => {
  it("allows one primary account to create independent syncs for different followers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-sharing-multi-follower-"));
    directories.push(directory);
    const account: CodexAccountRecord = {
      id: "account-shared-many",
      email: "shared-many@example.invalid",
      isActive: false,
      createdAt: 1,
      updatedAt: 1
    };
    const shared: SharedCodexAccountJson = {
      id: account.id,
      email: account.email,
      tokens: { id_token: "id-token", access_token: "access-token", refresh_token: "refresh-token" }
    };
    const repo = {
      listAccounts: vi.fn(async () => [account]),
      onDidChangeAccounts: vi.fn(() => ({ dispose: vi.fn() })),
      getAccount: vi.fn(async (accountId: string) => (accountId === account.id ? account : undefined)),
      getTokens: vi.fn(async () => ({
        idToken: "id-token",
        accessToken: "access-token",
        refreshToken: "refresh-token"
      })),
      exportSharedAccounts: vi.fn(async () => [shared]),
      setAccountCredentialSyncInfo: vi.fn(async (_accountId: string, value: CodexAccountRecord["credentialSync"]) => {
        account.credentialSync = value;
        return account;
      })
    };
    const context = {
      globalStorageUri: { fsPath: directory },
      globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
      secrets: { delete: vi.fn(async () => undefined) }
    };
    const service = new AccountSharingService(context as never, repo as never, vi.fn(), {
      now: () => 1_000,
      relayUrl: () => "https://relay.example.invalid",
      bootstrapToken: () => "bootstrap-token"
    });
    await service.initialize();
    const profile = service.getProfile();
    const internals = service as unknown as {
      state: { peers: Array<typeof profile & { relationship: "trusted"; addedAt: number }> };
      relayToken: string;
      relayRegistrationValidatedAt: number;
    };
    internals.relayToken = "relay-token";
    internals.relayRegistrationValidatedAt = 1_000;
    internals.state.peers = [
      { ...profile, userId: "rw_follower_a1234567890", displayName: "Follower A", relationship: "trusted", addedAt: 1 },
      { ...profile, userId: "rw_follower_b1234567890", displayName: "Follower B", relationship: "trusted", addedAt: 1 }
    ];
    vi.spyOn(
      service as unknown as { publishCredentialSyncRecord: (...args: unknown[]) => Promise<void> },
      "publishCredentialSyncRecord"
    ).mockImplementation(async (value) => {
      const sync = value as CredentialSyncRecord;
      sync.state = "active";
      sync.version = 1;
      sync.pendingUpdate = undefined;
    });
    fetchWithTimeoutMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/sharing/credential-syncs/inbox")) {
        return new Response(JSON.stringify({ credentialSyncs: [] }), { status: 200 });
      }
      if (url.includes("/v1/sharing/credential-syncs/") && url.endsWith("/stop")) {
        return new Response(JSON.stringify({ state: "stopped" }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await service.startCredentialSyncWithPeer([account.id], "rw_follower_a1234567890");
    await service.startCredentialSyncWithPeer([account.id], "rw_follower_b1234567890");

    const syncs = service.getCredentialSyncs();
    expect(syncs).toHaveLength(2);
    expect(syncs.map((sync) => sync.peerUserId)).toEqual(["rw_follower_a1234567890", "rw_follower_b1234567890"]);
    expect(account.credentialSync).toMatchObject({
      role: "primary",
      peerUserId: "rw_follower_a1234567890"
    });
    expect(service.getDashboardView().usageReadAvailable).toBe(true);

    await expect(service.stopCredentialSyncForAccount(account.id, syncs[0]?.syncId)).resolves.toBe(true);
    expect(service.getCredentialSyncs()).toHaveLength(1);
    expect(account.credentialSync).toMatchObject({
      role: "primary",
      peerUserId: "rw_follower_b1234567890"
    });
    service.dispose();
  });

  it("deletes follower accounts and credentials when the follower returns a sync", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-sharing-follower-return-"));
    directories.push(directory);
    const account: CodexAccountRecord = {
      id: "account-follower-return",
      email: "follower-return@example.invalid",
      isActive: false,
      createdAt: 1,
      updatedAt: 1,
      credentialSync: {
        syncId: "sync-follower-return",
        role: "follower",
        peerUserId: "rw_primary_1234567890",
        since: 1
      }
    };
    let removed = false;
    const repo = {
      listAccounts: vi.fn(async () => (removed ? [] : [account])),
      onDidChangeAccounts: vi.fn(() => ({ dispose: vi.fn() })),
      getAccount: vi.fn(async (accountId: string) => (accountId === account.id && !removed ? account : undefined)),
      setAccountCredentialSyncInfo: vi.fn(async (_accountId: string, value: CodexAccountRecord["credentialSync"]) => {
        account.credentialSync = value;
        return account;
      }),
      removeAccount: vi.fn(async () => {
        removed = true;
      })
    };
    const context = {
      globalStorageUri: { fsPath: directory },
      globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
      secrets: { delete: vi.fn(async () => undefined) }
    };
    const service = new AccountSharingService(context as never, repo as never, vi.fn(), {
      now: () => 1_000,
      relayUrl: () => "https://relay.example.invalid",
      bootstrapToken: () => "bootstrap-token"
    });
    await service.initialize();
    const internals = service as unknown as {
      state: { credentialSyncs: CredentialSyncRecord[] };
      relayToken: string;
      relayRegistrationValidatedAt: number;
    };
    internals.relayToken = "relay-token";
    internals.relayRegistrationValidatedAt = 1_000;
    internals.state.credentialSyncs = [
      {
        syncId: "sync-follower-return",
        role: "follower",
        state: "active",
        peerUserId: "rw_primary_1234567890",
        accountIds: [account.id],
        version: 1,
        createdAt: 1
      }
    ];
    fetchWithTimeoutMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/sharing/credential-syncs/sync-follower-return/stop")) {
        return new Response(JSON.stringify({ state: "stopped" }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(service.stopCredentialSyncForAccount(account.id, "sync-follower-return")).resolves.toBe(true);

    expect(repo.setAccountCredentialSyncInfo).toHaveBeenCalledWith(account.id, undefined);
    expect(repo.removeAccount).toHaveBeenCalledWith(account.id);
    expect(removed).toBe(true);
    expect(service.getCredentialSyncs()).toEqual([]);
    service.dispose();
  });

  it("does not wait for follower usage reports before completing the sharing poll", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-sharing-usage-async-"));
    directories.push(directory);
    const repo = {
      listAccounts: vi.fn(async () => []),
      onDidChangeAccounts: vi.fn(() => ({ dispose: vi.fn() }))
    };
    const context = {
      globalStorageUri: { fsPath: directory },
      globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
      secrets: { delete: vi.fn(async () => undefined) }
    };
    const service = new AccountSharingService(context as never, repo as never, vi.fn(), {
      now: () => 1_000,
      relayUrl: () => "https://relay.example.invalid",
      bootstrapToken: () => "bootstrap-token"
    });
    await service.initialize();
    const internals = service as unknown as {
      state: { credentialSyncs: CredentialSyncRecord[] };
      relayToken: string;
      relayRegistrationValidatedAt: number;
      pollCredentialSyncs: () => Promise<void>;
    };
    internals.relayToken = "relay-token";
    internals.relayRegistrationValidatedAt = 1_000;
    internals.state.credentialSyncs = [
      {
        syncId: "sync-follower-a",
        role: "follower",
        state: "active",
        peerUserId: "rw_primary_a1234567890",
        accountIds: ["account-a"],
        version: 1,
        createdAt: 1
      },
      {
        syncId: "sync-follower-b",
        role: "follower",
        state: "active",
        peerUserId: "rw_primary_b1234567890",
        accountIds: ["account-b"],
        version: 1,
        createdAt: 1
      }
    ];
    fetchWithTimeoutMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/sharing/credential-syncs/inbox") || url.endsWith("/v1/sharing/credential-syncs/sent")) {
        return new Response(JSON.stringify({ credentialSyncs: [], usageRequests: [], usageUpdates: [] }), {
          status: 200
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    vi.spyOn(
      service as unknown as { publishFollowerAccountUsageUpdate: (sync: CredentialSyncRecord) => Promise<void> },
      "publishFollowerAccountUsageUpdate"
    ).mockImplementation(async () => {
      started += 1;
      await gate;
    });

    const pollPromise = internals.pollCredentialSyncs();
    while (started < 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    let pollSettled = false;
    void pollPromise.then(() => {
      pollSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pollSettled).toBe(true);
    release();
    await pollPromise;
    service.dispose();
  });
});

describe("AccountSharingService return confirmation", () => {
  it("polls the owner acknowledgement after one return action", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(path.join(tmpdir(), "codex-sharing-return-"));
    directories.push(directory);

    const accountId = "account-return";
    const leaseId = "lease-return";
    const transferId = "transfer-return";
    const account: CodexAccountRecord = {
      id: accountId,
      email: "borrowed@example.invalid",
      isActive: false,
      isHidden: false,
      balancePoolEnabled: true,
      createdAt: 1,
      updatedAt: 1,
      sharing: {
        leaseId,
        transferId,
        direction: "incoming",
        state: "received",
        peerUserId: "rw_owner_1234567890",
        peerDisplayName: "Owner",
        expiresAt: 10_000,
        sharedAt: 1
      }
    };
    let removed = false;
    const repo = {
      listAccounts: vi.fn(async () => (removed ? [] : [account])),
      onDidChangeAccounts: vi.fn(() => ({ dispose: vi.fn() })),
      getAccount: vi.fn(async (id: string) => (id === accountId && !removed ? account : undefined)),
      exportSharedAccountsForReturn: vi.fn(async () => [
        { id: accountId, email: account.email } satisfies SharedCodexAccountJson
      ]),
      setAccountSharingInfo: vi.fn(async () => account),
      removeFromBalancePool: vi.fn(async () => [account]),
      removeAccount: vi.fn(async (id: string) => {
        if (id === accountId) {
          removed = true;
        }
      })
    };
    const context = {
      globalStorageUri: { fsPath: directory },
      globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
      secrets: { delete: vi.fn(async () => undefined) }
    };
    const onChanged = vi.fn();
    const service = new AccountSharingService(context as never, repo as never, onChanged, {
      now: () => 100,
      relayUrl: () => "https://relay.example.invalid"
    });
    await service.initialize();

    const serviceState = service as unknown as {
      relayToken: string;
      relayRegistrationValidatedAt: number;
      state: {
        peers: Array<{
          userId: string;
          displayName: string;
          identityPublicKey: string;
          encryptionPublicKey: string;
          relationship: "trusted";
          addedAt: number;
        }>;
        leases: SharingLease[];
      };
    };
    const profile = service.getProfile();
    serviceState.relayToken = "relay-token";
    serviceState.relayRegistrationValidatedAt = 100;
    serviceState.state.peers = [
      {
        userId: "rw_owner_1234567890",
        displayName: "Owner",
        identityPublicKey: profile.identityPublicKey,
        encryptionPublicKey: profile.encryptionPublicKey,
        relationship: "trusted",
        addedAt: 1
      }
    ];
    serviceState.state.leases = [
      {
        leaseId,
        transferId,
        direction: "incoming",
        state: "received",
        peerUserId: "rw_owner_1234567890",
        peerDisplayName: "Owner",
        accountIds: [accountId],
        expiresAt: 10_000,
        createdAt: 1
      }
    ];

    const transfer = {
      id: transferId,
      fromUserId: "rw_owner_1234567890",
      toUserId: profile.userId,
      expiresAt: 10_000,
      envelope: {},
      state: "returned",
      createdAt: 1,
      updatedAt: 100
    } satisfies Omit<SharingTransfer, "ownerConfirmedAccountIds">;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body: SharingTransfer = url.endsWith("/return")
        ? { ...transfer, ownerConfirmedAccountIds: [] }
        : { ...transfer, ownerConfirmedAccountIds: [accountId] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    fetchWithTimeoutMock.mockImplementation(fetchMock);

    await expect(service.returnLease(leaseId)).resolves.toBe(true);
    expect(repo.removeAccount).toHaveBeenCalledWith(accountId);
    expect(removed).toBe(true);
    expect(service.getLeases()[0]?.state).toBe("return_pending");

    await vi.advanceTimersByTimeAsync(500);

    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input) === "https://relay.example.invalid/v1/sharing/transfers/transfer-return"
      )
    ).toBe(true);
    expect(removed).toBe(true);
    expect(service.getLeases()[0]?.state).toBe("returned");
    expect(service.getLeases()[0]?.accountIds).toEqual([]);
    service.dispose();
    vi.useRealTimers();
    fetchWithTimeoutMock.mockReset();
  });
});
