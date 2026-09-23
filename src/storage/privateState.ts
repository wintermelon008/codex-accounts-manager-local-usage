import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PRIVATE_STATE_DIRECTORY_NAME = "private";
export const PRIVATE_STATE_DIRECTORY_ENV = "CODEX_ACCOUNTS_PRIVATE_DIR";

export const PRIVATE_STATE_FILE_NAMES = {
  accountsIndex: "accounts-index.json",
  accountsSecrets: "accounts-secrets.v1.json",
  hostPolicy: "host-policy.v1.json",
  hostState: "host-state.v1.json",
  latestSnapshot: "manager-state.latest.age",
  previousSnapshot: "manager-state.previous.age",
  snapshotManifest: "manager-state.manifest.json",
  managerControlEnvironment: "manager-control.env",
  sharingState: "sharing-local-state-v1.json",
  sharingHealth: "sharing-health.json"
} as const;

export type PrivateStateContext = {
  extensionUri?: { fsPath?: string };
  globalStorageUri?: { fsPath?: string };
};

export type PrivateStatePaths = {
  root: string;
  accountsIndex: string;
  accountsSecrets: string;
  hostPolicy: string;
  hostState: string;
  latestSnapshot: string;
  previousSnapshot: string;
  snapshotManifest: string;
  managerControlEnvironment: string;
  sharingState: string;
  sharingHealth: string;
  importInbox: string;
  sessionRegistry: string;
  hotSwitchRuntime: string;
};

export type PrivateHostPolicy = {
  schema: "codex-accounts-host-policy/v1";
  sync: {
    mode: "daily";
    hour: 0;
    timezone: "local";
  };
  promotion: "explicit";
  autoPromote: false;
};

export type PrivateHostState = {
  schema: "codex-accounts-host-state/v1";
  role: "uninitialized" | "standby" | "primary";
  clusterId: string | null;
  hostId: string | null;
  epoch: number;
  sequence: number;
  lastSnapshotAt: string | null;
  lastSyncAt: string | null;
};

export const DEFAULT_PRIVATE_HOST_POLICY: PrivateHostPolicy = {
  schema: "codex-accounts-host-policy/v1",
  sync: {
    mode: "daily",
    hour: 0,
    timezone: "local"
  },
  promotion: "explicit",
  autoPromote: false
};

export const DEFAULT_PRIVATE_HOST_STATE: PrivateHostState = {
  schema: "codex-accounts-host-state/v1",
  role: "uninitialized",
  clusterId: null,
  hostId: null,
  epoch: 0,
  sequence: 0,
  lastSnapshotAt: null,
  lastSyncAt: null
};

/**
 * Resolve the common runtime-private root used by the Manager and its local
 * integrations. An explicit absolute path is preferred so separately
 * installed extensions can share the same private tree. A source checkout
 * uses `<extension root>/private`; an installed extension must not use its
 * replaceable installation directory and therefore falls back to the stable
 * VS Code global-storage directory.
 */
export function resolvePrivateStateRoot(
  context?: PrivateStateContext,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env[PRIVATE_STATE_DIRECTORY_ENV]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`${PRIVATE_STATE_DIRECTORY_ENV} must be an absolute private directory`);
    }
    return path.resolve(configured);
  }

  const extensionRoot = context?.extensionUri?.fsPath?.trim();
  if (extensionRoot && path.isAbsolute(extensionRoot) && isManagerSourceCheckout(extensionRoot)) {
    return path.join(extensionRoot, PRIVATE_STATE_DIRECTORY_NAME);
  }

  const globalStorageRoot = context?.globalStorageUri?.fsPath?.trim();
  if (globalStorageRoot && path.isAbsolute(globalStorageRoot)) {
    return path.resolve(globalStorageRoot);
  }

  return path.join(os.homedir(), ".config", "codex-accounts-manager", PRIVATE_STATE_DIRECTORY_NAME);
}

function isManagerSourceCheckout(extensionRoot: string): boolean {
  return (
    existsSync(path.join(extensionRoot, "private", "README.md")) &&
    existsSync(path.join(extensionRoot, "src", "extension.ts"))
  );
}

export function getPrivateStatePaths(
  context?: PrivateStateContext,
  env: NodeJS.ProcessEnv = process.env
): PrivateStatePaths {
  const root = resolvePrivateStateRoot(context, env);
  return {
    root,
    accountsIndex: path.join(root, PRIVATE_STATE_FILE_NAMES.accountsIndex),
    accountsSecrets: path.join(root, PRIVATE_STATE_FILE_NAMES.accountsSecrets),
    hostPolicy: path.join(root, PRIVATE_STATE_FILE_NAMES.hostPolicy),
    hostState: path.join(root, PRIVATE_STATE_FILE_NAMES.hostState),
    latestSnapshot: path.join(root, PRIVATE_STATE_FILE_NAMES.latestSnapshot),
    previousSnapshot: path.join(root, PRIVATE_STATE_FILE_NAMES.previousSnapshot),
    snapshotManifest: path.join(root, PRIVATE_STATE_FILE_NAMES.snapshotManifest),
    managerControlEnvironment: path.join(root, PRIVATE_STATE_FILE_NAMES.managerControlEnvironment),
    sharingState: path.join(root, PRIVATE_STATE_FILE_NAMES.sharingState),
    sharingHealth: path.join(root, PRIVATE_STATE_FILE_NAMES.sharingHealth),
    importInbox: path.join(root, "import-inbox"),
    sessionRegistry: path.join(root, "session-registry.json"),
    hotSwitchRuntime: path.join(root, "hot-switch-runtime")
  };
}

/** Create only non-sensitive host policy/state files; never overwrite them. */
export async function ensurePrivateStateScaffold(paths: PrivateStatePaths): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700).catch(() => undefined);
  await writeJsonIfMissing(paths.hostPolicy, DEFAULT_PRIVATE_HOST_POLICY);
  await writeJsonIfMissing(paths.hostState, DEFAULT_PRIVATE_HOST_STATE);
}

async function writeJsonIfMissing(filePath: string, value: unknown): Promise<void> {
  try {
    await readFile(filePath, "utf8");
    return;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  try {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await chmod(filePath, 0o600).catch(() => undefined);
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
