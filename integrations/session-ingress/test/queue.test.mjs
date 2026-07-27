import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  enqueueManagerImport,
  enqueueSub2ApiImport,
  formatManagerImportStatus,
  MANAGER_IMPORT_RESULT_SCHEMA,
  readManagerImportStatus,
  resolveManagerImportQueueDirectory,
  resolveSub2ApiImportQueueDirectory
} from "../src/index.mjs";

const idToken = jwt({ email: "queue@example.invalid" });
const accessToken = jwt({ email: "queue@example.invalid" });
let temporaryDirectory;

afterEach(async () => {
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("local ingress queues", () => {
  it("writes Manager jobs atomically and returns only redacted status counters", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "session-ingress-test-"));
    const queueDirectory = path.join(temporaryDirectory, "manager", "inbox");
    const queued = await enqueueManagerImport(JSON.stringify({ id_token: idToken, access_token: accessToken }), {
      queueDirectory
    });
    const raw = await fs.readFile(path.join(queueDirectory, `${queued.id}.json`), "utf8");
    assert.match(raw, /codex-account-import\/v1/u);
    assert.equal((await fs.stat(path.join(queueDirectory, `${queued.id}.json`))).mode & 0o777, 0o600);

    const resultsDirectory = path.join(path.dirname(queueDirectory), "results");
    await fs.mkdir(resultsDirectory, { recursive: true });
    await fs.writeFile(
      path.join(resultsDirectory, `${queued.id}.json`),
      JSON.stringify({
        schema: MANAGER_IMPORT_RESULT_SCHEMA,
        id: queued.id,
        status: "completed",
        total: 1,
        imported: 1,
        pool_enabled: 1,
        refresh_failed: 0,
        not_eligible: 0
      })
    );
    const status = await readManagerImportStatus(queued.id, { queueDirectory });
    assert.deepEqual(status, {
      id: queued.id,
      state: "completed",
      total: 1,
      imported: 1,
      poolEnabled: 1,
      refreshFailed: 0,
      notEligible: 0
    });
    assert.doesNotMatch(formatManagerImportStatus(status), /queue@example\.invalid|test-signature/u);
  });

  it("writes S+ canonical payloads to a separate explicit outbox", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "session-ingress-test-"));
    const queueDirectory = path.join(temporaryDirectory, "sub2api", "outbox");
    const queued = await enqueueSub2ApiImport(JSON.stringify({ id_token: idToken, access_token: accessToken }), {
      queueDirectory,
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    const job = JSON.parse(await fs.readFile(path.join(queueDirectory, `${queued.id}.json`), "utf8"));
    assert.equal(job.schema, "sub2api-import/v1");
    assert.equal(job.payload.type, "sub2api-data");
    assert.equal(job.payload.accounts.length, 1);
  });

  it("uses portable state discovery and rejects relative target directories", () => {
    assert.equal(
      resolveManagerImportQueueDirectory({ XDG_STATE_HOME: "/portable/state" }),
      path.join("/portable/state", "codex-account-import", "inbox")
    );
    assert.equal(
      resolveSub2ApiImportQueueDirectory({ SESSION_INGRESS_STATE_DIR: "/portable/state" }),
      path.join("/portable/state", "sub2api-import", "outbox")
    );
    assert.throws(() => resolveManagerImportQueueDirectory({ MANAGER_IMPORT_QUEUE_DIR: "relative" }), /绝对/u);
  });
});

function jwt(payload) {
  return `${base64({ alg: "HS256" })}.${base64(payload)}.test-signature`;
}

function base64(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
