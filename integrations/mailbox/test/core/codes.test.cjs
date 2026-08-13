"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { extractVerificationCodes } = require("../../src/core/codes.cjs");

test("prefers six-digit codes near verification language and deduplicates them", () => {
  assert.deepEqual(
    extractVerificationCodes("Your verification code is 123456. The message id is 987654."),
    ["123456"]
  );
  assert.deepEqual(extractVerificationCodes("登录验证码：654321", "登录验证码：654321"), ["654321"]);
  assert.deepEqual(extractVerificationCodes("No keyword here: 112233"), ["112233"]);
});
