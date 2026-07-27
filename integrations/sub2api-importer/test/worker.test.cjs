"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { processOutbox } = require("../src/worker.cjs");

const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

test("consumes a valid private S+ queue job and leaves only a redacted result", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sub2api-outbox-"));
  const outbox = path.join(root, "outbox");
  await fs.mkdir(outbox, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(outbox, `${jobId}.json`), JSON.stringify(job()), { mode: 0o600 });
  let submitted;
  const summary = await processOutbox(
    { queueDirectory: outbox, adminBaseUrl: "https://gateway.example.invalid", adminToken: "private-token" },
    {
      submit: async (_configuration, payload) => {
        submitted = payload;
        return { accountCreated: 1, accountFailed: 0, accountConfigured: 1, proxyCreated: 0, proxyReused: 0, proxyFailed: 0 };
      }
    }
  );
  assert.deepEqual(summary, { completed: 1, failed: 0, idle: false });
  assert.equal(submitted.accounts.length, 1);
  await assert.rejects(fs.access(path.join(outbox, `${jobId}.json`)));
  const result = JSON.parse(await fs.readFile(path.join(path.dirname(outbox), "results", `${jobId}.json`), "utf8"));
  assert.equal(result.status, "completed");
  assert.equal(result.account_configured, 1);
  assert.doesNotMatch(JSON.stringify(result), /access-token|private-token/u);
});

test("marks a failed job without saving credentials in its result", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sub2api-outbox-"));
  const outbox = path.join(root, "outbox");
  await fs.mkdir(outbox, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(outbox, `${jobId}.json`), JSON.stringify(job()), { mode: 0o600 });
  const summary = await processOutbox(
    { queueDirectory: outbox },
    { submit: async () => { const error = new Error("secret remote error"); error.kind = "remoteRejected"; error.statusCode = 403; throw error; } }
  );
  assert.deepEqual(summary, { completed: 0, failed: 1, idle: false });
  await fs.access(path.join(outbox, `${jobId}.failed`));
  const result = JSON.parse(await fs.readFile(path.join(path.dirname(outbox), "results", `${jobId}.json`), "utf8"));
  assert.deepEqual(result, {
    schema: "sub2api-import-result/v1",
    id: jobId,
    status: "failed",
    completed_at: result.completed_at,
    payload_accounts: 1,
    payload_proxies: 0,
    failure_kind: "remoteRejected",
    status_code: 403
  });
  assert.doesNotMatch(JSON.stringify(result), /secret remote error|access-token/u);
});

function job() {
  return {
    schema: "sub2api-import/v1",
    id: jobId,
    created_at: "2026-01-01T00:00:00.000Z",
    payload: {
      type: "sub2api-data",
      version: 1,
      exported_at: "2026-01-01T00:00:00.000Z",
      proxies: [],
      accounts: [{ access_token: "access-token" }]
    }
  };
}
