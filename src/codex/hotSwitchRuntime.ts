import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { needsRefresh, refreshTokens } from "../auth/oauth";
import type { CodexAccountRecord, CodexTokens } from "../core/types";
import { decodeJwtPayload } from "../utils/jwt";
import {
  getCodexAccountsConfiguration,
  normalizeHotSwitchGraceSeconds,
  normalizeHotSwitchLongTurnPolicy
} from "../infrastructure/config/extensionSettings";
import type { AccountsRepository } from "../storage";
import {
  getCurrentWindowRuntimeAccountId,
  setCurrentWindowRuntimeAccountId
} from "../presentation/workbench/windowRuntimeAccount";
import {
  CodexHotSwitchBridge,
  HotSwitchAccountResult,
  HotSwitchIdentity,
  HotSwitchLongTurnPolicy,
  HotSwitchRefreshRequest,
  HotSwitchRefreshResult,
  HotSwitchStatus
} from "./hotSwitchBridge";

const HOT_SWITCH_ENABLED = "hotSwitchEnabled";
const HOT_SWITCH_GRACE_SECONDS = "hotSwitchGraceSeconds";
const HOT_SWITCH_LONG_TURN_POLICY = "hotSwitchLongTurnPolicy";
const OPENAI_EXTENSION_ID = "openai.chatgpt";
const PREVIOUS_CLI_SETTING_KEY = "hotSwitch.previousCliExecutable";
const TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;
const RUNTIME_DIRECTORY = "hot-switch-runtime";
const SHIM_LAUNCHER_FILE = "codex-app-server-shim";
const SHIM_FILE = "codex-app-server-shim.cjs";
const SHIM_CONFIG_FILE = "codex-app-server-shim.json";

export type HotSwitchSetupResult = {
  enabled: boolean;
  configured: boolean;
  requiresReload: boolean;
  requiresUserConfiguration: boolean;
  manualCliSetting?: string;
  shimPath?: string;
  error?: string;
};

export type RuntimeAccessTokenIdentity = {
  email: string;
  userId?: string;
};

export type RuntimeAccountSwitchOptions = {
  gracePeriodMs?: number;
  longTurnPolicy?: HotSwitchLongTurnPolicy;
  recoverRecentUsageLimitedTurns?: boolean;
};

export class CodexHotSwitchRuntime implements vscode.Disposable {
  private bridge: CodexHotSwitchBridge | undefined;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repo: AccountsRepository
  ) {}

  async initialize(): Promise<HotSwitchSetupResult> {
    if (!isHotSwitchEnabled()) {
      return {
        enabled: false,
        configured: false,
        requiresReload: false,
        requiresUserConfiguration: false
      };
    }
    return this.configureRuntime();
  }

  isEnabled(): boolean {
    return isHotSwitchEnabled();
  }

  async enable(): Promise<HotSwitchSetupResult> {
    await getCodexAccountsConfiguration().update(HOT_SWITCH_ENABLED, true, vscode.ConfigurationTarget.Global);
    return this.configureRuntime();
  }

  async disable(): Promise<HotSwitchSetupResult> {
    try {
      await getCodexAccountsConfiguration().update(HOT_SWITCH_ENABLED, false, vscode.ConfigurationTarget.Global);
      this.bridge?.dispose();
      this.bridge = undefined;
      const runtimeShimPath = path.join(this.context.globalStorageUri.fsPath, RUNTIME_DIRECTORY, SHIM_FILE);
      const runtimeLauncherPath = path.join(
        this.context.globalStorageUri.fsPath,
        RUNTIME_DIRECTORY,
        SHIM_LAUNCHER_FILE
      );
      const chatgptConfig = vscode.workspace.getConfiguration("chatgpt");
      const currentCliPath = chatgptConfig.get<string | null>("cliExecutable", null);
      const previousCliPath = this.context.globalState.get<string | null>(PREVIOUS_CLI_SETTING_KEY);
      const currentlyUsesRuntime = currentCliPath === runtimeLauncherPath || currentCliPath === runtimeShimPath;
      let requiresReload = false;
      let requiresUserConfiguration = false;
      let manualCliSetting: string | undefined;
      if (currentlyUsesRuntime) {
        const restoredCliPath = previousCliPath === undefined ? null : previousCliPath;
        if (isRemoteExtensionHost()) {
          requiresUserConfiguration = true;
          manualCliSetting = formatCliExecutableUserSetting(restoredCliPath);
        } else {
          await chatgptConfig.update("cliExecutable", restoredCliPath, vscode.ConfigurationTarget.Global);
          requiresReload = true;
        }
      }
      await this.context.globalState.update(PREVIOUS_CLI_SETTING_KEY, undefined);
      return {
        enabled: false,
        configured: false,
        requiresReload,
        requiresUserConfiguration,
        manualCliSetting
      };
    } catch (error) {
      return {
        enabled: false,
        configured: false,
        requiresReload: false,
        requiresUserConfiguration: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getStatus(): Promise<HotSwitchStatus> {
    if (!this.bridge) {
      throw new Error("Codex hot switch is not configured");
    }
    return this.bridge.getStatus();
  }

  async getIdentity(): Promise<HotSwitchIdentity> {
    if (!this.bridge) {
      throw new Error("Codex hot switch is not configured");
    }
    return this.bridge.getIdentity();
  }

  async switchAccount(accountId: string, options: RuntimeAccountSwitchOptions = {}): Promise<HotSwitchAccountResult> {
    if (!isHotSwitchEnabled()) {
      throw new Error("Codex hot switch is not enabled");
    }
    if (!this.bridge) {
      throw new Error("Codex hot switch is enabled, but its runtime is not ready; restart the extension host");
    }

    const account = await this.repo.getAccount(accountId);
    let tokens = await this.repo.getTokens(accountId);
    if (!account || !tokens?.accessToken) {
      throw new Error("The selected account has no usable Codex credentials");
    }
    if (needsRefresh(tokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)) {
      tokens = await this.refreshAccountTokens(account, tokens);
    }
    const runtimeIdentity = resolveRuntimeAccessTokenIdentity(account, tokens.accessToken);
    const remoteAccountId = account.accountId ?? tokens.accountId;
    if (!remoteAccountId) {
      throw new Error("The selected account has no ChatGPT workspace identifier");
    }
    const previousLocalAccountId = getCurrentWindowRuntimeAccountId();
    const previousAccount = previousLocalAccountId ? await this.repo.getAccount(previousLocalAccountId) : undefined;
    let previousTokens = previousLocalAccountId ? await this.repo.getTokens(previousLocalAccountId) : undefined;
    if (
      previousAccount &&
      previousTokens?.accessToken &&
      needsRefresh(previousTokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)
    ) {
      previousTokens = await this.refreshAccountTokens(previousAccount, previousTokens);
    }
    const previousRemoteAccountId = previousAccount?.accountId ?? previousTokens?.accountId;
    if (!previousLocalAccountId || !previousRemoteAccountId) {
      throw new Error("The current Codex runtime account cannot be identified for safe rollback");
    }
    if (!previousAccount || !previousTokens?.accessToken) {
      throw new Error("The current Codex runtime account credentials cannot be identified for safe rollback");
    }
    const previousRuntimeIdentity = resolveRuntimeAccessTokenIdentity(previousAccount, previousTokens.accessToken);

    const result = await this.bridge.switchAccount({
      accessToken: tokens.accessToken,
      accountId: remoteAccountId,
      localAccountId: account.id,
      previousAccountId: previousRemoteAccountId,
      previousLocalAccountId,
      previousExpectedEmail: previousRuntimeIdentity.email,
      expectedEmail: runtimeIdentity.email,
      planType: account.planType,
      gracePeriodMs: options.gracePeriodMs ?? getHotSwitchGraceSeconds() * 1_000,
      longTurnPolicy: options.longTurnPolicy ?? getHotSwitchLongTurnPolicy(),
      recoverRecentUsageLimitedTurns: options.recoverRecentUsageLimitedTurns
    });
    return result;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.bridge?.dispose();
    this.bridge = undefined;
  }

  private async configureRuntime(): Promise<HotSwitchSetupResult> {
    try {
      if (process.platform === "win32") {
        throw new Error("Experimental Codex account hot switch is not yet supported on Windows");
      }
      const realCliPath = await resolveOpenAiCodexCliPath();
      const runtimeDirectory = path.join(this.context.globalStorageUri.fsPath, RUNTIME_DIRECTORY);
      const shimSource = this.context.asAbsolutePath(path.join("runtime", SHIM_FILE));
      const shimDestination = path.join(runtimeDirectory, SHIM_FILE);
      const launcherDestination = path.join(runtimeDirectory, SHIM_LAUNCHER_FILE);
      const shimConfigDestination = path.join(runtimeDirectory, SHIM_CONFIG_FILE);

      await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
      await fs.copyFile(shimSource, shimDestination);
      await fs.chmod(shimDestination, 0o700);
      await writePosixLauncher(launcherDestination, process.execPath, shimDestination);
      await writeJsonAtomically(shimConfigDestination, { realCliPath, forceHttpTransport: true }, 0o600);

      const chatgptConfig = vscode.workspace.getConfiguration("chatgpt");
      const currentCliPath = chatgptConfig.get<string | null>("cliExecutable", null);
      const needsCliConfiguration = currentCliPath !== launcherDestination;
      const requiresUserConfiguration = needsCliConfiguration && isRemoteExtensionHost();
      let requiresReload = false;
      if (needsCliConfiguration) {
        if (this.context.globalState.get<string | null>(PREVIOUS_CLI_SETTING_KEY) === undefined) {
          await this.context.globalState.update(PREVIOUS_CLI_SETTING_KEY, currentCliPath);
        }
        if (!requiresUserConfiguration) {
          await chatgptConfig.update("cliExecutable", launcherDestination, vscode.ConfigurationTarget.Global);
          requiresReload = true;
        }
      }

      this.bridge?.dispose();
      this.bridge = undefined;
      if (!requiresUserConfiguration && !requiresReload) {
        const candidateBridge = new CodexHotSwitchBridge(
          (request) => this.refreshRuntimeAuth(request),
          (localAccountId) => this.activateLocalAccount(localAccountId)
        );
        if (isOpenAiCodexExtensionActive()) {
          try {
            const status = await candidateBridge.getStatus();
            requiresReload =
              !status.ready || status.runtimeProtocolVersion !== 2 || status.httpTransportForced !== true;
          } catch {
            requiresReload = true;
          }
        }
        if (requiresReload) {
          candidateBridge.dispose();
        } else {
          this.bridge = candidateBridge;
        }
      }
      return {
        enabled: true,
        configured: !requiresUserConfiguration && !requiresReload,
        requiresReload,
        requiresUserConfiguration,
        manualCliSetting: requiresUserConfiguration ? formatCliExecutableUserSetting(launcherDestination) : undefined,
        shimPath: launcherDestination
      };
    } catch (error) {
      return {
        enabled: true,
        configured: false,
        requiresReload: false,
        requiresUserConfiguration: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async refreshRuntimeAuth(request: HotSwitchRefreshRequest): Promise<HotSwitchRefreshResult> {
    const accounts = await this.repo.listAccounts();
    const account = selectManagedAccountForRefresh(accounts, request, getCurrentWindowRuntimeAccountId());

    let tokens = await this.repo.getTokens(account.id);
    if (!tokens?.accessToken) {
      throw new Error("The managed account has no access token");
    }
    if (needsRefresh(tokens.accessToken, TOKEN_REFRESH_SKEW_SECONDS)) {
      tokens = await this.refreshAccountTokens(account, tokens);
    }
    resolveRuntimeAccessTokenIdentity(account, tokens.accessToken);

    const remoteAccountId = account.accountId ?? tokens.accountId;
    if (!remoteAccountId) {
      throw new Error("The managed account has no ChatGPT workspace identifier");
    }
    if (request.previousAccountId && remoteAccountId !== request.previousAccountId) {
      throw new Error("The managed account does not match the Codex workspace refresh request");
    }
    return {
      accessToken: tokens.accessToken,
      chatgptAccountId: remoteAccountId,
      chatgptPlanType: account.planType ?? null
    };
  }

  private async activateLocalAccount(localAccountId: string): Promise<void> {
    await this.repo.switchAccount(localAccountId);
    setCurrentWindowRuntimeAccountId(localAccountId);
  }

  private async refreshAccountTokens(account: CodexAccountRecord, tokens: CodexTokens): Promise<CodexTokens> {
    if (!tokens.refreshToken) {
      throw new Error("The managed account token expired and has no refresh token");
    }
    const refreshed = await refreshTokens(tokens.refreshToken, tokens.idToken);
    const effectiveTokens = {
      ...refreshed,
      accountId: refreshed.accountId ?? account.accountId ?? tokens.accountId
    };
    await this.repo.updateTokens(account.id, effectiveTokens);
    return effectiveTokens;
  }
}

export function selectManagedAccountForRefresh(
  accounts: readonly CodexAccountRecord[],
  request: HotSwitchRefreshRequest,
  currentLocalAccountId?: string
): CodexAccountRecord {
  let account: CodexAccountRecord | undefined;

  if (request.localAccountId) {
    account = accounts.find((candidate) => candidate.id === request.localAccountId);
    if (!account) {
      throw new Error("No managed account matches the local Codex refresh identity");
    }
  } else if (currentLocalAccountId) {
    const current = accounts.find((candidate) => candidate.id === currentLocalAccountId);
    if (!request.previousAccountId || current?.accountId === request.previousAccountId) {
      account = current;
    }
  }

  if (!account && request.previousAccountId) {
    const matches = accounts.filter((candidate) => candidate.accountId === request.previousAccountId);
    if (matches.length > 1) {
      throw new Error("The Codex workspace refresh request matches multiple managed accounts");
    }
    account = matches[0];
  }

  if (!account && !request.previousAccountId) {
    const activeAccounts = accounts.filter((candidate) => candidate.isActive);
    if (activeAccounts.length === 1) {
      account = activeAccounts[0];
    }
  }

  if (!account) {
    throw new Error("No managed account matches the Codex refresh request");
  }
  if (request.previousAccountId && account.accountId && account.accountId !== request.previousAccountId) {
    throw new Error("The managed account does not match the Codex workspace refresh request");
  }
  return account;
}

export function resolveRuntimeAccessTokenIdentity(
  account: Pick<CodexAccountRecord, "email" | "userId">,
  accessToken: string
): RuntimeAccessTokenIdentity {
  const payload = decodeJwtPayload(accessToken);
  const auth = readObject(payload["https://api.openai.com/auth"]);
  const profile = readObject(payload["https://api.openai.com/profile"]);
  const email =
    readIdentityString(payload, "email") ??
    readIdentityString(payload, "preferred_username") ??
    readIdentityString(payload, "upn") ??
    readIdentityString(profile, "email");
  if (!email) {
    throw new Error("The managed account access token has no runtime email identity");
  }

  const userId =
    readIdentityString(auth, "chatgpt_user_id") ??
    readIdentityString(auth, "user_id") ??
    readIdentityString(payload, "sub");
  const expectedUserId = account.userId?.trim();
  if (expectedUserId) {
    if (!userId || userId !== expectedUserId) {
      throw new Error("The managed account access token belongs to a different user");
    }
  } else if (normalizeEmail(email) !== normalizeEmail(account.email)) {
    throw new Error("The managed account access token email differs and no stable user identity is available");
  }

  return { email, userId };
}

export function isHotSwitchEnabled(): boolean {
  return getCodexAccountsConfiguration().get<boolean>(HOT_SWITCH_ENABLED, false);
}

export function getHotSwitchGraceSeconds(): number {
  return normalizeHotSwitchGraceSeconds(getCodexAccountsConfiguration().get<number>(HOT_SWITCH_GRACE_SECONDS, 60));
}

export function getHotSwitchLongTurnPolicy(): HotSwitchLongTurnPolicy {
  return normalizeHotSwitchLongTurnPolicy(
    getCodexAccountsConfiguration().get<string>(HOT_SWITCH_LONG_TURN_POLICY, "defer")
  );
}

export function formatCliExecutableUserSetting(value: string | null): string {
  return `"chatgpt.cliExecutable": ${JSON.stringify(value)}`;
}

function isRemoteExtensionHost(): boolean {
  return typeof vscode.env.remoteName === "string" && vscode.env.remoteName.length > 0;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readIdentityString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isOpenAiCodexExtensionActive(): boolean {
  return vscode.extensions.getExtension(OPENAI_EXTENSION_ID)?.isActive === true;
}

async function resolveOpenAiCodexCliPath(): Promise<string> {
  const extension = vscode.extensions.getExtension(OPENAI_EXTENSION_ID);
  if (!extension) {
    throw new Error("The official OpenAI Codex extension is not installed");
  }

  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  if (!architecture) {
    throw new Error(`Unsupported Codex architecture: ${process.arch}`);
  }
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const cliPath = path.join(extension.extensionPath, "bin", `${platform}-${architecture}`, executableName);
  await fs.access(cliPath);
  return cliPath;
}

async function writeJsonAtomically(filePath: string, value: unknown, mode: number): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await fs.rename(temporaryPath, filePath);
  await fs.chmod(filePath, mode);
}

async function writePosixLauncher(filePath: string, nodePath: string, shimPath: string): Promise<void> {
  const contents = [
    "#!/bin/sh",
    `ELECTRON_RUN_AS_NODE=1 exec ${quotePosixArgument(nodePath)} ${quotePosixArgument(shimPath)} "$@"`,
    ""
  ].join("\n");
  await fs.writeFile(filePath, contents, { encoding: "utf8", mode: 0o700 });
  await fs.chmod(filePath, 0o700);
}

function quotePosixArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
