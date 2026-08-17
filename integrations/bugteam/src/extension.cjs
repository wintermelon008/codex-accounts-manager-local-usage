"use strict";

const vscode = require("vscode");
const { resolveManagerIntegrationApi } = require("./managerApi.cjs");
const { BugTeamIntegration } = require("./ui/integration.cjs");

let integration;

async function activate(context) {
  const api = await resolveManagerIntegrationApi(vscode);
  integration = new BugTeamIntegration(vscode, context, api);
  await integration.initialize();
  context.subscriptions.push(integration);
}

function deactivate() {
  integration?.dispose();
  integration = undefined;
}

module.exports = { activate, deactivate };
