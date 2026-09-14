"use strict";

const crypto = require("node:crypto");
const { extractVerificationCodes } = require("./codes.cjs");
const { redactText } = require("./errors.cjs");

const MAX_BODY_LENGTH = 8_000;
const MAX_PREVIEW_LENGTH = 320;
const OPENAI_DEACTIVATED_PATTERNS = [
  /\baccount\s+(?:deactivated|(?:has\s+been|was|is)(?:\s+\w+)?\s+deactivated)\b/iu,
  /访问权限\s*(?:已|被)?\s*停用/iu,
  /(?:账户|帐户|账号)\s*(?:已|被)?\s*停用/iu
];
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const OPENAI_DISPLAY_NAME_PATTERN = /^(?:openai|chatgpt)(?:\s+(?:team|团队))?$/iu;

function normalizeMessages(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.filter((item) => item && typeof item === "object").map(normalizeMessage);
}

function normalizeMessage(message) {
  const subject = redactText(readText(message.subject ?? message.title) || "Untitled message");
  const body = readBody(message);
  const sender = readSender(message);
  const receivedAt = normalizeDate(
    message.receivedDateTime ?? message.receivedAt ?? message.createdDateTime ?? message.date
  );
  const codes = extractVerificationCodes(subject, body, message.bodyPreview);
  const rawId = readText(message.id ?? message.internetMessageId ?? message.messageId);
  const fingerprint = digest([rawId, subject, receivedAt ?? "", codes.join(","), body].join("\u0000"));

  return {
    id: fingerprint,
    fingerprint,
    subject,
    from: sender.address || sender.name || undefined,
    senderName: sender.name || undefined,
    receivedAt,
    preview: body.slice(0, MAX_PREVIEW_LENGTH),
    body: body.slice(0, MAX_BODY_LENGTH),
    codes
  };
}

function readBody(message) {
  const candidates = [message.body, message.bodyContent, message.bodyHtml, message.bodyText, message.bodyPreview];
  for (const candidate of candidates) {
    const text = readText(candidate?.content ?? candidate?.text ?? candidate);
    if (text) {
      return text;
    }
  }
  return "";
}

function readSender(message) {
  const sender = message.from ?? message.sender ?? message.author;
  const fallbackAddress = readText(
    message.fromEmail ?? message.fromAddress ?? message.senderEmail ?? message.senderAddress ?? message.authorEmail
  );
  if (sender && typeof sender === "object") {
    return {
      address: readText(sender.emailAddress?.address ?? sender.address ?? sender.email) || fallbackAddress,
      name: readText(sender.emailAddress?.name ?? sender.name) || readText(message.senderName)
    };
  }
  const text = readText(sender);
  const embeddedEmail = text.match(EMAIL_PATTERN)?.[0];
  return {
    address: embeddedEmail || fallbackAddress,
    name: text && !embeddedEmail ? text : readText(message.senderName)
  };
}

function readText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

function normalizeDate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isOpenAiAccountDeactivatedMessage(message) {
  if (!isOpenAiMessage(message)) return false;
  const text = [message.subject, message.preview, message.body]
    .filter((value) => typeof value === "string")
    .join("\n");
  return OPENAI_DEACTIVATED_PATTERNS.some((pattern) => pattern.test(text));
}

function isOpenAiMessage(message) {
  if (!message || typeof message !== "object") return false;
  const senderValues = [message.from, message.senderName, message.fromName, message.sender].filter(
    (value) => typeof value === "string"
  );
  const email = senderValues.map((value) => value.match(EMAIL_PATTERN)?.[0]).find(Boolean)?.toLowerCase();
  if (email) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    return domain === "openai.com" || domain.endsWith(".openai.com");
  }
  return senderValues.some((value) => OPENAI_DISPLAY_NAME_PATTERN.test(value.trim()));
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = { isOpenAiAccountDeactivatedMessage, isOpenAiMessage, normalizeMessage, normalizeMessages };
