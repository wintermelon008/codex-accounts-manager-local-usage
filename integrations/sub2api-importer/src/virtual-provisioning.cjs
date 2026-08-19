"use strict";

const crypto = require("node:crypto");
const { Sub2ApiImportError } = require("./sub2apiClient.cjs");

const REGISTRATION_SIM_DELAY_MS = 2500;
const SMS_SIM_DELAY_MS = 8000;
const PHONE_SIM_DELAY_MS = 12000;
const RETRY_INTERVAL_MS = 90000;
const MAX_RETRIES = 25;

function generateFakePhone() {
  return `1${Math.floor(1300000000 + Math.random() * 9000000000)}`;
}

function generateFakeCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function simulateProvisioning(payload) {
  const result = {
    accountCreated: 0,
    accountFailed: 0,
    proxyCreated: 0,
    proxyReused: 0,
    proxyFailed: 0,
    accountConfigured: 0,
    accountFailures: []
  };

  for (const account of payload.accounts) {
    try {
      if (!account.credentials || !account.credentials.phone) {
        throw new Sub2ApiImportError("invalidPayload");
      }

      await new Promise(r => setTimeout(r, REGISTRATION_SIM_DELAY_MS));

      if (Math.random() < 0.25) {
        result.accountFailures.push({ accountId: account.id, reason: "phone_unavailable" });
        continue;
      }

      await new Promise(r => setTimeout(r, SMS_SIM_DELAY_MS));

      if (Math.random() < 0.15) {
        result.accountFailures.push({ accountId: account.id, reason: "code_timeout" });
        continue;
      }

      await new Promise(r => setTimeout(r, PHONE_SIM_DELAY_MS));

      result.accountCreated++;
      result.accountConfigured++;

    } catch (err) {
      result.accountFailed++;
      result.accountFailures.push({ accountId: account.id, reason: err.kind || "unknown" });
    }
  }

  return result;
}

module.exports = { simulateProvisioning };
