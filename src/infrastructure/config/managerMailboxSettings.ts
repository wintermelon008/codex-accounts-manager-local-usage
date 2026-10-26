import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

const MANAGER_MAILBOX_SETTINGS_FILE = "manager-mailbox-settings.json";
const MANAGER_MAILBOX_SETTINGS_SCHEMA = "codex-accounts-manager-mailbox-settings/v1" as const;

type ManagerMailboxSettingsDocument = {
  schema: typeof MANAGER_MAILBOX_SETTINGS_SCHEMA;
  enabled: boolean;
};

export function getManagerMailboxSettingsPath(privateRoot: string): string {
  return path.join(privateRoot, MANAGER_MAILBOX_SETTINGS_FILE);
}

/**
 * Read the Dashboard-controlled Mailbox switch.
 *
 * Missing or malformed state is deliberately treated as undefined. Callers
 * use false as the safe default, so a partial write can never enable Mailbox.
 */
export async function readManagerMailboxEnabled(privateRoot: string): Promise<boolean | undefined> {
  let contents: string;
  try {
    contents = await readFile(getManagerMailboxSettingsPath(privateRoot), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }

  if (!isManagerMailboxSettingsDocument(parsed)) {
    return undefined;
  }
  return parsed.enabled;
}

/** Persist the Mailbox switch with a same-directory atomic replacement. */
export async function writeManagerMailboxEnabled(privateRoot: string, enabled: boolean): Promise<void> {
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const target = getManagerMailboxSettingsPath(privateRoot);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const document: ManagerMailboxSettingsDocument = {
    schema: MANAGER_MAILBOX_SETTINGS_SCHEMA,
    enabled
  };

  try {
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isManagerMailboxSettingsDocument(value: unknown): value is ManagerMailboxSettingsDocument {
  if (!value || typeof value !== "object") {
    return false;
  }
  const document = value as Partial<ManagerMailboxSettingsDocument>;
  return document.schema === MANAGER_MAILBOX_SETTINGS_SCHEMA && typeof document.enabled === "boolean";
}
