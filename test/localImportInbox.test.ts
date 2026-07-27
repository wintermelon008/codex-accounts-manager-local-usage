import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refreshImportedAccountQuotaMock, getBalanceQuotaCapabilityMock } = vi.hoisted(() => ({
  refreshImportedAccountQuotaMock: vi.fn(),
  getBalanceQuotaCapabilityMock: vi.fn()
}));

vi.mock("../src/application/accounts/quota", () => ({
  refreshImportedAccountQuota: refreshImportedAccountQuotaMock
}));

vi.mock("../src/application/accounts/balanceScheduler", () => ({
  getBalanceQuotaCapability: getBalanceQuotaCapabilityMock
}));

import { getLocalImportInboxPath, LocalImportInbox } from "../src/presentation/workbench/localImportInbox";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("LocalImportInbox", () => {
  let temporaryDirectory: string;
  let previousManagerQueueDirectory: string | undefined;
  let previousLegacyQueueDirectory: string | undefined;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-import-inbox-test-"));
    previousManagerQueueDirectory = process.env["MANAGER_IMPORT_QUEUE_DIR"];
    previousLegacyQueueDirectory = process.env["CODEX_IMPORT_QUEUE_DIR"];
    delete process.env["MANAGER_IMPORT_QUEUE_DIR"];
    delete process.env["CODEX_IMPORT_QUEUE_DIR"];
    refreshImportedAccountQuotaMock.mockReset();
    getBalanceQuotaCapabilityMock.mockReset();
  });

  afterEach(async () => {
    restoreEnvironment("MANAGER_IMPORT_QUEUE_DIR", previousManagerQueueDirectory);
    restoreEnvironment("CODEX_IMPORT_QUEUE_DIR", previousLegacyQueueDirectory);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("uses the private-bot queue variable before the legacy compatibility variable", () => {
    const managerQueue = path.join(temporaryDirectory, "manager-inbox");
    const legacyQueue = path.join(temporaryDirectory, "legacy-inbox");
    process.env["MANAGER_IMPORT_QUEUE_DIR"] = managerQueue;
    process.env["CODEX_IMPORT_QUEUE_DIR"] = legacyQueue;

    expect(getLocalImportInboxPath()).toBe(managerQueue);

    process.env["MANAGER_IMPORT_QUEUE_DIR"] = "relative-inbox";
    expect(() => getLocalImportInboxPath()).toThrow("must be absolute");
  });

  it("imports through the repository, refreshes quota, and enables only an eligible pool account", async () => {
    const queuePath = path.join(temporaryDirectory, "inbox");
    await writeJob(queuePath, JOB_ID);
    const release = vi.fn().mockResolvedValue(undefined);
    const account = { id: "account-1", email: "one@example.test", isActive: false, createdAt: 1, updatedAt: 1 };
    const repo = {
      tryAcquireSchedulerLease: vi.fn().mockResolvedValue({ release }),
      importSharedAccountsForLocalInbox: vi.fn().mockResolvedValue([account]),
      getAccount: vi.fn().mockResolvedValue(account),
      setBalancePoolMembership: vi.fn().mockResolvedValue(account)
    };
    refreshImportedAccountQuotaMock.mockResolvedValue({ quota: { hourlyPercentage: 80 } });
    getBalanceQuotaCapabilityMock.mockReturnValue("windowed");
    const onProcessed = vi.fn();
    const inbox = new LocalImportInbox(repo as never, onProcessed, { queuePath });

    await inbox.processPendingJobs();
    inbox.dispose();

    expect(repo.importSharedAccountsForLocalInbox).toHaveBeenCalledOnce();
    expect(refreshImportedAccountQuotaMock).toHaveBeenCalledWith(repo, account.id);
    expect(repo.setBalancePoolMembership).toHaveBeenCalledWith(account.id, true);
    expect(release).toHaveBeenCalledOnce();
    expect(onProcessed).toHaveBeenCalledOnce();
    await expect(fs.stat(path.join(queuePath, `${JOB_ID}.json`))).rejects.toMatchObject({ code: "ENOENT" });

    const resultText = await fs.readFile(path.join(temporaryDirectory, "results", `${JOB_ID}.json`), "utf8");
    const result = JSON.parse(resultText) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "completed", imported: 1, pool_enabled: 1, refresh_failed: 0 });
    expect(resultText).not.toContain("id-token");
    expect(resultText).not.toContain("access-token");
  });

  it("fails closed for a 401 refresh and removes the account from the pool", async () => {
    const queuePath = path.join(temporaryDirectory, "inbox");
    await writeJob(queuePath, JOB_ID);
    const release = vi.fn().mockResolvedValue(undefined);
    const account = { id: "account-401", email: "expired@example.test", isActive: false, createdAt: 1, updatedAt: 1 };
    const repo = {
      tryAcquireSchedulerLease: vi.fn().mockResolvedValue({ release }),
      importSharedAccountsForLocalInbox: vi.fn().mockResolvedValue([account]),
      getAccount: vi.fn().mockResolvedValue(account),
      setBalancePoolMembership: vi.fn().mockResolvedValue(account)
    };
    refreshImportedAccountQuotaMock.mockResolvedValue({
      error: { message: "API returned 401: Unauthorized", timestamp: 1 }
    });
    const inbox = new LocalImportInbox(repo as never, vi.fn(), { queuePath });

    await inbox.processPendingJobs();
    inbox.dispose();

    expect(repo.setBalancePoolMembership).toHaveBeenCalledWith(account.id, false);
    const result = JSON.parse(
      await fs.readFile(path.join(temporaryDirectory, "results", `${JOB_ID}.json`), "utf8")
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "partial",
      imported: 1,
      pool_enabled: 0,
      refresh_failed: 1,
      auth_failed: 1
    });
  });
});

async function writeJob(queuePath: string, jobId: string): Promise<void> {
  await fs.mkdir(queuePath, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(queuePath, `${jobId}.json`),
    JSON.stringify({
      schema: "codex-account-import/v1",
      id: jobId,
      created_at: "2026-07-22T00:00:00.000Z",
      accounts: [
        {
          email: "one@example.test",
          tokens: {
            id_token: "id-token",
            access_token: "access-token"
          }
        }
      ]
    }),
    { encoding: "utf8", mode: 0o600 }
  );
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
