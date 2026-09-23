import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PRIVATE_STATE_DIRECTORY_ENV } from "../../storage/privateState";

const MANAGER_CONTROL_TOKEN = "CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN";
const SHARING_RELAY_BOOTSTRAP_TOKEN = "CODEX_ACCOUNTS_SHARING_RELAY_BOOTSTRAP_TOKEN";
const NO_PROXY = "NO_PROXY";
const LEGACY_MANAGER_CONTROL_ENV_FILE = path.join(
  os.homedir(),
  ".config",
  "codex-accounts-manager",
  "manager-control.env"
);

export type ManagerControlEnvironmentOptions = {
  privateRoot?: string;
};

/**
 * Load the Manager control token for extension hosts that do not inherit the
 * shell environment used to start the VS Code Server.
 */
export async function loadManagerControlEnvironment(options: ManagerControlEnvironmentOptions = {}): Promise<void> {
  const hasControlToken = Boolean(process.env[MANAGER_CONTROL_TOKEN]?.trim());
  const hasSharingBootstrapToken = Boolean(process.env[SHARING_RELAY_BOOTSTRAP_TOKEN]?.trim());
  const hasNoProxy = Boolean(process.env[NO_PROXY]?.trim() || process.env["no_proxy"]?.trim());
  if (hasControlToken && hasSharingBootstrapToken && hasNoProxy) {
    return;
  }

  const privateRoot = options.privateRoot?.trim() || process.env[PRIVATE_STATE_DIRECTORY_ENV]?.trim();
  const candidateFiles = [
    privateRoot && path.isAbsolute(privateRoot) ? path.join(privateRoot, "manager-control.env") : undefined,
    LEGACY_MANAGER_CONTROL_ENV_FILE
  ].filter((filePath): filePath is string => Boolean(filePath));

  let contents: string | undefined;
  for (const filePath of candidateFiles) {
    try {
      contents = await readFile(filePath, "utf8");
      break;
    } catch {
      continue;
    }
  }
  if (contents === undefined) {
    return;
  }

  if (!hasControlToken) {
    const token = parseManagerControlToken(contents);
    if (token) {
      process.env[MANAGER_CONTROL_TOKEN] = token;
    }
  }
  if (!hasSharingBootstrapToken) {
    const token = parseSharingRelayBootstrapToken(contents);
    if (token) {
      process.env[SHARING_RELAY_BOOTSTRAP_TOKEN] = token;
    }
  }
  if (!hasNoProxy) {
    const noProxy = parseNoProxy(contents);
    if (noProxy) {
      process.env[NO_PROXY] = noProxy;
    }
  }
}

export function parseManagerControlToken(contents: string): string | undefined {
  return parseEnvironmentToken(contents, MANAGER_CONTROL_TOKEN);
}

export function parseSharingRelayBootstrapToken(contents: string): string | undefined {
  return parseEnvironmentToken(contents, SHARING_RELAY_BOOTSTRAP_TOKEN);
}

export function parseNoProxy(contents: string): string | undefined {
  return parseEnvironmentToken(contents, NO_PROXY);
}

function parseEnvironmentToken(contents: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`, "mu").exec(contents);
  const value = match?.[1];
  if (!value) {
    return undefined;
  }
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1).trim() || undefined;
  }
  return value;
}
