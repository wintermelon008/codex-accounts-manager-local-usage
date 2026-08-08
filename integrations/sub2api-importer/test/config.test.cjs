"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { loadConfiguration, normalizeAdminBaseUrl } = require("../src/config.cjs");

test("requires explicit private Sub2API administrative settings", () => {
  assert.throws(() => loadConfiguration({}), /SUB2API_ADMIN_BASE_URL/u);
  const config = loadConfiguration({
    SUB2API_ADMIN_BASE_URL: "https://gateway.example.invalid/",
    SUB2API_ADMIN_API_KEY: "private-admin-api-key",
    SUB2API_IMPORT_QUEUE_DIR: "/private/outbox",
    SUB2API_IMPORT_POLL_SECONDS: "10"
  });
  assert.equal(config.adminBaseUrl, "https://gateway.example.invalid");
  assert.equal(config.queueDirectory, "/private/outbox");
  assert.equal(config.pollSeconds, 10);
  assert.equal(config.adminApiKey, "private-admin-api-key");
  assert.equal(config.importProxyName, "default");
  assert.equal(config.importGroupName, "test");
  assert.equal(config.importConcurrency, 2);
});

test("accepts explicit post-import defaults", () => {
  const config = loadConfiguration({
    SUB2API_ADMIN_BASE_URL: "https://gateway.example.invalid",
    SUB2API_ADMIN_API_KEY: "private-admin-api-key",
    SUB2API_IMPORT_PROXY_NAME: "default",
    SUB2API_IMPORT_GROUP_NAME: "test",
    SUB2API_IMPORT_CONCURRENCY: "2"
  });
  assert.equal(config.importProxyName, "default");
  assert.equal(config.importGroupName, "test");
  assert.equal(config.importConcurrency, 2);
});

test("rejects ambiguous administrative endpoint URLs", () => {
  assert.throws(() => normalizeAdminBaseUrl("https://gateway.example.invalid/v1"), /service root/u);
  assert.throws(() => normalizeAdminBaseUrl("https://user:pass@gateway.example.invalid"), /service root/u);
  assert.throws(() => loadConfiguration({ SUB2API_ADMIN_BASE_URL: "https://gateway.example.invalid", SUB2API_ADMIN_API_KEY: "x", SUB2API_IMPORT_QUEUE_DIR: "relative" }), /absolute/u);
  assert.throws(() => loadConfiguration({ SUB2API_ADMIN_BASE_URL: "https://gateway.example.invalid", SUB2API_ADMIN_API_KEY: "x", SUB2API_IMPORT_CONCURRENCY: "0" }), /1 to 100/u);
  assert.throws(() => loadConfiguration({ SUB2API_ADMIN_BASE_URL: "https://gateway.example.invalid", SUB2API_ADMIN_API_KEY: "x", SUB2API_IMPORT_PROXY_NAME: " " }), /non-empty/u);
});
