import * as vscode from "vscode";
import type { HotSwitchSetupResult } from "../../codex";

type HotSwitchSetupIntent = "enable" | "disable";

const COPY_SETTING_ACTION = "Copy setting & open User Settings";
const LATER_ACTION = "Later";

export async function promptForManualHotSwitchConfiguration(
  result: HotSwitchSetupResult,
  intent: HotSwitchSetupIntent
): Promise<void> {
  if (!result.requiresUserConfiguration || !result.manualCliSetting) {
    return;
  }

  const message =
    intent === "enable"
      ? "Remote VS Code cannot write Codex's application-scoped CLI setting. Copy the generated value into local User Settings (not Remote Settings), then reload once."
      : "Remote VS Code cannot restore Codex's application-scoped CLI setting. Copy the generated value into local User Settings (not Remote Settings), then reload once.";
  const choice = await vscode.window.showInformationMessage(message, COPY_SETTING_ACTION, LATER_ACTION);
  if (choice !== COPY_SETTING_ACTION) {
    return;
  }

  await vscode.env.clipboard.writeText(result.manualCliSetting);
  await vscode.commands.executeCommand("workbench.action.openSettingsJson");
  void vscode.window.showInformationMessage(
    "The generated setting was copied. Paste it into the opened local User Settings JSON, save, and reload this window once."
  );
}
