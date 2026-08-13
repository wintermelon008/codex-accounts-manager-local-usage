"use strict";

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

function toSafeError(error, fallbackStage = "network") {
  if (error?.name === "AbortError") {
    return {
      stage: "cancelled",
      code: "request_aborted",
      message: "Request cancelled",
      retryable: false
    };
  }

  if (Number.isInteger(error?.status)) {
    return {
      stage: "http",
      code: `http_${error.status}`,
      message: `Mailbox provider returned HTTP ${error.status}`,
      retryable: error.status >= 500 || error.status === 429
    };
  }

  return {
    stage: normalizeIdentifier(fallbackStage, "network"),
    code: "request_failed",
    message: "Mailbox provider request failed",
    retryable: true
  };
}

function toRemoteError(errors, fallbackStage = "provider") {
  const first = Array.isArray(errors) ? errors.find((entry) => entry && typeof entry === "object") : undefined;
  const stage = normalizeIdentifier(first?.stage, fallbackStage);
  const code = normalizeIdentifier(first?.code ?? first?.type, "provider_error");
  const rawMessage = typeof first?.message === "string" ? first.message : "Mailbox provider reported an account error";

  return {
    stage,
    code,
    message: redactText(rawMessage),
    retryable: stage === "token" || stage === "network" || code === "rate_limited"
  };
}

function redactText(value) {
  let text = String(value)
    .replace(/[^\s,;"']+----[^\s,;"']+----[^\s,;"']+----[^\s,;"']+/gu, "[redacted-account]")
    .replace(/\b(?:refresh[_-]?token|access[_-]?token|password|client[_-]?id)\b\s*[:=]\s*["']?[^\s,;"']+/giu, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, "[redacted]")
    .replace(/[\r\n\t]+/gu, " ")
    .trim();

  if (text.length > 160) {
    text = `${text.slice(0, 157)}...`;
  }
  return text || "Mailbox provider request failed";
}

function normalizeIdentifier(value, fallback) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return SAFE_IDENTIFIER_PATTERN.test(candidate) ? candidate : fallback;
}

module.exports = { redactText, toRemoteError, toSafeError };
