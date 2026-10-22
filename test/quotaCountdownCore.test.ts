import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";
import { runQuotaCountdownStart, startQuotaCountdownWithLease } from "../src/application/accounts/quotaCountdownCore";
import { QuotaCountdownStartError } from "../src/services/quotaCountdown";
import { readQuotaCountdownStartRecord } from "../src/storage/quotaCountdownStartState";

const NOW_SECONDS = 1_800_000_000;
const privateRoots: string[] = [];

afterEach(async () => {
  await Promise.all(privateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host-neutral quota countdown starter", () => {
  it("sends once per reset cycle and persists the accepted marker", async () => {
    const privateRoot = await createPrivateRoot();
    const account = createAccount();
    const repo = createRepo(privateRoot, account);
    let sends = 0;

    await expect(
      runQuotaCountdownStart(repo, account.id, {
        sendStartMessage: async () => {
          sends += 1;
        }
      })
    ).resolves.toBe("started");
    await expect(
      runQuotaCountdownStart(repo, account.id, {
        sendStartMessage: async () => {
          sends += 1;
        }
      })
    ).resolves.toBe("already-started");

    expect(sends).toBe(1);
    await expect(readQuotaCountdownStartRecord(privateRoot, account.id)).resolves.toMatchObject({
      cycleKey: "hourly:1800018000|weekly:1800604800",
      status: "accepted"
    });
  });

  it("fails closed after an ambiguous request and does not blindly retry", async () => {
    const privateRoot = await createPrivateRoot();
    const account = createAccount();
    const repo = createRepo(privateRoot, account);
    let sends = 0;

    await expect(
      runQuotaCountdownStart(repo, account.id, {
        sendStartMessage: async () => {
          sends += 1;
          throw new QuotaCountdownStartError("request timed out", { ambiguous: true });
        }
      })
    ).rejects.toThrow("request timed out");

    await expect(
      runQuotaCountdownStart(repo, account.id, {
        sendStartMessage: async () => {
          sends += 1;
        }
      })
    ).resolves.toBe("already-started");

    expect(sends).toBe(1);
    await expect(readQuotaCountdownStartRecord(privateRoot, account.id)).resolves.toMatchObject({
      status: "uncertain"
    });
  });

  it("fails closed when the shared start state is malformed", async () => {
    const privateRoot = await createPrivateRoot();
    const account = createAccount();
    const repo = createRepo(privateRoot, account);
    await writeFile(
      path.join(privateRoot, "quota-countdown-start-state.v1.json"),
      JSON.stringify({ version: 1, accounts: { [account.id]: { cycleKey: 7 } } })
    );

    await expect(
      runQuotaCountdownStart(repo, account.id, {
        sendStartMessage: async () => undefined
      })
    ).rejects.toThrow("Invalid quota countdown start record");
  });

  it("serializes two hosts through the shared countdown lease", async () => {
    const privateRoot = await createPrivateRoot();
    const account = createAccount();
    const repo = createRepo(privateRoot, account);
    let sends = 0;

    const first = startQuotaCountdownWithLease(repo, account.id, {
      sendStartMessage: async () => {
        sends += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    });
    const second = startQuotaCountdownWithLease(repo, account.id, {
      sendStartMessage: async () => {
        sends += 1;
      }
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["started", "already-started"]);
    expect(sends).toBe(1);
  });
});

function createAccount(): CodexAccountRecord {
  return {
    id: "account-1",
    email: "one@example.com",
    accountKind: "chatgpt",
    quotaMode: "chatgpt",
    accountId: "workspace-1",
    createdAt: NOW_SECONDS * 1000,
    updatedAt: NOW_SECONDS * 1000,
    quotaSummary: {
      hourlyPercentage: 100,
      hourlyWindowPresent: true,
      hourlyResetTime: NOW_SECONDS + 5 * 60 * 60,
      hourlyWindowMinutes: 5 * 60,
      weeklyPercentage: 100,
      weeklyWindowPresent: true,
      weeklyResetTime: NOW_SECONDS + 7 * 24 * 60 * 60,
      weeklyWindowMinutes: 7 * 24 * 60,
      codeReviewPercentage: 0
    }
  };
}

function createRepo(privateRoot: string, account: CodexAccountRecord) {
  const tokens: CodexTokens = {
    idToken: "id-token",
    accessToken: "access-token",
    accountId: account.accountId
  };
  let locked = false;
  return {
    getAccount: async (accountId: string) => (accountId === account.id ? account : undefined),
    getTokens: async () => tokens,
    getPrivateStateRoot: () => privateRoot,
    tryAcquireSchedulerLease: async () => {
      const deadline = Date.now() + 250;
      while (locked && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (locked) {
        return undefined;
      }
      locked = true;
      return {
        renew: async () => true,
        release: async () => {
          locked = false;
        }
      };
    }
  } as {
    getAccount: (accountId: string) => Promise<CodexAccountRecord | undefined>;
    getTokens: (accountId: string) => Promise<CodexTokens>;
    getPrivateStateRoot: () => string;
    tryAcquireSchedulerLease: (
      name: string,
      leaseMs: number,
      waitTimeoutMs?: number
    ) => Promise<
      | {
          renew(leaseMs?: number): Promise<boolean>;
          release(): Promise<void>;
        }
      | undefined
    >;
  };
}

async function createPrivateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-quota-countdown-core-"));
  privateRoots.push(root);
  return root;
}
