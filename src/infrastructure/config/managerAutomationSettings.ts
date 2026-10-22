import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

const MANAGER_AUTOMATION_SETTINGS_FILE = "manager-automation-settings.json";
const MANAGER_AUTOMATION_SETTINGS_SCHEMA = "codex-accounts-manager-automation-settings/v1" as const;

type ManagerAutomationSettingsDocument = {
  schema: typeof MANAGER_AUTOMATION_SETTINGS_SCHEMA;
  autoStartQuotaCountdown: boolean;
};

/** Return the shared state path used by the VS Code Manager and headless daemon. */
export function getManagerAutomationSettingsPath(privateRoot: string): string {
  return path.join(privateRoot, MANAGER_AUTOMATION_SETTINGS_FILE);
}

/**
 * Read the Dashboard-controlled automation setting.
 *
 * Missing or malformed state returns undefined so the daemon can retain its
 * explicit environment fallback without treating a partial write as enabled.
 */
export async function readManagerAutomationSettings(privateRoot: string): Promise<boolean | undefined> {
  let contents: string;
  try {
    contents = await readFile(getManagerAutomationSettingsPath(privateRoot), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!isManagerAutomationSettingsDocument(parsed)) {
    return undefined;
  }

  return parsed.autoStartQuotaCountdown;
}

/** Persist the Dashboard setting with a same-directory atomic replacement. */
export async function writeManagerAutomationSettings(
  privateRoot: string,
  autoStartQuotaCountdown: boolean
): Promise<void> {
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const target = getManagerAutomationSettingsPath(privateRoot);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const document: ManagerAutomationSettingsDocument = {
    schema: MANAGER_AUTOMATION_SETTINGS_SCHEMA,
    autoStartQuotaCountdown
  };

  try {
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isManagerAutomationSettingsDocument(value: unknown): value is ManagerAutomationSettingsDocument {
  if (!value || typeof value !== "object") {
    return false;
  }
  const document = value as Partial<ManagerAutomationSettingsDocument>;
  return (
    document.schema === MANAGER_AUTOMATION_SETTINGS_SCHEMA && typeof document.autoStartQuotaCountdown === "boolean"
  );
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
