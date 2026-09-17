import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSharingService } from "../src/sharing/accountSharingService";
import type { CodexAccountRecord } from "../src/core/types";

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
