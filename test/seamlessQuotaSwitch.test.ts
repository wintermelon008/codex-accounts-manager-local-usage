import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { maybeSeamlessBalanceSwitchForActiveQuota, maybeSwitchForActiveQuota } from "../src/application/accounts/quota";
import { FREE_EXHAUSTION_QUOTA_MAX_AGE_MS } from "../src/application/accounts/balanceScheduler";
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

  it("does not rotate a verified Free account on ordinary bands or the reserve threshold", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchEmergencySwitchEnabled: false,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 100);
    active.planType = "free";
    const candidate = account("candidate", false, 100);
    candidate.planType = "plus";
    const repo = repository(active, candidate);
    const switchRuntimeAccount = vi.fn(async () => switched(candidate));
    const view = { refresh: vi.fn(), switchRuntimeAccount };

    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    active.quotaSummary!.hourlyPercentage = 80;
    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    active.quotaSummary!.hourlyPercentage = 3;
    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );

    expect(switchRuntimeAccount).not.toHaveBeenCalled();
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

  it("keeps a Free account on the highest fresh same-Free quota at the 1% hard-stop floor", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchEmergencySwitchEnabled: true,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 1);
    active.planType = "free";
    const lowerFree = account("free-low", false, 45);
    lowerFree.planType = "free";
    const higherFree = account("free-high", false, 88);
    higherFree.planType = "chatgpt_free_plan";
    const higherPlus = account("plus", false, 100);
    higherPlus.planType = "plus";
    const repo = repository(active, lowerFree, higherPlus, higherFree);
    const switchRuntimeAccount = vi.fn(async () => switched(higherFree));

    await expect(
      maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, {
        refresh: vi.fn(),
        switchRuntimeAccount
      })
    ).resolves.toBe(true);

    expect(switchRuntimeAccount).toHaveBeenCalledWith(higherFree.id, {
      gracePeriodMs: 0,
      longTurnPolicy: "interruptAndContinue",
      recoverRecentUsageLimitedTurns: true
    });
  });

  it("falls back to the normal mixed selector when no safe Free peer remains", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchEmergencySwitchEnabled: true,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 1);
    active.planType = "free";
    const exhaustedFree = account("free-exhausted", false, 1);
    exhaustedFree.planType = "free";
    const staleFree = account("free-stale", false, 100);
    staleFree.planType = "free";
    staleFree.lastQuotaAt = Date.now() - FREE_EXHAUSTION_QUOTA_MAX_AGE_MS - 1;
    const plus = account("plus", false, 90);
    plus.planType = "plus";
    const repo = repository(active, exhaustedFree, staleFree, plus);
    const switchRuntimeAccount = vi.fn(async () => switched(plus));

    await expect(
      maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, {
        refresh: vi.fn(),
        switchRuntimeAccount
      })
    ).resolves.toBe(true);

    expect(switchRuntimeAccount).toHaveBeenCalledWith(plus.id, {
      gracePeriodMs: 0,
      longTurnPolicy: "interruptAndContinue",
      recoverRecentUsageLimitedTurns: true
    });
  });

  it("treats a runtime usage-limit event as an immediate Free recovery even before the next quota refresh", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchEmergencySwitchEnabled: true,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 74);
    active.planType = "free";
    const candidate = account("candidate", false, 90);
    candidate.planType = "free";
    const repo = repository(active, candidate);
    const switchRuntimeAccount = vi.fn(async () => switched(candidate));

    await expect(
      maybeSeamlessBalanceSwitchForActiveQuota(
        repo as unknown as AccountsRepository,
        { refresh: vi.fn(), switchRuntimeAccount },
        { trigger: "runtimeUsageLimit", activeAccountId: active.id }
      )
    ).resolves.toBe(true);

    expect(switchRuntimeAccount).toHaveBeenCalledWith(candidate.id, {
      gracePeriodMs: 0,
      longTurnPolicy: "interruptAndContinue",
      recoverRecentUsageLimitedTurns: true
    });
  });

  it("converges a stopped remote runtime to the shared active account without reselecting", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchEmergencySwitchEnabled: true,
      hotSwitchEnabled: true
    });
    const globallyActive = account("global", true, 70);
    const stoppedLocalRuntime = account("local", false, 1);
    const repo = repository(globallyActive, stoppedLocalRuntime);
    const switchRuntimeAccount = vi.fn(async () => switched(globallyActive));

    await expect(
      maybeSeamlessBalanceSwitchForActiveQuota(
        repo as unknown as AccountsRepository,
        { refresh: vi.fn(), switchRuntimeAccount },
        { trigger: "runtimeUsageLimit", activeAccountId: stoppedLocalRuntime.id }
      )
    ).resolves.toBe(true);

    expect(switchRuntimeAccount).toHaveBeenCalledWith(globallyActive.id, {
      gracePeriodMs: 0,
      longTurnPolicy: "interruptAndContinue",
      recoverRecentUsageLimitedTurns: true
    });
    expect(repo.tryAcquireSchedulerLease).not.toHaveBeenCalled();
  });

  it("forces an immediate switch when weekly quota reaches 1%, even with high 5-hour quota", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchEmergencySwitchEnabled: true,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 100, 1);
    const candidate = account("candidate", false, 90, 100);
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

  it("forces an immediate switch for a weekly-only account at 1%", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchEmergencySwitchEnabled: true,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 0, 1);
    active.quotaSummary!.hourlyWindowPresent = false;
    const candidate = account("candidate", false, 0, 100);
    candidate.quotaSummary!.hourlyWindowPresent = false;
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

  it("uses a normal reserve-threshold switch on first observation when emergency interruption is disabled", async () => {
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
      true
    );
    expect(view.switchRuntimeAccount).toHaveBeenCalledWith(candidate.id);
  });

  it("prefers recovered windowed quota before a reserve account", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchReserveThreshold: 3,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 2);
    const recovered = account("recovered", false, 4);
    const reserve = reserveAccount("reserve", false, 100);
    const repo = repository(active, reserve, recovered);
    const switchRuntimeAccount = vi.fn(async () => switched(recovered));

    await expect(
      maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, {
        refresh: vi.fn(),
        switchRuntimeAccount
      })
    ).resolves.toBe(true);

    expect(switchRuntimeAccount).toHaveBeenCalledWith(recovered.id);
  });

  it("enters reserve only after every safe windowed pool account reaches the threshold", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchReserveThreshold: 3,
      hotSwitchEnabled: true
    });
    const active = account("active", true, 2);
    const depleted = account("depleted", false, 2);
    const reserve = reserveAccount("reserve", false, 90);
    const repo = repository(active, depleted, reserve);
    const switchRuntimeAccount = vi.fn(async () => switched(reserve));

    await expect(
      maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, {
        refresh: vi.fn(),
        switchRuntimeAccount
      })
    ).resolves.toBe(true);

    expect(switchRuntimeAccount).toHaveBeenCalledWith(reserve.id);
  });

  it("keeps a healthy reserve active and returns to recovered windowed quota at its long-term threshold", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchReserveThreshold: 3,
      hotSwitchEnabled: true
    });
    const active = reserveAccount("active", true, 50);
    const recovered = account("recovered", false, 20);
    const repo = repository(active, recovered);
    const switchRuntimeAccount = vi.fn(async () => switched(recovered));
    const view = { refresh: vi.fn(), switchRuntimeAccount };

    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      false
    );
    active.quotaSummary!.weeklyPercentage = 3;
    await expect(maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, view)).resolves.toBe(
      true
    );

    expect(switchRuntimeAccount).toHaveBeenCalledWith(recovered.id);
  });

  it("chooses the reserve account with the strongest long-term quota when no windowed account recovered", async () => {
    configure({
      seamlessSwitchEnabled: true,
      seamlessSwitchQuotaBandsEnabled: true,
      seamlessSwitchReserveThreshold: 3,
      hotSwitchEnabled: true
    });
    const active = reserveAccount("active", true, 3);
    const lowerReserve = reserveAccount("reserve-low", false, 60);
    const strongerReserve = reserveAccount("reserve-high", false, 90);
    const repo = repository(active, lowerReserve, strongerReserve);
    const switchRuntimeAccount = vi.fn(async () => switched(strongerReserve));

    await expect(
      maybeSeamlessBalanceSwitchForActiveQuota(repo as unknown as AccountsRepository, {
        refresh: vi.fn(),
        switchRuntimeAccount
      })
    ).resolves.toBe(true);

    expect(switchRuntimeAccount).toHaveBeenCalledWith(strongerReserve.id);
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

  it("keeps manual seamless routing available without applying automatic quota eligibility", async () => {
    const target = account("manually-selected", false, 0);
    target.lastQuotaAt = undefined;
    target.quotaSummary = undefined;
    const runtime = {
      isEnabled: vi.fn(() => true),
      switchAccount: vi.fn(async () => switched(target))
    };

    await expect(routeRuntimeAccountSwitch(target.id, runtime, true)).resolves.toMatchObject({
      status: "switched"
    });
    expect(runtime.switchAccount).toHaveBeenCalledWith(target.id);
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

function reserveAccount(id: string, isActive: boolean, weekly: number): CodexAccountRecord {
  const result = account(id, isActive, 0, weekly);
  result.quotaSummary!.hourlyWindowPresent = false;
  result.quotaSummary!.hourlyWindowMinutes = undefined;
  return result;
}

function repository(...accounts: CodexAccountRecord[]) {
  return {
    listAccounts: vi.fn(async () => accounts),
    switchAccount: vi.fn(async () => undefined),
    tryAcquireSchedulerLease: vi.fn(async () => ({ release: vi.fn(async () => undefined) }))
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
