"use strict";

const crypto = require("node:crypto");
const { extractVerificationCodes } = require("./codes.cjs");
const { redactText } = require("./errors.cjs");

const MAX_BODY_LENGTH = 8_000;
const MAX_BODY_HTML_LENGTH = 24_000;
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
  const codes = extractVerificationCodes(subject, body.text, message.bodyPreview);
  const rawId = readText(message.id ?? message.internetMessageId ?? message.messageId);
  const fingerprint = digest([rawId, subject, receivedAt ?? "", codes.join(","), body.text].join("\u0000"));

  return {
    id: fingerprint,
    fingerprint,
    subject,
    from: sender.address || sender.name || undefined,
    senderName: sender.name || undefined,
    receivedAt,
    preview: body.text.slice(0, MAX_PREVIEW_LENGTH),
    body: body.text.slice(0, MAX_BODY_LENGTH),
    ...(body.html
      ? { bodyHtml: compactEmailHtml(body.html).slice(0, MAX_BODY_HTML_LENGTH) }
      : {}),
    codes
  };
}

function readBody(message) {
  const candidates = [
    message.bodyHtml === undefined ? undefined : { content: message.bodyHtml, contentType: "text/html" },
    message.body,
    message.bodyContent,
    message.bodyText,
    message.bodyPreview
  ];
  for (const candidate of candidates) {
    const parsed = readBodyCandidate(candidate);
    if (parsed.text || parsed.html) {
      return parsed;
    }
  }
  return { text: "", html: "" };
}

function readBodyCandidate(candidate) {
  if (candidate === undefined || candidate === null) {
    return { text: "", html: "" };
  }
  const isObject = typeof candidate === "object";
  const value = isObject ? candidate.content ?? candidate.text : candidate;
  if (typeof value !== "string" || !value.trim()) {
    return { text: "", html: "" };
  }
  if (looksLikeHtml(value)) {
    const html = value.trim();
    return { text: htmlToText(html), html };
  }
  return { text: normalizePlainText(value), html: "" };
}

function normalizePlainText(value) {
  const raw = String(value ?? "");
  const stripped = stripEmbeddedEmailCss(raw);
  const preserveLineBreaks = stripped !== raw;
  if (!preserveLineBreaks) return stripped.replace(/\s+/gu, " ").trim();
  return stripped
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function htmlToText(value) {
  const text = String(value ?? "")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<\s*(?:script|style|head|title|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style|head|title|svg|math)\s*>/giu, " ")
    .replace(/<\s*(?:br|hr|p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|td|th)\b[^>]*>/giu, "\n")
    .replace(/<\s*\/\s*(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|td|th)\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&#(\d+);/gu, (_match, codePoint) => decodeCodePoint(codePoint))
    .replace(/&#x([\da-f]+);/giu, (_match, codePoint) => decodeCodePoint(Number.parseInt(codePoint, 16)))
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'");
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function compactEmailHtml(value) {
  return String(value ?? "")
    .replace(/<!doctype[^>]*>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\s*\/\s*head\s*>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/giu, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/giu, " ")
    .replace(/<title\b[^>]*>[\s\S]*?<\s*\/\s*title\s*>/giu, " ")
    .replace(/<meta\b[^>]*>/giu, " ")
    .replace(/<link\b[^>]*>/giu, " ")
    .trim();
}

function decodeCodePoint(value) {
  const codePoint = Number(value);
  return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : " ";
}

function looksLikeHtml(value) {
  return /<\/?[a-z][^>]*>/iu.test(value);
}

function stripEmbeddedEmailCss(value) {
  let text = String(value ?? "")
    .replace(/\\(?=[/*])/gu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, " ");
  const cssStart = /(?:@(?:media|supports|font-face|keyframes)\b|:root|(?<![A-Za-z0-9_-])(?:[.#][\w-]+|(?:html|body|table|td|a|img|h[1-6]|p|div|span|section)(?:\[[^\]]+\])?)[^{}]*\{)/giu;
  let result = "";
  let cursor = 0;
  let match;
  while ((match = cssStart.exec(text))) {
    const openBrace = text.indexOf("{", match.index);
    const closeBrace = findMatchingBrace(text, openBrace);
    if (openBrace < 0) {
      continue;
    }
    if (closeBrace < 0) {
      const preserved = text.slice(cursor, match.index);
      return result + preserved + (preserved && !/\n\s*$/u.test(preserved) ? "\n" : "");
    }
    const preserved = text.slice(cursor, match.index);
    result += preserved + (preserved && !/\n\s*$/u.test(preserved) ? "\n" : "");
    cursor = closeBrace + 1;
    cssStart.lastIndex = cursor;
  }
  return result + text.slice(cursor);
}

function findMatchingBrace(value, openBrace) {
  if (openBrace < 0) return -1;
  let depth = 0;
  for (let index = openBrace; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    else if (value[index] === "}" && --depth === 0) return index;
  }
  return -1;
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

module.exports = { htmlToText, isOpenAiAccountDeactivatedMessage, isOpenAiMessage, normalizeMessage, normalizeMessages };
