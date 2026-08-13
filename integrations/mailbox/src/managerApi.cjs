"use strict";

const MANAGER_EXTENSION_ID = "wannanbigpig.codex-accounts-manager";
const MANAGER_INTEGRATION_API_VERSION = 1;

/**
 * Mailbox is useful without Manager. A missing Manager therefore returns
 * undefined instead of preventing the optional extension from activating.
 */
async function resolveManagerIntegrationApi(vscode) {
  const extension = vscode.extensions.getExtension(MANAGER_EXTENSION_ID);
  if (!extension) {
    return undefined;
  }
  const api = await extension.activate();
  if (!api || api.apiVersion !== MANAGER_INTEGRATION_API_VERSION) {
    throw new Error("Codex Accounts Manager does not expose a compatible integration API.");
  }
  if (typeof api.registerDashboardIntegration !== "function") {
    throw new Error("Codex Accounts Manager returned an incomplete integration API.");
  }
  return api;
}

module.exports = {
  MANAGER_EXTENSION_ID,
  MANAGER_INTEGRATION_API_VERSION,
  resolveManagerIntegrationApi
};
