"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { listRegistrationPhoneSources } = require("../../src/operations/registration-phone-sources.cjs");

test("registration phone sources use the 5SIM, SMS688, LIYE default order", () => {
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.id), ["fivesim", "sms688", "liye"]);
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.credentialType), ["api-token", "api-key", "key"]);
});
