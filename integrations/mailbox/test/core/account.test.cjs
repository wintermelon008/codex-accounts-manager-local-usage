"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeMailboxAccount, normalizeMailboxAddress } = require("../../src/core/account.cjs");

test("normalizes a provider-neutral mailbox account without interpreting credentials", () => {
  const account = normalizeMailboxAccount({
    address: "person@example.com",
    credentials: { password: "password", clientId: "client-id", refreshToken: "refresh-token" }
  });
  assert.deepEqual(account, {
    address: "person@example.com",
    credentials: { password: "password", clientId: "client-id", refreshToken: "refresh-token" }
  });
});

test("keeps address validation local and does not redact the display address", () => {
  assert.throws(() => normalizeMailboxAddress("not-an-email"), /address is invalid/u);
  assert.equal(normalizeMailboxAddress("person@example.com"), "person@example.com");
});
