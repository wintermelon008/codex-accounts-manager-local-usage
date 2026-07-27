import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfiguration, resolveQueueOptions } from "../src/config.mjs";

describe("private bot configuration", () => {
  it("requires only target-machine private values and preserves explicit portable directories", () => {
    const configuration = loadConfiguration({
      FEISHU_APP_ID: "app-placeholder",
      FEISHU_APP_SECRET: "secret-placeholder",
      FEISHU_VERIFICATION_TOKEN: "verify-placeholder",
      FEISHU_ADMIN_OPEN_IDS: "admin-one,admin-two",
      MANAGER_IMPORT_QUEUE_DIR: "/portable/manager/inbox",
      SUB2API_IMPORT_QUEUE_DIR: "/portable/sub2api/outbox",
      SESSION_INGRESS_STATE_DIR: "/portable/state"
    });
    assert.equal(configuration.adminOpenIds.size, 2);
    assert.deepEqual(resolveQueueOptions(configuration, {}), {
      env: {
        MANAGER_IMPORT_QUEUE_DIR: "/portable/manager/inbox",
        SUB2API_IMPORT_QUEUE_DIR: "/portable/sub2api/outbox",
        SESSION_INGRESS_STATE_DIR: "/portable/state"
      }
    });
  });

  it("fails closed for a missing allowlist or a relative queue directory", () => {
    assert.throws(
      () => loadConfiguration({ FEISHU_APP_ID: "x", FEISHU_APP_SECRET: "x", FEISHU_VERIFICATION_TOKEN: "x" }),
      /FEISHU_ADMIN_OPEN_IDS/u
    );
    assert.throws(
      () =>
        loadConfiguration({
          FEISHU_APP_ID: "x",
          FEISHU_APP_SECRET: "x",
          FEISHU_VERIFICATION_TOKEN: "x",
          FEISHU_ADMIN_OPEN_IDS: "admin",
          MANAGER_IMPORT_QUEUE_DIR: "relative"
        }),
      /绝对/u
    );
  });
});
