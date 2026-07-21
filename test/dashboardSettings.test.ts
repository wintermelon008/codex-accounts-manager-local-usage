import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ExtensionSettingsStore } from "../src/infrastructure/config/extensionSettings";
import { handleDashboardSettingUpdate } from "../src/presentation/dashboard/settings";

describe("handleDashboardSettingUpdate", () => {
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

  it("persists a supported local usage range and normalizes unsupported values", async () => {
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

  it("reads and persists only supported seamless reserve thresholds", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback: unknown) => (key === "seamlessSwitchReserveThreshold" ? 2 : fallback)),
      update,
      inspect: vi.fn((key: string) => ({ key: `codexAccounts.${key}` }))
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchReserveThreshold).toBe(2);
    await expect(handleDashboardSettingUpdate("seamlessSwitchReserveThreshold", 1)).resolves.toBe(true);
    await expect(handleDashboardSettingUpdate("seamlessSwitchReserveThreshold", 99)).resolves.toBe(true);

    expect(update).toHaveBeenNthCalledWith(1, "seamlessSwitchReserveThreshold", 1, vscode.ConfigurationTarget.Global);
    expect(update).toHaveBeenNthCalledWith(2, "seamlessSwitchReserveThreshold", 3, vscode.ConfigurationTarget.Global);
  });

  it("reads and persists the 1% emergency switch setting", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback: unknown) =>
        key === "seamlessSwitchEmergencySwitchEnabled" ? true : fallback
      ),
      update,
      inspect: vi.fn((key: string) => ({ key: `codexAccounts.${key}` }))
    } as never);

    expect(new ExtensionSettingsStore().getDashboardSettings().seamlessSwitchEmergencySwitchEnabled).toBe(true);
    await expect(handleDashboardSettingUpdate("seamlessSwitchEmergencySwitchEnabled", false)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(
      "seamlessSwitchEmergencySwitchEnabled",
      false,
      vscode.ConfigurationTarget.Global
    );
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
