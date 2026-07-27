import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  handlePrivateImportEvent,
  PRIVATE_CHAT_ONLY_MESSAGE,
  UNAUTHORIZED_MESSAGE
} from "../src/handler.mjs";

let temporaryDirectory;
const adminOpenIds = new Set(["admin-open-id"]);
const idToken = jwt({ email: "person@example.invalid", chatgpt_account_id: "account-1" });
const accessToken = jwt({ email: "person@example.invalid" });

afterEach(async () => {
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("private import handler", () => {
  it("rejects group messages before parsing M+/S+ credential text", async () => {
    const result = await handlePrivateImportEvent(event("group", "admin-open-id", `m+ ${malformedCredentialText()}`), {
      adminOpenIds,
      queueOptions: { env: { SESSION_INGRESS_STATE_DIR: "/portable/state" } }
    });
    assert.deepEqual(result, { handled: true, reply: PRIVATE_CHAT_ONLY_MESSAGE });
  });

  it("rejects an unapproved sender before parsing credential text", async () => {
    const result = await handlePrivateImportEvent(event("p2p", "not-admin", `s+ ${malformedCredentialText()}`), {
      adminOpenIds,
      queueOptions: { env: { SESSION_INGRESS_STATE_DIR: "/portable/state" } }
    });
    assert.deepEqual(result, { handled: true, reply: UNAUTHORIZED_MESSAGE });
  });

  it("queues M+ as Manager Shared JSON and replies with redacted status", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-private-import-test-"));
    const queueDirectory = path.join(temporaryDirectory, "manager", "inbox");
    const result = await handlePrivateImportEvent(
      event("p2p", "admin-open-id", `m+ {"id_token":"${idToken}","access_token":"${accessToken}"}`),
      { adminOpenIds, queueOptions: { env: { MANAGER_IMPORT_QUEUE_DIR: queueDirectory } } }
    );
    assert.equal(result.handled, true);
    assert.match(result.reply, /任务编号/u);
    assert.doesNotMatch(result.reply, /person@example\.invalid|test-signature/u);
    const jobs = await fs.readdir(queueDirectory);
    assert.equal(jobs.filter((name) => name.endsWith(".json")).length, 1);
  });

  it("queues S+ as a standard Sub2API payload without calling an admin API", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-private-import-test-"));
    const outbox = path.join(temporaryDirectory, "sub2api", "outbox");
    const result = await handlePrivateImportEvent(
      event("p2p", "admin-open-id", `s+ id_token="${idToken}", access_token="${accessToken}"`),
      { adminOpenIds, queueOptions: { env: { SUB2API_IMPORT_QUEUE_DIR: outbox } } }
    );
    assert.equal(result.handled, true);
    assert.match(result.reply, /sub2api-data/u);
    const [jobName] = await fs.readdir(outbox);
    const job = JSON.parse(await fs.readFile(path.join(outbox, jobName), "utf8"));
    assert.equal(job.payload.type, "sub2api-data");
    assert.equal(job.payload.accounts.length, 1);
  });
});

function event(chatType, openId, text) {
  return {
    message: { chat_type: chatType, chat_id: "chat-id", content: JSON.stringify({ text }) },
    sender: { sender_id: { open_id: openId } }
  };
}

function malformedCredentialText() {
  return '{"access_token":"not inspected"';
}

function jwt(payload) {
  return `${base64({ alg: "HS256" })}.${base64(payload)}.test-signature`;
}

function base64(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
