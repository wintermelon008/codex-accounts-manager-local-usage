"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MailboxIntegration } = require("../../src/ui/integration.cjs");

test("Manager Dashboard integration exports only marked mailbox addresses", () => {
  const integration = {
    pool: {
      isLoaded: () => true,
      listMetadata: () => [
        { address: "marked@example.invalid", openaiAccountDeactivated: true },
        { address: "ordinary@example.invalid", openaiAccountDeactivated: false }
      ]
    }
  };

  assert.deepEqual(
    MailboxIntegration.prototype.getDeactivatedMailboxEmails.call(integration),
    ["marked@example.invalid"]
  );
});

test("Manager Dashboard integration exports no mailbox address before the pool is loaded", () => {
  const integration = {
    pool: {
      isLoaded: () => false,
      listMetadata: () => {
        throw new Error("unloaded mailbox pool must not be read");
      }
    }
  };

  assert.deepEqual(MailboxIntegration.prototype.getDeactivatedMailboxEmails.call(integration), []);
});
