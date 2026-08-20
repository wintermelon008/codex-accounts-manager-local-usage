"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createRegistrationDiagnostics,
  redactDiagnosticMessage,
  redactDiagnosticUrl
} = require("../../src/operations/registration-diagnostics.cjs");

test("registration diagnostics redact account, phone, code, and card secrets", () => {
  const message = redactDiagnosticMessage("填写邮箱=user@example.com 手机=+8613800000000 验证码=123456 卡密=CARD-SECRET-1234");
  assert.doesNotMatch(message, /user@example\.com|13800000000|123456|CARD-SECRET-1234/u);
  assert.match(message, /\[EMAIL\]/u);
  assert.match(message, /\[PHONE_OR_CODE\]/u);
  assert.match(message, /\[CODE\]/u);
  assert.match(message, /\[REDACTED\]/u);
});

test("registration diagnostics preserve useful URL paths while redacting URL secrets", () => {
  const url = redactDiagnosticUrl("https://auth.openai.com/create-account?state=state-secret&email=user@example.com&__cf_chl_rt_tk=cloudflare-secret#token-secret");
  assert.match(url, /^https:\/\/auth\.openai\.com\/create-account\?/u);
  assert.doesNotMatch(url, /state-secret|user@example\.com|cloudflare-secret|token-secret/u);
  assert.match(url, /state=%5BREDACTED%5D/u);
  assert.match(url, /email=%5BREDACTED%5D/u);
  assert.match(url, /__cf_chl_rt_tk=%5BREDACTED%5D/u);
  assert.match(url, /#\[REDACTED\]/u);
});

test("registration diagnostics write a sanitized record to the extension global storage", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mailbox-registration-diagnostics-"));
  const lines = [];
  const output = {
    appendLine(line) { lines.push(line); },
    show() {},
    dispose() {}
  };
  const diagnostics = createRegistrationDiagnostics(
    { window: { createOutputChannel: () => output } },
    { globalStorageUri: { fsPath: directory } }
  );

  diagnostics.record({
    level: "error",
    sessionId: "session-1",
    msg: "请求失败 user@example.com code=123456",
    url: "https://liye.5x20.cn/api/orders/order-secret/status?token=secret"
  });
  await diagnostics.flush();

  const contents = await fs.promises.readFile(diagnostics.logFilePath, "utf8");
  assert.equal(lines.length, 1);
  assert.equal(contents.trim(), lines[0]);
  assert.doesNotMatch(contents, /user@example\.com|123456|order-secret|token=secret/u);
  assert.match(contents, /https:\/\/liye\.5x20\.cn\/api\/orders\/\[order-id\]\/status/u);

  diagnostics.dispose();
  await fs.promises.rm(directory, { recursive: true, force: true });
});
