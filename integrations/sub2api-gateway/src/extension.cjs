"use strict";

const vscode = require("vscode");
const { resolveManagerIntegrationApi } = require("./managerApi.cjs");
const { Sub2ApiGatewayIntegration } = require("./gatewayIntegration.cjs");

let integration;

async function activate(context) {
  const api = await resolveManagerIntegrationApi(vscode);
  integration = new Sub2ApiGatewayIntegration(vscode, context, api);
  await integration.initialize();
  context.subscriptions.push(integration);
}

function deactivate() {
  integration?.dispose();
  integration = undefined;
}

module.exports = { activate, deactivate };
