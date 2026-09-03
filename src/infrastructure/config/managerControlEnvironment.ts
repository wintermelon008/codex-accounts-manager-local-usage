import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MANAGER_CONTROL_TOKEN = "CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN";
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
  if (process.env[MANAGER_CONTROL_TOKEN]?.trim()) {
    return;
  }

  let contents: string;
  try {
    contents = await readFile(MANAGER_CONTROL_ENV_FILE, "utf8");
  } catch {
    return;
  }

  const token = parseManagerControlToken(contents);
  if (token) {
    process.env[MANAGER_CONTROL_TOKEN] = token;
  }
}

export function parseManagerControlToken(contents: string): string | undefined {
  const match = /^\s*(?:export\s+)?CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN\s*=\s*(.*?)\s*$/mu.exec(contents);
  const value = match?.[1];
  if (!value) {
    return undefined;
  }
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1).trim() || undefined;
  }
  return value;
}
