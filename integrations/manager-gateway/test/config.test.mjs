import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopbackHost, loadConfig } from "../src/config.mjs";

describe("manager gateway config", () => {
  it("uses a loopback default and accepts provider configuration", () => {
    const config = loadConfig({
      MANAGER_GATEWAY_RESEARCH_BASE_URL: "http://127.0.0.1:9000/v1",
      MANAGER_GATEWAY_RESEARCH_MODEL: "local-test",
      MANAGER_GATEWAY_MAX_SESSIONS: "3"
    });
    assert.deepEqual(config.server, {
      host: "127.0.0.1",
      port: 43118,
      token: undefined,
      corsOrigin: "*",
      stateDir: config.server.stateDir
    });
    assert.deepEqual(config.research, {
      baseUrl: "http://127.0.0.1:9000/v1",
      apiKey: undefined,
      model: "local-test"
    });
    assert.equal(config.maxSessions, 3);
    assert.equal(isLoopbackHost(config.server.host), true);
  });

  it("requires a token for a non-loopback listener", () => {
    assert.throws(() => loadConfig({ MANAGER_GATEWAY_HOST: "0.0.0.0" }), /MANAGER_GATEWAY_TOKEN is required/);
  });

  it("accepts the Manager shared control environment variable", () => {
    const config = loadConfig({ CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN: "shared-control-token" });
    assert.equal(config.manager.token, "shared-control-token");
  });

  it("rejects a relative Codex home to keep Manager and Gateway auth aligned", () => {
    assert.throws(
      () => loadConfig({ MANAGER_GATEWAY_CODEX_HOME: "./codex-home" }),
      /MANAGER_GATEWAY_CODEX_HOME must be an absolute path/
    );
  });

  it("rejects an ephemeral external port so browser configuration stays stable", () => {
    assert.throws(
      () => loadConfig({ MANAGER_GATEWAY_PORT: "0" }),
      /MANAGER_GATEWAY_PORT must be an integer from 1 to 65535/
    );
  });
});
