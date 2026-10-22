import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { isSupportedProxyUrl } from "./proxyEnvironment";

const MANAGER_PROXY_SELECTION_FILE = "manager-proxy-selection.json";
const MANAGER_PROXY_SELECTION_SCHEMA = "codex-accounts-manager-proxy-selection/v1" as const;

type ManagerProxySelectionDocument = {
  schema: typeof MANAGER_PROXY_SELECTION_SCHEMA;
  httpsProxy: string;
};

/** Return the shared state path used by the VS Code Manager and headless daemon. */
export function getManagerProxySelectionPath(privateRoot: string): string {
  return path.join(privateRoot, MANAGER_PROXY_SELECTION_FILE);
}

/**
 * Read the proxy selected in the Manager Dashboard.
 *
 * Missing, malformed, or no-selection state deliberately resolves to
 * undefined so callers can retain the existing process/CODEX_HOME fallback.
 */
export async function readManagerProxySelection(privateRoot: string): Promise<string | undefined> {
  let contents: string;
  try {
    contents = await readFile(getManagerProxySelectionPath(privateRoot), "utf8");
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
  if (!isManagerProxySelectionDocument(parsed)) {
    return undefined;
  }

  const value = parsed.httpsProxy.trim();
  return value && isSupportedProxyUrl(value) ? value : undefined;
}

/** Persist the Dashboard selection with a same-directory atomic replacement. */
export async function writeManagerProxySelection(privateRoot: string, httpsProxy: string): Promise<void> {
  const value = httpsProxy.trim();
  if (value && !isSupportedProxyUrl(value)) {
    throw new Error("Manager proxy selection must be an absolute http:// or https:// URL");
  }

  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const target = getManagerProxySelectionPath(privateRoot);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const document: ManagerProxySelectionDocument = {
    schema: MANAGER_PROXY_SELECTION_SCHEMA,
    httpsProxy: value
  };

  try {
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isManagerProxySelectionDocument(value: unknown): value is ManagerProxySelectionDocument {
  if (!value || typeof value !== "object") {
    return false;
  }
  const document = value as Partial<ManagerProxySelectionDocument>;
  return document.schema === MANAGER_PROXY_SELECTION_SCHEMA && typeof document.httpsProxy === "string";
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
