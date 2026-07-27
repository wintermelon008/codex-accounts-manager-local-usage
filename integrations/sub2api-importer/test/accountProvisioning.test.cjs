"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { importAndConfigureSub2ApiPayload } = require("../src/accountProvisioning.cjs");
const { Sub2ApiImportError } = require("../src/sub2apiClient.cjs");

const configuration = {
  importProxyName: "default",
  importGroupName: "test",
  importConcurrency: 2
};

test("configures only newly imported S+ accounts with default proxy, concurrency, group, and all exact model mappings", async () => {
  const input = payload();
  const existing = account({ id: 10, email: "existing@example.test" });
  const created = account({ id: 11, serverEnriched: true });
  const calls = [];
  let accountListCalls = 0;
  const client = {
    async getJson(path) {
      calls.push({ method: "GET", path });
      if (path === "/api/v1/admin/proxies/all") return [{ id: 7, name: "default", status: "active" }];
      if (path === "/api/v1/admin/groups/all") return [{ id: 8, name: "test", platform: "openai", status: "active" }];
      if (path.startsWith("/api/v1/admin/groups/8/models-list-candidates")) return { models: ["gpt-5*", "gpt-5.5", "gpt-5.6-terra"] };
      if (path === "/api/v1/admin/accounts?page=1&page_size=100") {
        accountListCalls += 1;
        return { pages: 1, items: accountListCalls === 1 ? [existing] : [existing, created] };
      }
      if (path === "/api/v1/admin/accounts/11") {
        return {
          proxy_id: 7,
          concurrency: 2,
          group_ids: [8],
          credentials: { model_mapping: { "gpt-5.5": "gpt-5.5", "gpt-5.6-terra": "gpt-5.6-terra" } }
        };
      }
      assert.fail(`unexpected GET ${path}`);
    },
    async importPayload(value) {
      assert.deepEqual(value, input);
      return { statusCode: 200, accountCreated: 1, accountFailed: 0, proxyCreated: 0, proxyReused: 0, proxyFailed: 0 };
    },
    async putJson(path, body) {
      calls.push({ method: "PUT", path, body });
      assert.equal(path, "/api/v1/admin/accounts/11");
    }
  };

  const result = await importAndConfigureSub2ApiPayload(configuration, input, { client });
  assert.equal(result.accountConfigured, 1);
  const update = calls.find((call) => call.method === "PUT");
  assert.deepEqual(update.body, {
    proxy_id: 7,
    concurrency: 2,
    group_ids: [8],
    credentials: {
      ...input.accounts[0].credentials,
      chatgpt_user_id: "server-user-a",
      organization_id: "server-org-a",
      model_mapping: { "gpt-5*": "gpt-5.5", "gpt-5.5": "gpt-5.5", "gpt-5.6-terra": "gpt-5.6-terra" }
    }
  });
});

test("rejects a missing default proxy before submitting the import", async () => {
  let imported = false;
  const client = {
    async getJson(path) {
      if (path === "/api/v1/admin/proxies/all") return [];
      if (path === "/api/v1/admin/groups/all") return [{ id: 8, name: "test", platform: "openai", status: "active" }];
      assert.fail(`unexpected GET ${path}`);
    },
    async importPayload() {
      imported = true;
    }
  };
  await assert.rejects(
    importAndConfigureSub2ApiPayload(configuration, payload(), { client }),
    (error) => error instanceof Sub2ApiImportError && error.kind === "configurationPreconditionFailed"
  );
  assert.equal(imported, false);
});

test("does not resubmit after an import whose new account cannot be identified", async () => {
  let importCalls = 0;
  let listCalls = 0;
  const client = {
    async getJson(path) {
      if (path === "/api/v1/admin/proxies/all") return [{ id: 7, name: "default", status: "active" }];
      if (path === "/api/v1/admin/groups/all") return [{ id: 8, name: "test", platform: "openai", status: "active" }];
      if (path.startsWith("/api/v1/admin/groups/8/models-list-candidates")) return { models: ["gpt-5.6-terra"] };
      if (path === "/api/v1/admin/accounts?page=1&page_size=100") {
        listCalls += 1;
        return { pages: 1, items: listCalls === 1 ? [] : [account({ id: 11, email: "different@example.test" })] };
      }
      assert.fail(`unexpected GET ${path}`);
    },
    async importPayload() {
      importCalls += 1;
      return { accountCreated: 1, accountFailed: 0, proxyCreated: 0, proxyReused: 0, proxyFailed: 0 };
    },
    async putJson() {
      assert.fail("no unrelated account may be updated");
    }
  };
  await assert.rejects(
    importAndConfigureSub2ApiPayload(configuration, payload(), { client }),
    (error) => error instanceof Sub2ApiImportError && error.kind === "postImportConfigurationFailed"
  );
  assert.equal(importCalls, 1);
});

function payload() {
  return {
    type: "sub2api-data",
    version: 1,
    proxies: [],
    accounts: [account()]
  };
}

function account({ id, email = "account@example.test", serverEnriched = false } = {}) {
  return {
    ...(id ? { id } : {}),
    name: "account-a",
    platform: "openai",
    type: "oauth",
    credentials: {
      access_token: "private-access-token",
      refresh_token: "private-account-refresh-token",
      email,
      chatgpt_account_id: "chatgpt-account-a",
      ...(serverEnriched ? { chatgpt_user_id: "server-user-a", organization_id: "server-org-a" } : {}),
      model_mapping: { "gpt-5*": "gpt-5.5" }
    }
  };
}
