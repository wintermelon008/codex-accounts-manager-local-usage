import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAccountsRepositoryState } from "../src/storage/accountsRepositoryState";
import {
  assertWriteAllowed,
  disposeWriteCoordinator,
  markPendingSave,
  mergeAccountsIndexChanges,
  readPendingOrCachedIndex,
  tryAcquireSharedFileLease
} from "../src/storage/accountsWriteCoordinator";
import { ErrorCode, StorageError } from "../src/core/errors";
import { parseSharedJsonInput, toImportActionPayload } from "../src/presentation/dashboard/actionUtils";
import {
  buildWorkbenchRefreshSignature,
  shouldRunAccountScheduler
} from "../src/presentation/workbench/refreshSignature";
import { buildDashboardStateSignature } from "../src/presentation/dashboard/signature";
import { runWithConcurrencyLimit } from "../src/utils/concurrency";
import { normalizeAutoRefreshMinutes } from "../src/infrastructure/config/extensionSettings";

describe("accountsWriteCoordinator helpers", () => {
  it("prefers pending saves over cache and schedules a flush", () => {
    vi.useFakeTimers();
    const state = createAccountsRepositoryState();
    const flush = vi.fn();

    markPendingSave(
      state,
      {
        currentAccountId: "a",
        accounts: [{ id: "a", email: "a@example.com", isActive: true, createdAt: 1, updatedAt: 1 }]
      },
      100,
      flush
    );

    expect(readPendingOrCachedIndex(state, 5000)?.currentAccountId).toBe("a");
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("blocks writes when the index is unrecoverable", () => {
    const state = createAccountsRepositoryState();
    state.indexHealth = {
      status: "corrupted_unrecoverable",
      availableBackups: 0
    };

    expect(() => assertWriteAllowed(state)).toThrowError(StorageError);
    expect(() => assertWriteAllowed(state)).toThrow(/Restore accounts before writing again/);
  });

  it("three-way merges independent account field changes from two hosts", () => {
    const base = {
      currentAccountId: "a",
      accounts: [
        {
          id: "a",
          email: "a@example.com",
          accountName: "Base",
          tags: ["base"],
          balancePoolEnabled: false,
          isActive: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    };
    const local = structuredClone(base);
    local.accounts[0]!.tags = ["local"];
    local.accounts[0]!.updatedAt = 3;
    const latest = structuredClone(base);
    latest.accounts[0]!.accountName = "External";
    latest.accounts[0]!.balancePoolEnabled = true;
    latest.accounts[0]!.quotaSummary = {
      hourlyPercentage: 50,
      hourlyWindowPresent: true,
      hourlyWindowMinutes: 300,
      weeklyPercentage: 80,
      weeklyWindowPresent: true,
      weeklyWindowMinutes: 10_080,
      codeReviewPercentage: 0
    };
    latest.accounts[0]!.updatedAt = 2;

    const merged = mergeAccountsIndexChanges(base, local, latest);

    expect(merged.accounts[0]).toMatchObject({
      accountName: "External",
      balancePoolEnabled: true,
      tags: ["local"],
      quotaSummary: { hourlyPercentage: 50, weeklyPercentage: 80 },
      updatedAt: 3
    });
  });

  it("uses an exclusive expiring filesystem lease", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-accounts-lease-test-"));
    const lockPath = path.join(directory, "shared.lease");
    try {
      const first = await tryAcquireSharedFileLease(lockPath, 1_000);
      expect(first).toBeDefined();
      await expect(tryAcquireSharedFileLease(lockPath, 1_000)).resolves.toBeUndefined();

      await first?.release();
      const second = await tryAcquireSharedFileLease(lockPath, 1_000);
      expect(second).toBeDefined();
      await second?.release();

      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ expiresAt: 0 }), "utf8");
      const afterExpiry = await tryAcquireSharedFileLease(lockPath, 1_000, 100);
      expect(afterExpiry).toBeDefined();
      await afterExpiry?.release();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("defers a final dispose write when an in-process async writer still owns the shared lock", async () => {
    const state = createAccountsRepositoryState();
    state.isDirty = true;
    state.pendingSave = {
      accounts: [{ id: "account-a", email: "a@example.invalid", createdAt: 1, updatedAt: 1 }]
    };
    state.pendingSaveBase = { accounts: [] };
    const persistAsync = vi.fn(async (index) => index);

    expect(() =>
      disposeWriteCoordinator(
        state,
        () => {
          const busy = new Error("The shared accounts index write lock is busy");
          throw Object.assign(new Error("Failed to write to index"), { cause: busy });
        },
        persistAsync
      )
    ).not.toThrow();

    await vi.waitFor(() => expect(persistAsync).toHaveBeenCalledOnce());
    expect(state.isDirty).toBe(false);
    expect(state.pendingSave).toBeNull();
  });

  it("renews a lease only while its recorded owner is still valid", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-accounts-renewable-lease-test-"));
    const lockPath = path.join(directory, "shared.lease");
    try {
      const first = await tryAcquireSharedFileLease(lockPath, 1_000);
      expect(first).toBeDefined();

      expect(await first?.renew(1_000)).toBe(true);
      const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as {
        expiresAt?: number;
      };
      expect(owner.expiresAt).toBeGreaterThan(Date.now());

      await first?.release();
      expect(await first?.renew(1_000)).toBe(false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("dashboard action utils", () => {
  it("parses shared json and formats import results", () => {
    expect(parseSharedJsonInput('[{"email":"dev@example.com"}]')).toEqual([{ email: "dev@example.com" }]);

    expect(
      toImportActionPayload({
        source: "backup",
        restoredCount: 2,
        restoredEmails: ["a@example.com", "b@example.com"]
      })
    ).toEqual({
      importedCount: 2,
      importedEmails: ["a@example.com", "b@example.com"],
      importResult: {
        total: 2,
        successCount: 2,
        overwriteCount: 0,
        failedCount: 0,
        importedEmails: ["a@example.com", "b@example.com"],
        failures: []
      }
    });
  });

  it("surfaces parser errors through the provided formatter", () => {
    expect(() => parseSharedJsonInput("", (message) => `invalid: ${message}`)).toThrow("invalid: Empty JSON input");
  });
});

describe("scheduler settings helpers", () => {
  it("normalizes auto refresh minutes to off or 1-60", () => {
    expect(normalizeAutoRefreshMinutes(-1)).toBe(0);
    expect(normalizeAutoRefreshMinutes(0)).toBe(0);
    expect(normalizeAutoRefreshMinutes(0.4)).toBe(1);
    expect(normalizeAutoRefreshMinutes(1.4)).toBe(1);
    expect(normalizeAutoRefreshMinutes(59.6)).toBe(60);
    expect(normalizeAutoRefreshMinutes(90)).toBe(60);
  });
});

describe("runWithConcurrencyLimit", () => {
  it("propagates unexpected worker failures", async () => {
    await expect(
      runWithConcurrencyLimit([1, 2, 3], 2, async (value) => {
        if (value === 2) {
          throw new Error("boom");
        }
      })
    ).rejects.toThrow("boom");
  });
});

describe("workbench refresh signature helpers", () => {
  it("builds a stable signature from account and health state", () => {
    const signature = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", isActive: true, createdAt: 1, updatedAt: 2 }]
    });

    expect(signature).toContain("acct-1");
    expect(signature).toContain("a@example.com");
    expect(shouldRunAccountScheduler(0)).toBe(false);
    expect(shouldRunAccountScheduler(2)).toBe(true);
  });

  it("changes signatures when tags change", () => {
    const workbenchBase = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", tags: ["team"], isActive: true, createdAt: 1, updatedAt: 2 }]
    });
    const workbenchNext = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", tags: ["ops"], isActive: true, createdAt: 1, updatedAt: 2 }]
    });

    expect(workbenchBase).not.toBe(workbenchNext);

    const dashboardBase = buildDashboardStateSignature({
      lang: "en",
      panelTitle: "panel",
      brandSub: "brand",
      logoUri: "logo",
      settings: {
        dashboardTheme: "auto",
        localUsageDefaultRange: "7d",
        localUsageEnabledRanges: ["7d"],
        proxyAddress: "",
        proxyAddresses: [""],
        localUsageShowEquivalentPrice: true,
        codexAppRestartEnabled: false,
        codexAppRestartMode: "manual",
        backgroundTokenRefreshEnabled: true,
        forceFastModeEnabled: false,
        autoRefreshMinutes: 0,
        autoSwitchEnabled: false,
        hotSwitchEnabled: false,
        seamlessSwitchEnabled: false,
        seamlessSwitchQuotaBandsEnabled: false,
        seamlessSwitchLowQuotaEnabled: false,
        seamlessSwitchQuotaBandSize: 20,
        seamlessSwitchThreshold: 3,
        hotSwitchGraceSeconds: 60,
        hotSwitchLongTurnPolicy: "defer",
        hourlyQuotaControlEnabled: false,
        autoSwitchReloadWindowEnabled: false,
        autoSwitchHourlyThreshold: 20,
        autoSwitchWeeklyThreshold: 20,
        hideWeeklyQuotaThreshold: 3,
        unhideWeeklyQuotaThreshold: 90,
        autoSwitchLockMinutes: 0,
        codexAppPath: "",
        resolvedCodexAppPath: "",
        quotaWarningEnabled: false,
        quotaWarningThreshold: 20,
        quotaGreenThreshold: 60,
        quotaYellowThreshold: 20,
        debugNetwork: false,
        displayLanguage: "auto"
      },
      copy: {
        panelTitle: "panel",
        brandSub: "brand"
      } as never,
      tokenAutomation: {
        enabled: false
      },
      announcements: {
        announcements: [],
        unreadIds: [],
        popupAnnouncement: null
      },
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [
        {
          id: "a",
          email: "a@example.com",
          displayName: "a@example.com",
          accountName: "Account",
          tags: ["team"],
          metrics: [],
          planTypeLabel: "Team",
          authProviderLabel: "google",
          isActive: true,
          isCurrentWindowAccount: false,
          showInStatusBar: false,
          canToggleStatusBar: true,
          statusToggleTitle: "toggle",
          healthKind: "healthy",
          healthLabel: "Healthy",
          dismissedHealth: false
        }
      ]
    });
    const dashboardNext = buildDashboardStateSignature({
      lang: "en",
      panelTitle: "panel",
      brandSub: "brand",
      logoUri: "logo",
      settings: {
        dashboardTheme: "auto",
        localUsageDefaultRange: "7d",
        localUsageEnabledRanges: ["7d"],
        proxyAddress: "",
        proxyAddresses: [""],
        localUsageShowEquivalentPrice: true,
        codexAppRestartEnabled: false,
        codexAppRestartMode: "manual",
        backgroundTokenRefreshEnabled: true,
        forceFastModeEnabled: false,
        autoRefreshMinutes: 0,
        autoSwitchEnabled: false,
        hotSwitchEnabled: false,
        seamlessSwitchEnabled: false,
        seamlessSwitchQuotaBandsEnabled: false,
        seamlessSwitchLowQuotaEnabled: false,
        seamlessSwitchQuotaBandSize: 20,
        seamlessSwitchThreshold: 3,
        hotSwitchGraceSeconds: 60,
        hotSwitchLongTurnPolicy: "defer",
        hourlyQuotaControlEnabled: false,
        autoSwitchReloadWindowEnabled: false,
        autoSwitchHourlyThreshold: 20,
        autoSwitchWeeklyThreshold: 20,
        hideWeeklyQuotaThreshold: 3,
        unhideWeeklyQuotaThreshold: 90,
        autoSwitchLockMinutes: 0,
        codexAppPath: "",
        resolvedCodexAppPath: "",
        quotaWarningEnabled: false,
        quotaWarningThreshold: 20,
        quotaGreenThreshold: 60,
        quotaYellowThreshold: 20,
        debugNetwork: false,
        displayLanguage: "auto"
      },
      copy: {
        panelTitle: "panel",
        brandSub: "brand"
      } as never,
      tokenAutomation: {
        enabled: false
      },
      announcements: {
        announcements: [],
        unreadIds: [],
        popupAnnouncement: null
      },
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [
        {
          id: "a",
          email: "a@example.com",
          displayName: "a@example.com",
          accountName: "Account",
          tags: ["ops"],
          metrics: [],
          planTypeLabel: "Team",
          authProviderLabel: "google",
          isActive: true,
          isCurrentWindowAccount: false,
          showInStatusBar: false,
          canToggleStatusBar: true,
          statusToggleTitle: "toggle",
          healthKind: "healthy",
          healthLabel: "Healthy",
          dismissedHealth: false
        }
      ]
    });

    expect(dashboardBase).not.toBe(dashboardNext);
  });

  it("changes workbench signatures when token automation state changes", () => {
    const base = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", isActive: true, createdAt: 1, updatedAt: 2 }],
      tokenAutomation: {
        enabled: true,
        intervalMs: 300_000,
        skewSeconds: 600,
        lastSweepAt: 100,
        accounts: {
          a: {
            lastCheckAt: 100
          }
        }
      }
    });
    const next = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", isActive: true, createdAt: 1, updatedAt: 2 }],
      tokenAutomation: {
        enabled: true,
        intervalMs: 300_000,
        skewSeconds: 600,
        lastSweepAt: 200,
        accounts: {
          a: {
            lastCheckAt: 200,
            lastRefreshAt: 200
          }
        }
      }
    });

    expect(base).not.toBe(next);
  });
});
