"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveManagerIntegrationApi } = require("../../src/managerApi.cjs");

test("Manager API resolver uses only the optional Dashboard integration surface", async () => {
  const registerDashboardIntegration = () => undefined;
  const vscode = {
    extensions: {
      getExtension(id) {
        assert.equal(id, "wannanbigpig.codex-accounts-manager");
        return { activate: async () => ({ apiVersion: 1, registerDashboardIntegration }) };
      }
    }
  };
  const api = await resolveManagerIntegrationApi(vscode);
  assert.equal(api.registerDashboardIntegration, registerDashboardIntegration);
});

test("Mailbox can activate independently when Manager is not installed", async () => {
  const api = await resolveManagerIntegrationApi({ extensions: { getExtension: () => undefined } });
  assert.equal(api, undefined);
});
