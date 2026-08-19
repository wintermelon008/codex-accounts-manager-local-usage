import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, parseList } from "../src/config.mjs";

describe("Feishu assistant config", () => {
  it("requires private app, manager token, and administrator ids", () => {
    assert.throws(
      () => loadConfig({ FEISHU_APP_ID: "app", FEISHU_APP_SECRET: "secret", MANAGER_CONTROL_TOKEN: "token" }),
      /FEISHU_ADMIN_OPEN_IDS/u
    );
  });

  it("normalizes administrator ids and manager URL", () => {
    const config = loadConfig({
      FEISHU_APP_ID: "app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_ADMIN_OPEN_IDS: "admin-1, admin-1,admin-2",
      MANAGER_CONTROL_TOKEN: "control-token",
      MANAGER_CONTROL_URL: "http://127.0.0.1:43117/",
      FEISHU_ASSISTANT_WEB_WORKFLOW_STATE_PATH: "/tmp/workflows.json",
      FEISHU_ASSISTANT_WEB_EXECUTOR_MODULE: "/tmp/executor.mjs",
      FEISHU_ASSISTANT_OPENAI_API_KEY: "openai-key",
      FEISHU_ASSISTANT_WEB_MODEL: "gpt-test"
    });
    assert.deepEqual([...config.feishu.adminOpenIds], ["admin-1", "admin-2"]);
    assert.equal(config.manager.baseUrl, "http://127.0.0.1:43117");
    assert.equal(config.payment.pollIntervalMs, 10_000);
    assert.equal(config.payment.providerModule, undefined);
    assert.equal(config.web.workflowStatePath, "/tmp/workflows.json");
    assert.equal(config.web.executorModule, "/tmp/executor.mjs");
    assert.equal(config.web.openAiApiKey, "openai-key");
    assert.equal(config.web.model, "gpt-test");
  });

  it("parses comma-separated values without empty entries", () => {
    assert.deepEqual(parseList("a,, b, a"), ["a", "b"]);
  });
});
