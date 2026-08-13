"use strict";

const vscode = require("vscode");
const { resolveManagerIntegrationApi } = require("./managerApi.cjs");
const { MailboxIntegration } = require("./ui/integration.cjs");

let integration;

async function activate(context) {
  let api;
  try {
    api = await resolveManagerIntegrationApi(vscode);
  } catch (error) {
    void vscode.window.showWarningMessage(error instanceof Error ? error.message : "Manager integration is unavailable.");
  }
  integration = new MailboxIntegration(vscode, context, api);
  await integration.initialize();
  context.subscriptions.push(integration);
}

function deactivate() {
  integration?.dispose();
  integration = undefined;
}

module.exports = { activate, deactivate };
