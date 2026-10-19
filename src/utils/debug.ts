import * as vscode from "vscode";
import {
  configureNetworkDebug,
  formatNetworkDebugLines,
  logNetworkEvent as logHostNetworkEvent
} from "./networkDebug";

let networkOutputChannel: vscode.OutputChannel | undefined;

export function registerDebugOutput(context: vscode.ExtensionContext): void {
  networkOutputChannel ??= vscode.window.createOutputChannel("Codex Accounts Network");

  configureNetworkDebug({
    enabledReader: () =>
      vscode.workspace.getConfiguration("codexAccounts").get<boolean>("debugNetwork", false),
    sink: (scope, detail) => {
      networkOutputChannel?.appendLine(formatNetworkDebugLines(scope, detail).join("\n"));
    }
  });

  context.subscriptions.push(networkOutputChannel);
}

export function logNetworkEvent(scope: string, detail: Record<string, unknown>): void {
  // Preserve the old lazy behavior for extension callers that emit a network
  // event before AccountsWorkbench.activate() registers the output channel.
  if (!networkOutputChannel) {
    networkOutputChannel = vscode.window.createOutputChannel("Codex Accounts Network");
    configureNetworkDebug({
      enabledReader: () =>
        vscode.workspace.getConfiguration("codexAccounts").get<boolean>("debugNetwork", false),
      sink: (eventScope, eventDetail) => {
        networkOutputChannel?.appendLine(formatNetworkDebugLines(eventScope, eventDetail).join("\n"));
      }
    });
  }
  logHostNetworkEvent(scope, detail);
}
