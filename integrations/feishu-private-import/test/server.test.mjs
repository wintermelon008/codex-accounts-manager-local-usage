import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { handleFeishuCallback } from "../src/server.mjs";

let temporaryDirectory;
const idToken = jwt({ email: "callback@example.invalid" });
const accessToken = jwt({ email: "callback@example.invalid" });

afterEach(async () => {
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("Feishu event callback boundary", () => {
  it("answers URL verification only when its verification token matches", async () => {
    const options = baseOptions();
    const accepted = await handleFeishuCallback({ type: "url_verification", token: "verify", challenge: "challenge" }, options);
    assert.deepEqual(accepted, { statusCode: 200, body: { challenge: "challenge" } });
    const rejected = await handleFeishuCallback({ type: "url_verification", token: "wrong", challenge: "challenge" }, options);
    assert.equal(rejected.statusCode, 401);
  });

  it("does not hand a group credential payload to the normalizer", async () => {
    const sent = [];
    const result = await handleFeishuCallback(
      payload("group", "admin-open-id", 'm+ {"access_token":"not inspected"'),
      baseOptions({ client: { sendText: async (...args) => sent.push(args) } })
    );
    assert.equal(result.statusCode, 200);
    assert.deepEqual(sent, [["chat-id", expectPrivateOnlyMessage()]]);
  });

  it("ignores document-comment and other non-message events before inspecting their content", async () => {
    const sent = [];
    const result = await handleFeishuCallback(
      {
        header: { token: "verify", event_type: "docx.comment.create_v1" },
        event: { content: 'm+ {"access_token":"not inspected"' }
      },
      baseOptions({ client: { sendText: async (...args) => sent.push(args) } })
    );
    assert.equal(result.statusCode, 200);
    assert.deepEqual(sent, []);
  });

  it("sends a redacted completion reply for an authorized private M+ event", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-private-import-test-"));
    const sent = [];
    const result = await handleFeishuCallback(
      payload("p2p", "admin-open-id", `m+ {"id_token":"${idToken}","access_token":"${accessToken}"}`),
      baseOptions({
        client: { sendText: async (...args) => sent.push(args) },
        queueOptions: { env: { MANAGER_IMPORT_QUEUE_DIR: path.join(temporaryDirectory, "inbox") } }
      })
    );
    assert.equal(result.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0][1], /任务编号/u);
    assert.doesNotMatch(sent[0][1], /callback@example\.invalid|test-signature/u);
  });
});

function baseOptions(overrides = {}) {
  return {
    verificationToken: "verify",
    adminOpenIds: new Set(["admin-open-id"]),
    queueOptions: { env: { SESSION_INGRESS_STATE_DIR: "/portable/state" } },
    client: { sendText: async () => undefined },
    ...overrides
  };
}

function payload(chatType, openId, text) {
  return {
    header: { token: "verify", event_type: "im.message.receive_v1" },
    event: {
      message: { chat_type: chatType, chat_id: "chat-id", content: JSON.stringify({ text }) },
      sender: { sender_type: "user", sender_id: { open_id: openId } }
    }
  };
}

function expectPrivateOnlyMessage() {
  return "账号导入仅支持与机器人的一对一私聊；不会在群聊、文档评论或其他会话中读取 m+ / s+ 内容。";
}

function jwt(payload) {
  return `${base64({ alg: "HS256" })}.${base64(payload)}.test-signature`;
}

function base64(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
