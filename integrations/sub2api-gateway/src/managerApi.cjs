"use strict";

const MANAGER_EXTENSION_ID = "wannanbigpig.codex-accounts-manager";
const MANAGER_INTEGRATION_API_VERSION = 1;

async function resolveManagerIntegrationApi(vscode) {
  const extension = vscode.extensions.getExtension(MANAGER_EXTENSION_ID);
  if (!extension) {
    throw new Error("Codex Accounts Manager must be installed before enabling the Sub2API Gateway integration.");
  }
  const api = await extension.activate();
  if (!api || api.apiVersion !== MANAGER_INTEGRATION_API_VERSION) {
    throw new Error("Codex Accounts Manager does not expose a compatible integration API.");
  }
  if (
    typeof api.registerGateway !== "function" ||
    typeof api.registerVirtualAccount !== "function"
  ) {
    throw new Error("Codex Accounts Manager returned an incomplete integration API.");
  }
  return api;
}

module.exports = { MANAGER_EXTENSION_ID, MANAGER_INTEGRATION_API_VERSION, resolveManagerIntegrationApi };
