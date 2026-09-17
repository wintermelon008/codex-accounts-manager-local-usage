import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MANAGER_CONTROL_TOKEN = "CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN";
const SHARING_RELAY_BOOTSTRAP_TOKEN = "CODEX_ACCOUNTS_SHARING_RELAY_BOOTSTRAP_TOKEN";
const NO_PROXY = "NO_PROXY";
const MANAGER_CONTROL_ENV_FILE = path.join(
  os.homedir(),
  ".config",
  "codex-accounts-manager",
  "manager-control.env"
);

/**
 * Load the Manager control token for extension hosts that do not inherit the
 * shell environment used to start the VS Code Server.
 */
export async function loadManagerControlEnvironment(): Promise<void> {
  const hasControlToken = Boolean(process.env[MANAGER_CONTROL_TOKEN]?.trim());
  const hasSharingBootstrapToken = Boolean(process.env[SHARING_RELAY_BOOTSTRAP_TOKEN]?.trim());
  const hasNoProxy = Boolean(process.env[NO_PROXY]?.trim() || process.env["no_proxy"]?.trim());
  if (hasControlToken && hasSharingBootstrapToken && hasNoProxy) {
    return;
  }

  let contents: string;
  try {
    contents = await readFile(MANAGER_CONTROL_ENV_FILE, "utf8");
  } catch {
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
