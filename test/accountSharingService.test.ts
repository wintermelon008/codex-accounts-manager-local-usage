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

import { AccountSharingService } from "../src/sharing/accountSharingService";
import type { CodexAccountRecord, SharedCodexAccountJson } from "../src/core/types";
import type { SharingLease, SharingTransfer } from "../src/sharing/types";

const directories: string[] = [];

afterEach(async () => {
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
    const second = new AccountSharingService(createContext(secondDirectory) as never, secondRepository as never, vi.fn(), {
      now: () => 200
    });

    await first.initialize();
    await second.initialize();

    expect(first.getProfile().userId).not.toBe(second.getProfile().userId);
    expect(firstRepository.setAccountSharingInfo).toHaveBeenCalledWith("account-expired", undefined);
    expect(firstRepository.unhideAccounts).toHaveBeenCalledWith(["account-expired"]);
    expect(firstRepository.removeFromBalancePool).toHaveBeenCalledWith(["account-expired"]);

    const localState = JSON.parse(
      await readFile(path.join(firstDirectory, "sharing-local-state-v1.json"), "utf8")
    ) as { version: number; keys: Record<string, string>; state: { profile: { userId: string } } };
    expect(localState.version).toBe(1);
    expect(localState.state.profile.userId).toBe(first.getProfile().userId);
    expect((await stat(path.join(firstDirectory, "sharing-local-state-v1.json")).then((item) => item.mode)) & 0o777).toBe(
      0o600
    );
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
    expect(removed).toBe(false);
    expect(service.getLeases()[0]?.state).toBe("return_pending");

    await vi.advanceTimersByTimeAsync(500);

    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input) === "https://relay.example.invalid/v1/sharing/transfers/transfer-return"
      )
    ).toBe(true);
    expect(repo.removeAccount).toHaveBeenCalledWith(accountId);
    expect(removed).toBe(true);
    expect(service.getLeases()[0]?.state).toBe("returned");
    expect(service.getLeases()[0]?.accountIds).toEqual([]);
    service.dispose();
    vi.useRealTimers();
    fetchWithTimeoutMock.mockReset();
  });
});
