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
});
