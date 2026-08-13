"use strict";

const TARGETED_CODE_PATTERN = /(?:verification|one[\s-]?time|passcode|security|otp|code|验证码|校验码)[^0-9]{0,80}(\d{6})/giu;
const FALLBACK_CODE_PATTERN = /\b\d{6}\b/gu;

function extractVerificationCodes(...values) {
  const text = values
    .flat(Infinity)
    .filter((value) => typeof value === "string")
    .join("\n");
  if (!text) {
    return [];
  }

  const targeted = collectCodes(text, TARGETED_CODE_PATTERN);
  return targeted.length > 0 ? targeted : collectCodes(text, FALLBACK_CODE_PATTERN);
}

function collectCodes(text, pattern) {
  const codes = [];
  for (const match of text.matchAll(pattern)) {
    const code = match[1] ?? match[0];
    if (!codes.includes(code)) {
      codes.push(code);
    }
  }
  return codes;
}

module.exports = { extractVerificationCodes };
