"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { listRegistrationPhoneSources } = require("../../src/operations/registration-phone-sources.cjs");

test("registration phone sources place Future immediately after 5SIM", () => {
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.id), ["fivesim", "future", "sms688", "liye"]);
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.credentialType), ["api-token", "cdk", "api-key", "key"]);
  assert.equal(listRegistrationPhoneSources()[1].displayName, "Future");
  assert.equal(listRegistrationPhoneSources()[1].purchaseUrl, "https://www.16688.com.cn/shop/AIAISHARE");
});
