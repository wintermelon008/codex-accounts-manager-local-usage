"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MANAGER_EXTENSION_ID, resolveManagerIntegrationApi } = require("../src/managerApi.cjs");

test("requires the public Manager API instead of importing Manager source", async () => {
  const api = {
    apiVersion: 1,
    registerGateway() {},
    registerDashboardIntegration() {}
  };
  const vscode = { extensions: { getExtension: (id) => (id === MANAGER_EXTENSION_ID ? { activate: async () => api } : undefined) } };
  assert.equal(await resolveManagerIntegrationApi(vscode), api);
  await assert.rejects(resolveManagerIntegrationApi({ extensions: { getExtension: () => undefined } }), /must be installed/u);
  await assert.rejects(
    resolveManagerIntegrationApi({ extensions: { getExtension: () => ({ activate: async () => ({ apiVersion: 2 }) }) } }),
    /compatible/u
  );
});

test("package sources do not reach back into the Manager repository", async () => {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const root = path.join(__dirname, "..", "src");
  const names = await fs.readdir(root);
  const contents = await Promise.all(names.map((name) => fs.readFile(path.join(root, name), "utf8")));
  assert.ok(contents.every((content) => !content.includes("../../src/") && !content.includes("../../../src/")));
});
