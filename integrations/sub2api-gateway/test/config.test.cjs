"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  SUB2API_GATEWAY_CONFIG_SCHEMA,
  createSub2ApiGatewayConfigTemplate,
  ensureSub2ApiGatewayConfigFile,
  parseSub2ApiGatewayConfig,
  parseSub2ApiGatewayConfigWithDiagnostics,
  readSub2ApiGatewayConfig,
  resolveSub2ApiGatewayConfigPath
} = require("../src/config.cjs");

test("Gateway configuration stays inside the extension storage and never contains a plaintext key", async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-config-"));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const configPath = resolveSub2ApiGatewayConfigPath(storage, "nested/gateway.json");
  assert.equal(configPath, path.join(storage, "nested", "gateway.json"));
  assert.throws(() => resolveSub2ApiGatewayConfigPath(storage, "../outside.json"), /inside/u);
  assert.throws(() => resolveSub2ApiGatewayConfigPath(storage, path.resolve(storage, "..", "outside.json")), /relative/u);

  const defaultPath = resolveSub2ApiGatewayConfigPath(storage);
  assert.equal(await ensureSub2ApiGatewayConfigFile(defaultPath), true);
  assert.equal(await ensureSub2ApiGatewayConfigFile(defaultPath), false);
  const text = await fs.readFile(defaultPath, "utf8");
  assert.match(text, new RegExp(SUB2API_GATEWAY_CONFIG_SCHEMA, "u"));
  assert.doesNotMatch(text, /api[_-]?key|secret|token/u);
  await expectConfig(defaultPath);
});

test("Gateway configuration rejects ambiguous endpoint and credential settings", () => {
  const template = createSub2ApiGatewayConfigTemplate();
  assert.equal(
    parseSub2ApiGatewayConfig({ ...template, sub2api: { ...template.sub2api, baseUrl: "https://gateway.example.invalid/v1/" } })
      .sub2api.baseUrl,
    "https://gateway.example.invalid/v1"
  );
  assert.throws(
    () => parseSub2ApiGatewayConfig({ ...template, sub2api: { ...template.sub2api, baseUrl: "https://gateway.example.invalid/not-v1" } }),
    /end in \/v1/u
  );
  assert.throws(
    () => parseSub2ApiGatewayConfig({ ...template, inventoryObserver: { ...template.inventoryObserver, credentialRef: "primary" } }),
    /different/u
  );
  assert.throws(
    () => parseSub2ApiGatewayConfig({ ...template, sub2api: { ...template.sub2api, credentialRef: "contains space" } }),
    /invalid/u
  );
});

test("a malformed optional observer does not discard valid downstream Gateway settings", () => {
  const template = createSub2ApiGatewayConfigTemplate();
  const result = parseSub2ApiGatewayConfigWithDiagnostics({
    ...template,
    inventoryObserver: {
      ...template.inventoryObserver,
      adminBaseUrl: "https://gateway.example.invalid/v1"
    }
  });

  assert.equal(result.config.sub2api.baseUrl, "https://gateway.example.invalid/v1");
  assert.equal(result.config.inventoryObserver, undefined);
  assert.match(result.inventoryObserverError, /Observer admin base URL must not include a path/u);
});

test("parses multiple Gateway profiles and keeps the legacy single profile shape", () => {
  const first = createSub2ApiGatewayConfigTemplate();
  const result = parseSub2ApiGatewayConfigWithDiagnostics({
    schema: SUB2API_GATEWAY_CONFIG_SCHEMA,
    profiles: [
      {
        id: "local",
        displayName: "Local",
        sub2api: first.sub2api,
        autoFallbackToChatGpt: false
      },
      {
        id: "external",
        displayName: "External",
        sub2api: {
          baseUrl: "https://external.example.invalid/v1",
          model: "gpt-5.5",
          credentialRef: "external"
        },
        autoFallbackToChatGpt: false
      }
    ]
  });

  assert.deepEqual(result.profiles.map((profile) => profile.id), ["local", "external"]);
  assert.equal(result.profiles[1].sub2api.baseUrl, "https://external.example.invalid/v1");
  assert.equal(Object.hasOwn(parseSub2ApiGatewayConfig(first), "id"), false);
});

async function expectConfig(configPath) {
  const config = await readSub2ApiGatewayConfig(configPath);
  assert.equal(config.schema, SUB2API_GATEWAY_CONFIG_SCHEMA);
  assert.equal(config.sub2api.credentialRef, "primary");
  assert.equal(config.inventoryObserver.credentialRef, "observer");
}
