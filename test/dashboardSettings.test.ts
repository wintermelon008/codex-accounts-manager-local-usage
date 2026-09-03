import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  DEFAULT_WEEKLY_QUOTA_HIDE_THRESHOLD,
  DEFAULT_WEEKLY_QUOTA_UNHIDE_THRESHOLD
} from "../src/domain/dashboard/types";
import { ExtensionSettingsStore } from "../src/infrastructure/config/extensionSettings";
import { handleDashboardSettingUpdate } from "../src/presentation/dashboard/settings";

describe("handleDashboardSettingUpdate", () => {
  it("reads valid weekly quota thresholds and falls back when their order is invalid", () => {
    const get = vi.fn((key: string, fallback: unknown) => {
      if (key === "hideWeeklyQuotaThreshold") {
        return 4.5;
      }
      if (key === "unhideWeeklyQuotaThreshold") {
        return 87.5;
      }
      return fallback;
    });
    const inspect = vi.fn(() => undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get, inspect } as never);

    const settings = new ExtensionSettingsStore().getDashboardSettings();
    expect(settings.hideWeeklyQuotaThreshold).toBe(4.5);
    expect(settings.unhideWeeklyQuotaThreshold).toBe(87.5);

    get.mockImplementation((key: string, fallback: unknown) => {
      if (key === "hideWeeklyQuotaThreshold") {
        return 95;
      }
      if (key === "unhideWeeklyQuotaThreshold") {
        return 90;
      }
      return fallback;
    });
    const fallbackSettings = new ExtensionSettingsStore().getDashboardSettings();
    expect(fallbackSettings.hideWeeklyQuotaThreshold).toBe(DEFAULT_WEEKLY_QUOTA_HIDE_THRESHOLD);
    expect(fallbackSettings.unhideWeeklyQuotaThreshold).toBe(DEFAULT_WEEKLY_QUOTA_UNHIDE_THRESHOLD);
  });

  it("reads and persists the Fast mode switch", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn((key: string, fallback: unknown) => (key === "forceFastModeEnabled" ? true : fallback));
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get,
      update,
      inspect: vi.fn((key: string) => ({ key: `codexAccounts.${key}` }))
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().forceFastModeEnabled).toBe(true);
    await expect(handleDashboardSettingUpdate("forceFastModeEnabled", false)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith("forceFastModeEnabled", false, vscode.ConfigurationTarget.Global);
  });

  it("rejects invalid or crossed weekly quota threshold updates", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const values: Record<string, unknown> = {
      hideWeeklyQuotaThreshold: 3,
      unhideWeeklyQuotaThreshold: 90
    };
    const get = vi.fn((key: string, fallback: unknown) => values[key] ?? fallback);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get,
      update,
      inspect: vi.fn((key: string) => ({ key: `codexAccounts.${key}` }))
    } as never);

    await expect(handleDashboardSettingUpdate("hideWeeklyQuotaThreshold", 4.5)).resolves.toBe(true);
    values.hideWeeklyQuotaThreshold = 4.5;
    await expect(handleDashboardSettingUpdate("unhideWeeklyQuotaThreshold", 4)).resolves.toBe(false);
    await expect(handleDashboardSettingUpdate("unhideWeeklyQuotaThreshold", 87.5)).resolves.toBe(true);
    await expect(handleDashboardSettingUpdate("hideWeeklyQuotaThreshold", 101)).resolves.toBe(false);

    expect(update).toHaveBeenNthCalledWith(1, "hideWeeklyQuotaThreshold", 4.5, vscode.ConfigurationTarget.Global);
    expect(update).toHaveBeenNthCalledWith(2, "unhideWeeklyQuotaThreshold", 87.5, vscode.ConfigurationTarget.Global);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("updates the workspace value when an effective setting is overridden there", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexAccounts.autoSwitchReloadWindowEnabled",
        defaultValue: false,
        globalValue: true,
        workspaceValue: false
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("autoSwitchReloadWindowEnabled", true)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("autoSwitchReloadWindowEnabled", true, vscode.ConfigurationTarget.Workspace);
  });

  it("uses global settings when there is no workspace override", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexAccounts.autoSwitchReloadWindowEnabled",
        defaultValue: false
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("autoSwitchReloadWindowEnabled", true)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("autoSwitchReloadWindowEnabled", true, vscode.ConfigurationTarget.Global);
  });

  it("migrates the removed local usage range and normalizes unsupported values", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexAccounts.localUsageDefaultRange",
        defaultValue: "7d"
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("localUsageDefaultRange", "24h")).resolves.toBe(true);
    await expect(handleDashboardSettingUpdate("localUsageDefaultRange", "unsupported")).resolves.toBe(true);

    expect(update).toHaveBeenNthCalledWith(1, "localUsageDefaultRange", "24h", vscode.ConfigurationTarget.Global);
    expect(update).toHaveBeenNthCalledWith(2, "localUsageDefaultRange", "7d", vscode.ConfigurationTarget.Global);
  });

  it("normalizes multi-select local usage ranges and falls back to 24h", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexAccounts.localUsageEnabledRanges",
        defaultValue: ["24h"]
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("localUsageEnabledRanges", ["7m", "24h", "7m"])).resolves.toBe(true);
    await expect(handleDashboardSettingUpdate("localUsageEnabledRanges", [])).resolves.toBe(true);

    expect(update).toHaveBeenNthCalledWith(
      1,
      "localUsageEnabledRanges",
      ["24h", "7m"],
      vscode.ConfigurationTarget.Global
    );
    expect(update).toHaveBeenNthCalledWith(2, "localUsageEnabledRanges", ["24h"], vscode.ConfigurationTarget.Global);
  });

  it("migrates a legacy numeric range when the new range has not been explicitly configured", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback: unknown) => (key === "localUsageDefaultRangeDays" ? 14 : fallback)),
      inspect: vi.fn(() => ({
        key: "codexAccounts.localUsageDefaultRange",
        defaultValue: "7d"
      }))
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().localUsageDefaultRange).toBe("14d");
  });

  it("persists the equivalent-price visibility setting", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexAccounts.localUsageShowEquivalentPrice",
        defaultValue: true
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("localUsageShowEquivalentPrice", false)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("localUsageShowEquivalentPrice", false, vscode.ConfigurationTarget.Global);
  });

  it("persists and normalizes hot-switch grace and long-turn policy settings", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn((key: string) => ({ key: `codexAccounts.${key}` }))
    } as never);

    await expect(handleDashboardSettingUpdate("hotSwitchGraceSeconds", 1_000)).resolves.toBe(true);
    await expect(handleDashboardSettingUpdate("hotSwitchLongTurnPolicy", "interruptAndContinue")).resolves.toBe(true);
    await expect(handleDashboardSettingUpdate("hotSwitchLongTurnPolicy", "unsupported")).resolves.toBe(true);

    expect(update).toHaveBeenNthCalledWith(1, "hotSwitchGraceSeconds", 300, vscode.ConfigurationTarget.Global);
    expect(update).toHaveBeenNthCalledWith(
      2,
      "hotSwitchLongTurnPolicy",
      "interruptAndContinue",
      vscode.ConfigurationTarget.Global
    );
    expect(update).toHaveBeenNthCalledWith(3, "hotSwitchLongTurnPolicy", "defer", vscode.ConfigurationTarget.Global);
  });

  it("reads the legacy quota-band setting only until the seamless setting is explicit", () => {
    const inspect = vi.fn((key: string) =>
      key === "seamlessSwitchQuotaBandsEnabled"
        ? { key: `codexAccounts.${key}`, defaultValue: false }
        : { key: `codexAccounts.${key}` }
    );
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback: unknown) => (key === "balanceByQuotaBandsEnabled" ? true : fallback)),
      inspect
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchQuotaBandsEnabled).toBe(true);

    inspect.mockImplementation((key: string) =>
      key === "seamlessSwitchQuotaBandsEnabled"
        ? { key: `codexAccounts.${key}`, defaultValue: false, globalValue: false }
        : { key: `codexAccounts.${key}` }
    );
    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchQuotaBandsEnabled).toBe(false);
  });

  it("persists quota-band scheduling under the seamless setting key", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn((key: string) => ({ key: `codexAccounts.${key}` }))
    } as never);

    await expect(handleDashboardSettingUpdate("seamlessSwitchQuotaBandsEnabled", true)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("seamlessSwitchQuotaBandsEnabled", true, vscode.ConfigurationTarget.Global);
  });

  it("inherits the old quota-band setting for low-quota switching until the new toggle is explicit", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const inspect = vi.fn((key: string) =>
      key === "seamlessSwitchQuotaBandsEnabled"
        ? { key: `codexAccounts.${key}`, globalValue: true }
        : { key: `codexAccounts.${key}`, defaultValue: false }
    );
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_: string, fallback: unknown) => fallback),
      update,
      inspect
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchLowQuotaEnabled).toBe(true);

    inspect.mockImplementation((key: string) =>
      key === "seamlessSwitchLowQuotaEnabled"
        ? { key: `codexAccounts.${key}`, globalValue: false }
        : key === "seamlessSwitchQuotaBandsEnabled"
          ? { key: `codexAccounts.${key}`, globalValue: true }
          : { key: `codexAccounts.${key}`, defaultValue: false }
    );
    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchLowQuotaEnabled).toBe(false);

    await expect(handleDashboardSettingUpdate("seamlessSwitchLowQuotaEnabled", true)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith("seamlessSwitchLowQuotaEnabled", true, vscode.ConfigurationTarget.Global);
  });

  it("persists supported quota-band sizes and normalizes unsupported values", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn((key: string) => ({ key: `codexAccounts.${key}` }))
    } as never);

    await expect(handleDashboardSettingUpdate("seamlessSwitchQuotaBandSize", 33)).resolves.toBe(true);
    await expect(handleDashboardSettingUpdate("seamlessSwitchQuotaBandSize", 40)).resolves.toBe(true);

    expect(update).toHaveBeenNthCalledWith(1, "seamlessSwitchQuotaBandSize", 33, vscode.ConfigurationTarget.Global);
    expect(update).toHaveBeenNthCalledWith(2, "seamlessSwitchQuotaBandSize", 20, vscode.ConfigurationTarget.Global);
  });

  it("reads and persists only supported unified seamless switch thresholds", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback: unknown) => (key === "seamlessSwitchThreshold" ? 5 : fallback)),
      update,
      inspect: vi.fn((key: string) =>
        key === "seamlessSwitchThreshold"
          ? { key: `codexAccounts.${key}`, globalValue: 5 }
          : { key: `codexAccounts.${key}` }
      )
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchThreshold).toBe(5);
    await expect(handleDashboardSettingUpdate("seamlessSwitchThreshold", 0)).resolves.toBe(true);
    await expect(handleDashboardSettingUpdate("seamlessSwitchThreshold", 1)).resolves.toBe(true);
    await expect(handleDashboardSettingUpdate("seamlessSwitchThreshold", 2)).resolves.toBe(true);

    expect(update).toHaveBeenNthCalledWith(1, "seamlessSwitchThreshold", 0, vscode.ConfigurationTarget.Global);
    expect(update).toHaveBeenNthCalledWith(2, "seamlessSwitchThreshold", 1, vscode.ConfigurationTarget.Global);
    expect(update).toHaveBeenNthCalledWith(3, "seamlessSwitchThreshold", 3, vscode.ConfigurationTarget.Global);
  });

  it("migrates the former 1% protection to the unified threshold until explicitly configured", () => {
    const inspect = vi.fn((key: string) => {
      if (key === "seamlessSwitchEmergencySwitchEnabled") {
        return { key: `codexAccounts.${key}`, globalValue: true };
      }
      return { key: `codexAccounts.${key}`, defaultValue: key === "seamlessSwitchThreshold" ? 3 : undefined };
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_: string, fallback: unknown) => fallback),
      inspect
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchThreshold).toBe(1);

    inspect.mockImplementation((key: string) =>
      key === "seamlessSwitchThreshold"
        ? { key: `codexAccounts.${key}`, globalValue: 5 }
        : { key: `codexAccounts.${key}` }
    );
    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchThreshold).toBe(5);
  });

  it("maps the retired 2% reserve value to the nearest available 3% threshold", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_: string, fallback: unknown) => fallback),
      inspect: vi.fn((key: string) =>
        key === "seamlessSwitchReserveThreshold"
          ? { key: `codexAccounts.${key}`, globalValue: 2 }
          : { key: `codexAccounts.${key}` }
      )
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchThreshold).toBe(3);
  });

  it("defaults all seamless groups to visible and persists an individual group filter", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback: unknown) => (key === "seamlessSwitchGroupBVisible" ? false : fallback)),
      update,
      inspect: vi.fn((key: string) => ({ key: `codexAccounts.${key}` }))
    } as never);

    const settings = new ExtensionSettingsStore().getDashboardSettings();
    expect(settings.seamlessSwitchGroupAVisible).toBe(true);
    expect(settings.seamlessSwitchGroupBVisible).toBe(false);
    expect(settings.seamlessSwitchGroupCVisible).toBe(true);

    await expect(handleDashboardSettingUpdate("seamlessSwitchGroupCVisible", false)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith("seamlessSwitchGroupCVisible", false, vscode.ConfigurationTarget.Global);
  });

  it("migrates the installed runtime flag to the seamless behavior switch until explicitly configured", () => {
    const inspect = vi.fn((key: string) => ({ key: `codexAccounts.${key}`, defaultValue: false }));
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback: unknown) => (key === "hotSwitchEnabled" ? true : fallback)),
      inspect
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchEnabled).toBe(true);

    inspect.mockImplementation((key: string) => ({
      key: `codexAccounts.${key}`,
      defaultValue: false,
      ...(key === "seamlessSwitchEnabled" ? { globalValue: false } : {})
    }));
    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchEnabled).toBe(false);
  });

  it("persists the seamless behavior master switch without uninstalling the runtime", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn((key: string) => ({ key: `codexAccounts.${key}` }))
    } as never);

    await expect(handleDashboardSettingUpdate("seamlessSwitchEnabled", false)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("seamlessSwitchEnabled", false, vscode.ConfigurationTarget.Global);
    expect(update).not.toHaveBeenCalledWith("hotSwitchEnabled", expect.anything(), expect.anything());
  });
});
