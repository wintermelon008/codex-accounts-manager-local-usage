"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REDACTED = "[REDACTED]";

function redactDiagnosticMessage(value) {
  return String(value ?? "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[EMAIL]")
    .replace(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,}\b/gu, REDACTED)
    .replace(/\+?\d(?:[\s().-]*\d){6,}/gu, "[PHONE_OR_CODE]")
    .replace(/\b\d{4,8}\b/gu, "[CODE]")
    .replace(/\b(?:token|secret|password|card(?:code|_code)?|key)\b\s*[=:]\s*[^\s,}]+/giu, (match) => {
      const separator = match.match(/\s*[=:]\s*/u)?.[0] || "=";
      const name = match.slice(0, match.indexOf(separator)).trim();
      return `${name}${separator}${REDACTED}`;
    })
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}

function redactDiagnosticUrl(value) {
  const input = String(value ?? "").trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    // Query values are not needed to identify the page and may contain
    // provider-specific challenge/session tokens (for example Cloudflare's
    // __cf_chl_rt_tk), so redact every value instead of maintaining a list.
    const queryKeys = [...url.searchParams.keys()];
    for (const key of queryKeys) url.searchParams.set(key, REDACTED);
    url.pathname = url.pathname.replace(/(\/api\/orders\/)[^/]+(?=\/|$)/u, "$1[order-id]");
    if (url.hash) url.hash = `#${REDACTED}`;
    return url.toString().replace(/%5Border-id%5D/giu, "[order-id]").slice(0, 800);
  } catch {
    return redactDiagnosticMessage(input).slice(0, 800);
  }
}

function normalizeDiagnosticEntry(entry = {}) {
  const timestamp = new Date().toISOString();
  const level = String(entry.level || "info").toLowerCase().slice(0, 16);
  const sessionId = String(entry.sessionId || "").trim().slice(0, 80);
  const message = redactDiagnosticMessage(entry.msg ?? entry.message);
  const url = redactDiagnosticUrl(entry.url);
  return { timestamp, level, sessionId, message, url };
}

function formatDiagnosticEntry(entry) {
  const session = entry.sessionId ? ` session=${entry.sessionId}` : "";
  const url = entry.url ? ` URL=${entry.url}` : "";
  return `${entry.timestamp} [${entry.level}]${session} ${entry.message || "(empty)"}${url}`;
}

function storagePath(context) {
  const uri = context?.globalStorageUri;
  if (typeof uri?.fsPath === "string" && uri.fsPath) return uri.fsPath;
  if (typeof context?.globalStoragePath === "string" && context.globalStoragePath) {
    return context.globalStoragePath;
  }
  return "";
}

function createRegistrationDiagnostics(vscode, context) {
  let output;
  try {
    output = typeof vscode?.window?.createOutputChannel === "function"
      ? vscode.window.createOutputChannel("Mailbox 注册诊断")
      : undefined;
  } catch {
    output = undefined;
  }

  const basePath = storagePath(context);
  const logFilePath = basePath ? path.join(basePath, "registration-diagnostics.log") : "";
  let writeQueue = Promise.resolve();

  function record(entry) {
    const normalized = normalizeDiagnosticEntry(entry);
    const line = formatDiagnosticEntry(normalized);
    try {
      output?.appendLine(line);
    } catch {
      // Diagnostics must never affect the registration flow.
    }
    if (logFilePath) {
      writeQueue = writeQueue
        .then(async () => {
          await fs.promises.mkdir(path.dirname(logFilePath), { recursive: true, mode: 0o700 });
          await fs.promises.appendFile(logFilePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
        })
        .catch(() => {
          // A read-only or unavailable global storage directory must not break registration.
        });
    }
    return normalized;
  }

  return {
    record,
    flush: () => writeQueue,
    show() {
      try {
        output?.show(true);
      } catch {
        // Output is a convenience; it is not required for the workflow.
      }
    },
    get output() {
      return output;
    },
    get logFilePath() {
      return logFilePath;
    },
    dispose() {
      try {
        output?.dispose();
      } catch {
        // Ignore disposal failures during extension shutdown.
      }
    }
  };
}

module.exports = {
  createRegistrationDiagnostics,
  formatDiagnosticEntry,
  normalizeDiagnosticEntry,
  redactDiagnosticMessage,
  redactDiagnosticUrl
};
