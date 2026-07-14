import { promises as fs } from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";

const MANIFEST_FILE_NAME = "local-customization.json";
const FEATURE_NAME = "local-usage-dashboard";
const EXTENSION_ID = "wannanbigpig.codex-accounts-manager";

/**
 * This is deliberately fail-closed. A hand-copied or partially overwritten
 * build must not activate the local usage feature until its compatibility
 * manifest again matches the installed package metadata.
 */
export async function isLocalUsageCustomizationCompatible(context: vscode.ExtensionContext): Promise<boolean> {
  try {
    const manifestPath = path.join(context.extensionUri.fsPath, MANIFEST_FILE_NAME);
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as unknown;
    const packageJson = context.extension.packageJSON as unknown;
    const compatible = hasCompatibleLocalUsageManifest(manifest, packageJson);
    if (!compatible) {
      console.warn("[codexAccounts] local usage dashboard disabled: compatibility manifest mismatch");
    }
    return compatible;
  } catch (error) {
    console.warn("[codexAccounts] local usage dashboard disabled: compatibility manifest unavailable", error);
    return false;
  }
}

export function hasCompatibleLocalUsageManifest(manifest: unknown, packageJson: unknown): boolean {
  const customization = asRecord(manifest);
  const extension = asRecord(packageJson);
  if (!customization || !extension) {
    return false;
  }

  const publisher = extension["publisher"];
  const name = extension["name"];
  const version = extension["version"];
  const upstream = asRecord(customization["upstream"]);
  return (
    customization["schemaVersion"] === 1 &&
    customization["feature"] === FEATURE_NAME &&
    customization["extensionId"] === EXTENSION_ID &&
    customization["localBuildVersion"] === version &&
    typeof publisher === "string" &&
    typeof name === "string" &&
    `${publisher}.${name}` === EXTENSION_ID &&
    typeof version === "string" &&
    typeof upstream?.["version"] === "string" &&
    typeof upstream?.["commit"] === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
