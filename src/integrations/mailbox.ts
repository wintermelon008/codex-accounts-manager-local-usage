import { createRequire } from "node:module";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CodexAccountsIntegrationApi } from "./managerIntegrationHost";
import { resolveMailboxRuntimeRoot } from "./mailboxRuntimePath";

export type MailboxIntegrationHandle = vscode.Disposable & {
  initialize: () => Promise<void>;
};

type MailboxIntegrationConstructor = new (
  vscodeApi: typeof vscode,
  context: vscode.ExtensionContext,
  api: CodexAccountsIntegrationApi,
  options?: { onEnabledChanged?: (enabled: boolean) => void | Promise<void> }
) => MailboxIntegrationHandle;

const requireModule = createRequire(__filename);

/** Load the shared Mailbox module from the compiled Manager artifact. */
export function createMailboxIntegration(
  context: vscode.ExtensionContext,
  api: CodexAccountsIntegrationApi,
  onEnabledChanged?: (enabled: boolean) => void | Promise<void>
): MailboxIntegrationHandle {
  const modulePath = resolveMailboxIntegrationPath();
  const loaded = requireModule(modulePath) as { MailboxIntegration?: MailboxIntegrationConstructor };
  if (typeof loaded.MailboxIntegration !== "function") {
    throw new Error(`Mailbox integration module is incomplete: ${modulePath}`);
  }
  return new loaded.MailboxIntegration(vscode, context, api, { onEnabledChanged });
}

function resolveMailboxIntegrationPath(): string {
  return path.join(resolveMailboxRuntimeRoot(), "ui", "integration.cjs");
}
