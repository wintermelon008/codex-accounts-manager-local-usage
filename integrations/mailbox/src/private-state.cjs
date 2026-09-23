"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PRIVATE_STATE_DIRECTORY_ENV = "CODEX_ACCOUNTS_PRIVATE_DIR";
const MANAGER_EXTENSION_ID = "wannanbigpig.codex-accounts-manager";

function resolvePrivateStateRoot({ storageUri, managerExtensionRoot, env = process.env } = {}) {
  const configured = String(env[PRIVATE_STATE_DIRECTORY_ENV] || "").trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`${PRIVATE_STATE_DIRECTORY_ENV} must be an absolute private directory`);
    }
    return path.resolve(configured);
  }

  if (
    typeof managerExtensionRoot === "string" &&
    path.isAbsolute(managerExtensionRoot) &&
    fs.existsSync(path.join(managerExtensionRoot, "private", "README.md")) &&
    fs.existsSync(path.join(managerExtensionRoot, "src", "extension.ts"))
  ) {
    return path.join(path.resolve(managerExtensionRoot), "private");
  }

  const storageRoot = typeof storageUri?.fsPath === "string" ? storageUri.fsPath.trim() : "";
  if (storageRoot && path.isAbsolute(storageRoot)) {
    // Separately installed Mailbox and Manager extensions have different
    // globalStorage IDs. Reuse Manager's stable storage directory when the
    // normal VS Code globalStorage layout is available; unlike extensionPath,
    // it survives a VSIX replacement.
    const globalStorageRoot = path.dirname(storageRoot);
    if (managerExtensionRoot && path.basename(globalStorageRoot) === "globalStorage") {
      return path.join(globalStorageRoot, MANAGER_EXTENSION_ID);
    }
    return path.resolve(storageRoot);
  }

  // Lightweight host adapters and unit-test contexts may intentionally omit
  // extension storage. Returning undefined preserves the legacy SecretStorage
  // fallback for those contexts; a real VS Code extension host always supplies
  // globalStorageUri.
  return undefined;
}

module.exports = {
  PRIVATE_STATE_DIRECTORY_ENV,
  resolvePrivateStateRoot
};
