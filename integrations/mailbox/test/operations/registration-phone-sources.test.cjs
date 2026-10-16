"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { listRegistrationPhoneSources } = require("../../src/operations/registration-phone-sources.cjs");

test("registration phone sources place Miaoic second", () => {
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.id), ["fivesim", "miaoic", "future", "sms688"]);
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.credentialType), ["api-token", "cdk", "cdk", "api-key"]);
  assert.equal(listRegistrationPhoneSources()[1].displayName, "Miaoic");
  assert.equal(listRegistrationPhoneSources()[1].websiteUrl, "http://miaoic.shop/?tab=recv&page=1&size=20");
  assert.equal(listRegistrationPhoneSources()[1].purchaseUrl, "https://www.16688.com.cn/shop/S301395");
});
