"use strict";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * The mailbox core only knows the public address and an opaque provider
 * credential object. Provider-specific fields stay inside that object.
 */
function normalizeMailboxAccount(account) {
  if (!account || typeof account !== "object") {
    throw new TypeError("Mailbox account must be an object");
  }

  const address = normalizeMailboxAddress(account.address ?? account.email ?? account.credentials?.email);
  const credentials = isRecord(account.credentials)
    ? cloneRecord(account.credentials)
    : extractInlineCredentials(account);

  if (Object.keys(credentials).length === 0) {
    throw new Error("Mailbox provider credentials are required");
  }

  return { address, credentials };
}

function normalizeMailboxAddress(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Mailbox address is required");
  }
  const address = value.trim();
  if (!EMAIL_PATTERN.test(address)) {
    throw new Error("Mailbox address is invalid");
  }
  if (/[\r\n]/u.test(address)) {
    throw new Error("Mailbox address must not contain line breaks");
  }
  return address;
}

function maskEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) {
    return "unknown mailbox";
  }

  const [local, ...domainParts] = email.split("@");
  const domain = domainParts.join("@");
  const visible = local.length > 1 ? local.slice(0, 1) : "*";
  return `${visible}***@${domain}`;
}

function extractInlineCredentials(account) {
  const credentials = {};
  for (const [key, value] of Object.entries(account)) {
    if (["id", "providerId", "address", "email", "displayName", "enabled"].includes(key)) {
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      credentials[key] = value;
    }
  }
  return credentials;
}

function cloneRecord(value) {
  return Object.fromEntries(Object.entries(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  maskEmail,
  normalizeMailboxAccount,
  normalizeMailboxAddress
};
