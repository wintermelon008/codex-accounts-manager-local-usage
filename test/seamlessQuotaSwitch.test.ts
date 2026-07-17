import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { maybeSeamlessBalanceSwitchForActiveQuota, maybeSwitchForActiveQuota } from "../src/application/accounts/quota";
import type { CodexAccountRecord } from "../src/core/types";
import type { AccountsRepository } from "../src/storage";
import { initSeamlessSwitchRuntimeState } from "../src/presentation/workbench/seamlessSwitchState";
import { routeRuntimeAccountSwitch } from "../src/presentation/workbench/accountsWorkbench";

describe("seamless 5-hour quota-band switching", () => {
  beforeEach(() => {
    initSeamlessSwitchRuntimeState({
      globalState: {
        get: () => undefined,
        update: vi.fn(async () => undefined)
      }
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("switches after a 20% band drop without upstream Auto Switch or 5-hour quota control", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      hotSwitchEnabled: true,
      autoSwitchEnabled: false,
      hourlyQuotaControlEnabled: false
    });
    const active = account("active", true, 100);
    const candidate = account("candidate", false, 100);
    const repo = repository(active, candidate);
    const view = {
      refresh: vi.fn(),
      markObservedAuthIdentity: vi.fn(),
      switchRuntimeAccount: vi.fn(async () => switched(candidate))
    };

    await expect(maybeSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(false);
    active.quotaSummary!.hourlyPercentage = 80;
    await expect(maybeSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(true);

    expect(view.switchRuntimeAccount).toHaveBeenCalledWith(candidate.id);
    expect(repo.switchAccount).not.toHaveBeenCalled();
    expect(view.markObservedAuthIdentity).toHaveBeenCalledWith(candidate.id);
    expect(view.refresh).toHaveBeenCalledOnce();
  });

  it("uses the configured quota-band size", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchQuotaBandSize: 25,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 100);
    const candidate = account("candidate", false, 100);
    const repo = repository(active, candidate);
    const view = { refresh: vi.fn(), switchRuntimeAccount: vi.fn(async () => switched(candidate)) };

    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    active.quotaSummary!.hourlyPercentage = 75;
    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      true
    );
  });

  it("keeps the current account when it still has the highest quota in the triggered band", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 100);
    const lowerSameBandCandidate = account("candidate", false, 70);
    const repo = repository(active, lowerSameBandCandidate);
    const view = { refresh: vi.fn(), switchRuntimeAccount: vi.fn(async () => switched(lowerSameBandCandidate)) };

    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    active.quotaSummary!.hourlyPercentage = 80;

    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    expect(view.switchRuntimeAccount).not.toHaveBeenCalled();
  });

  it("forces an immediate interrupt-and-continue switch at 1% without requiring a prior baseline", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchQuotaBandSize: 33,
      seamlessSwitchEmergencySwitchEnabled: true,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 1);
    const candidate = account("candidate", false, 67);
    const repo = repository(active, candidate);
    const switchRuntimeAccount = vi.fn(async () => switched(candidate));
    const view = { refresh: vi.fn(), switchRuntimeAccount };

    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      true
    );

    expect(switchRuntimeAccount).toHaveBeenCalledWith(candidate.id, {
      gracePeriodMs: 0,
      longTurnPolicy: "interruptAndContinue",
      recoverRecentUsageLimitedTurns: true
    });
  });

  it("does not force a first-observation switch at 1% when the emergency setting is disabled", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchEmergencySwitchEnabled: false,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 1);
    const candidate = account("candidate", false, 100);
    const repo = repository(active, candidate);
    const view = { refresh: vi.fn(), switchRuntimeAccount: vi.fn(async () => switched(candidate)) };

    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    expect(view.switchRuntimeAccount).not.toHaveBeenCalled();
  });

  it("does not force-switch to another account at or below the 1% emergency floor", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchEmergencySwitchEnabled: true,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 1);
    const candidate = account("candidate", false, 1);
    const repo = repository(active, candidate);
    const view = { refresh: vi.fn(), switchRuntimeAccount: vi.fn(async () => switched(candidate)) };

    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    expect(view.switchRuntimeAccount).not.toHaveBeenCalled();
  });

  it("fails closed instead of falling through to upstream Auto Switch when the runtime is unavailable", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      hotSwitchEnabled: true,
      autoSwitchEnabled: true,
      hourlyQuotaControlEnabled: true,
      autoSwitchHourlyThreshold: 20,
      autoSwitchWeeklyThreshold: 20
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const active = account("active", true, 100, 0);
    const candidate = account("candidate", false, 100, 100);
    const repo = repository(active, candidate);
    const view = { refresh: vi.fn() };

    await expect(maybeSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(false);
    active.quotaSummary!.hourlyPercentage = 80;
    await expect(maybeSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(false);

    expect(repo.switchAccount).not.toHaveBeenCalled();
    expect(view.refresh).not.toHaveBeenCalled();
  });

  it("keeps a deferred band drop pending and retries it on the next refresh", async () => {
    configure({ seamlessSwitchEnabled: true, seamlessSwitchQuotaBandsEnabled: true, hotSwitchEnabled: true });
    const active = account("active", true, 100);
    const candidate = account("candidate", false, 100);
    const repo = repository(active, candidate);
    const switchRuntimeAccount = vi
      .fn()
      .mockResolvedValueOnce({ status: "deferred", reason: "activeOrdinaryTurns", activeTurns: 1 })
      .mockResolvedValueOnce(switched(candidate));
    const view = { refresh: vi.fn(), switchRuntimeAccount };

    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    active.quotaSummary!.hourlyPercentage = 80;
    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      true
    );

    expect(switchRuntimeAccount).toHaveBeenCalledTimes(2);
    expect(repo.switchAccount).not.toHaveBeenCalled();
  });

  it("uses the original auto-switch path when the seamless master switch is off", async () => {
    configure({
      seamlessSwitchEnabled: false,
      seamlessSwitchQuotaBandsEnabled: true,
      hotSwitchEnabled: true,
      autoSwitchEnabled: true,
      hourlyQuotaControlEnabled: true,
      autoSwitchHourlyThreshold: 20,
      autoSwitchWeeklyThreshold: 20
    });
    const active = account("active", true, 10);
    const candidate = account("candidate", false, 100);
    const repo = repository(active, candidate);
    const view = { refresh: vi.fn(), switchRuntimeAccount: vi.fn(async () => switched(candidate)) };

    await expect(maybeSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(true);

    expect(repo.switchAccount).toHaveBeenCalledWith(candidate.id);
    expect(view.switchRuntimeAccount).not.toHaveBeenCalled();
  });

  it("only exposes the original switch fallback when the seamless master switch is off", async () => {
    const runtime = {
      isEnabled: vi.fn(() => false),
      switchAccount: vi.fn()
    };

    await expect(routeRuntimeAccountSwitch("candidate", runtime, false)).resolves.toEqual({
      status: "unavailable"
    });
    await expect(routeRuntimeAccountSwitch("candidate", runtime, true)).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("not installed")
    });
    expect(runtime.switchAccount).not.toHaveBeenCalled();
  });
});

function configure(values: Record<string, unknown>): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    inspect: vi.fn((key: string) => ({
      key: `codexAccounts.${key}`,
      defaultValue: false,
      globalValue: values[key]
    })),
    update: vi.fn()
  } as never);
}

function account(id: string, isActive: boolean, hourly: number, weekly = 100): CodexAccountRecord {
  return {
    id,
    email: `${id}@example.invalid`,
    isActive,
    balancePoolEnabled: true,
    lastQuotaAt: Date.now(),
    quotaSummary: {
      hourlyPercentage: hourly,
      hourlyWindowPresent: true,
      hourlyWindowMinutes: 300,
      weeklyPercentage: weekly,
      weeklyWindowPresent: true,
      weeklyWindowMinutes: 10_080,
      codeReviewPercentage: 100
    },
    createdAt: 1,
    updatedAt: 1
  };
}

function repository(active: CodexAccountRecord, candidate: CodexAccountRecord) {
  return {
    listAccounts: vi.fn(async () => [active, candidate]),
    switchAccount: vi.fn(async () => undefined)
  };
}

function switched(accountRecord: CodexAccountRecord) {
  return {
    status: "switched" as const,
    accountId: accountRecord.accountId ?? accountRecord.id,
    email: accountRecord.email,
    activeTurns: 0,
    interruptedTurns: 0,
    continuedThreads: 0
  };
}
