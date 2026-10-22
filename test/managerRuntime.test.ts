import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AccountsRepository } from "../src/storage";
import { createNodeAccountsContext, NodeJsonKeyValueStore } from "../src/runtime/nodeHost";
import { resolveManagerDaemonConfig, resolveQuotaCountdownAutomationEnabled } from "../src/runtime/managerDaemon";
import { HeadlessTokenRefreshScheduler } from "../src/runtime/tokenRefreshScheduler";
import { MailboxDaemonService } from "../src/runtime/mailboxDaemon";
import type { CodexAccountRecord, CodexTokens } from "../src/core/types";

function createJwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("headless Manager runtime", () => {
  it("parses daemon configuration without inheriting a real private directory", () => {
    const config = resolveManagerDaemonConfig(
      {
        CODEX_ACCOUNTS_PRIVATE_DIR: "/tmp/manager-runtime-test-private",
        CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN: "test-token",
        MANAGER_DAEMON_PORT: "43127",
        MANAGER_DAEMON_QUOTA_REFRESH_MINUTES: "0"
      },
      "/tmp/manager-runtime-test"
    );

    expect(config).toMatchObject({
      privateRoot: "/tmp/manager-runtime-test-private",
      port: 43127,
      quotaRefreshIntervalMs: 0,
      token: "test-token"
    });
  });

  it("enables headless quota countdown automation only with explicit configuration", () => {
    const config = resolveManagerDaemonConfig({
      CODEX_ACCOUNTS_PRIVATE_DIR: "/tmp/manager-runtime-countdown-private",
      CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN: "test-token",
      MANAGER_DAEMON_AUTO_START_QUOTA_COUNTDOWN: "1",
      MANAGER_DAEMON_QUOTA_COUNTDOWN_CHECK_INTERVAL_SECONDS: "30"
    });

    expect(config.autoStartQuotaCountdown).toBe(true);
    expect(config.quotaCountdownCheckIntervalMs).toBe(30_000);
  });

  it("prefers the shared Dashboard setting over the environment fallback", () => {
    expect(resolveQuotaCountdownAutomationEnabled(true, false)).toBe(true);
    expect(resolveQuotaCountdownAutomationEnabled(false, true)).toBe(false);
    expect(resolveQuotaCountdownAutomationEnabled(undefined, true)).toBe(true);
    expect(resolveQuotaCountdownAutomationEnabled(undefined, false)).toBe(false);
  });

  it("persists daemon diagnostics atomically and reloads them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-runtime-state-"));
    try {
      const filePath = path.join(root, "state.json");
      const first = new NodeJsonKeyValueStore(filePath);
      await first.load();
      await first.update("accountHealthEvidence.v1.account-1", { version: 1, renewal: { kind: "succeeded" } });

      const second = new NodeJsonKeyValueStore(filePath);
      await second.load();
      expect(second.keys()).toEqual(["accountHealthEvidence.v1.account-1"]);
      expect(second.get("accountHealthEvidence.v1.account-1")).toMatchObject({
        renewal: { kind: "succeeded" }
      });
      expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes the account repository with Node-only host services", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-runtime-repo-"));
    const originalCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = path.join(root, "codex-home");
      const repo = new AccountsRepository(createNodeAccountsContext(path.join(root, "private")));
      await repo.init();
      await expect(repo.listAccounts()).resolves.toEqual([]);
      repo.dispose();
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not refresh an account whose credentials are not near expiry", async () => {
    const account: CodexAccountRecord = {
      id: "account-1",
      email: "one@example.com",
      accountKind: "chatgpt",
      quotaMode: "chatgpt",
      createdAt: 1,
      updatedAt: 1
    };
    const tokens: CodexTokens = {
      idToken: createJwt(Math.floor(Date.now() / 1000) + 3_600),
      accessToken: createJwt(Math.floor(Date.now() / 1000) + 3_600),
      refreshToken: "refresh-token"
    };
    const release = async () => undefined;
    const repo = {
      listAccounts: async () => [account],
      getTokens: async () => tokens,
      tryAcquireSchedulerLease: async () => ({ release }),
      updateTokenRefreshStatus: async () => undefined
    } as never;
    const scheduler = new HeadlessTokenRefreshScheduler(repo, 60_000);
    await scheduler.runNow();
    scheduler.dispose();
    expect(tokens.accessToken).toContain(".");
  });

  it("starts the Mailbox headless host against an isolated private state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-manager-runtime-mailbox-"));
    const repo = {
      tryAcquireSchedulerLease: async () => ({ release: async () => undefined })
    } as never;
    const mailbox = new MailboxDaemonService(repo, root, 60_000);
    try {
      await mailbox.start();
      expect(mailbox.getDeactivatedMailboxEmails()).toEqual([]);
    } finally {
      mailbox.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
