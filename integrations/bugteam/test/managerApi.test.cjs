"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { MANAGER_EXTENSION_ID, resolveManagerIntegrationApi } = require("../src/managerApi.cjs");

test("BugTeam resolves only the public Manager dashboard and pool-import surface", async () => {
  const api = {
    apiVersion: 1,
    registerDashboardIntegration() {},
    importSharedAccountsToBalancePool() {}
  };
  const vscode = {
    extensions: {
      getExtension(id) {
        assert.equal(id, MANAGER_EXTENSION_ID);
        return { activate: async () => api };
      }
    }
  };
  assert.equal(await resolveManagerIntegrationApi(vscode), api);
  await assert.rejects(
    resolveManagerIntegrationApi({ extensions: { getExtension: () => ({ activate: async () => ({ apiVersion: 1, registerDashboardIntegration() {} }) }) } }),
    /balance-pool import/u
  );
});

test("BugTeam package sources do not import Manager source files", async () => {
  const root = path.join(__dirname, "..", "src");
  const files = [];
  await collect(root, files);
  const contents = await Promise.all(files.map((file) => fs.readFile(file, "utf8")));
  assert.ok(contents.every((content) => !content.includes("../../src/") && !content.includes("../../../src/")));
});

async function collect(directory, output) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target, output);
    else output.push(target);
  }
}
