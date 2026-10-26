"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { listRegistrationPhoneSources } = require("../../src/operations/registration-phone-sources.cjs");

test("registration phone sources place Miaoic second", () => {
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.id), ["fivesim", "miaoic", "future", "sms688"]);
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.credentialType), ["api-token", "account-token-cdk", "cdk-session", "account-api-key"]);
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.credentialFlow.kind), [
    "direct-api-token",
    "account-token-with-purchase-cdk",
    "purchase-cdk-to-session-token",
    "account-api-key"
  ]);
  assert.deepEqual(listRegistrationPhoneSources().map((source) => source.credentialFlow.inputLabel), [
    "5SIM API Token",
    "购买次数 CDK",
    "购买次数 CDK",
    "账户 API Key"
  ]);
  assert.equal(listRegistrationPhoneSources()[1].credentialFlow.accountTokenInputLabel, "已有账户 Token");
  assert.equal(listRegistrationPhoneSources()[1].credentialFlow.storedLabel, "账户 Token（隐藏）");
  assert.equal(listRegistrationPhoneSources()[2].credentialFlow.storedLabel, "Session Token");
  assert.equal(listRegistrationPhoneSources()[3].credentialFlow.summary.includes("不要把购买次数 CDK"), true);
  assert.equal(listRegistrationPhoneSources()[1].displayName, "Miaoic");
  assert.equal(listRegistrationPhoneSources()[1].websiteUrl, "http://miaoic.shop/?tab=recv&page=1&size=20");
  assert.equal(listRegistrationPhoneSources()[1].purchaseUrl, "https://www.16688.com.cn/shop/S301395");
});
