"use strict";

const MAILBOX_PROVIDER_API_VERSION = 1;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function createMailboxProvider({
  id,
  displayName = id,
  capabilities = {},
  importSchema = {},
  parseImport,
  query,
  renew
}) {
  if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id)) {
    throw new Error("Mailbox provider id is invalid");
  }
  if (typeof query !== "function") {
    throw new TypeError("Mailbox provider must expose a query operation");
  }
  if (typeof parseImport !== "function") {
    throw new TypeError("Mailbox provider must expose an import parser");
  }

  const normalizedCapabilities = {
    history: capabilities.history === "latest" ? "latest" : "recent",
    maxMessages: normalizeMaxMessages(capabilities.maxMessages, 10),
    manualRenewal: typeof renew === "function" || capabilities.manualRenewal === true
  };

  return Object.freeze({
    apiVersion: MAILBOX_PROVIDER_API_VERSION,
    id,
    displayName: typeof displayName === "string" && displayName.trim() ? displayName.trim() : id,
    capabilities: Object.freeze(normalizedCapabilities),
    importSchema: Object.freeze({ ...importSchema }),
    parseImport,
    query,
    renew: typeof renew === "function" ? renew : undefined
  });
}

function assertMailboxProvider(provider) {
  if (
    !provider ||
    provider.apiVersion !== MAILBOX_PROVIDER_API_VERSION ||
    typeof provider.id !== "string" ||
    !PROVIDER_ID_PATTERN.test(provider.id) ||
    typeof provider.query !== "function" ||
    typeof provider.parseImport !== "function"
  ) {
    throw new TypeError("Invalid mailbox provider");
  }
  return provider;
}

function normalizeMaxMessages(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(50, Math.floor(number))) : fallback;
}

module.exports = { MAILBOX_PROVIDER_API_VERSION, assertMailboxProvider, createMailboxProvider };
