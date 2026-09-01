"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isOpenAiAccountDeactivatedMessage, normalizeMessage } = require("../../src/core/messages.cjs");

test("detects account deactivation notices sent from an OpenAI domain", () => {
  const message = normalizeMessage({
    id: "deactivated",
    subject: "Your account has been deactivated",
    from: { emailAddress: { address: ["no-reply", "openai.com"].join("@") } },
    body: "Your access is no longer available."
  });

  assert.equal(isOpenAiAccountDeactivatedMessage(message), true);
});

test("does not treat unrelated senders or ordinary OpenAI messages as deactivation notices", () => {
  const unrelatedSender = normalizeMessage({
    id: "unrelated-sender",
    subject: "Your account has been deactivated",
    from: "alerts@example.com"
  });
  const ordinaryOpenAiMessage = normalizeMessage({
    id: "verification",
    subject: "OpenAI verification code",
    from: ["no-reply", "openai.com"].join("@"),
    body: "Use this code to continue."
  });

  assert.equal(isOpenAiAccountDeactivatedMessage(unrelatedSender), false);
  assert.equal(isOpenAiAccountDeactivatedMessage(ordinaryOpenAiMessage), false);
});
