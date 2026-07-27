"use strict";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_OBSERVED_ACCOUNTS = 200;

/**
 * Read-only inventory observation. No account identifier, account name,
 * response body, or credential is returned to the Dashboard model.
 */
async function fetchSub2ApiGatewayInventory(config, credential, options = {}) {
  if (!config || typeof credential !== "string" || !credential.trim()) {
    throw new Error("The read-only observer credential is unavailable.");
  }
  const request = options.requestJson ?? requestJson;
  const headers = { "x-api-key": credential.trim() };
  const groups = unwrap(await request(`${config.adminBaseUrl}/api/v1/admin/groups/all?platform=openai`, headers));
  const group = Array.isArray(groups) ? groups.find((item) => item && item.name === config.group) : undefined;
  if (!group || (typeof group.id !== "number" && typeof group.id !== "string")) {
    throw new Error("The configured observer group could not be read.");
  }
  const accountsPage = unwrap(
    await request(
      `${config.adminBaseUrl}/api/v1/admin/accounts?platform=openai&group=${encodeURIComponent(String(group.id))}&page=1&page_size=${MAX_OBSERVED_ACCOUNTS}`,
      headers
    )
  );
  const accounts = Array.isArray(accountsPage) ? accountsPage : Array.isArray(accountsPage?.items) ? accountsPage.items : [];
  const eligible = accounts.filter((account) => account && account.status !== "disabled" && account.status !== "deleted");
  const observations = await Promise.all(
    eligible.slice(0, MAX_OBSERVED_ACCOUNTS).map(async (account) => {
      if (typeof account.id !== "number" && typeof account.id !== "string") {
        return undefined;
      }
      try {
        const quota = unwrap(
          await request(`${config.adminBaseUrl}/api/v1/admin/openai/accounts/${encodeURIComponent(String(account.id))}/quota`, headers)
        );
        return parseQuotaObservation(quota);
      } catch {
        return undefined;
      }
    })
  );
  const readable = observations.filter(Boolean);
  if (eligible.length > 0 && readable.length === 0) {
    throw new Error("The observer could not read any eligible quota window.");
  }
  return {
    status: "available",
    group: config.group,
    eligibleAccountCount: eligible.length,
    observedAccountCount: readable.length,
    fiveHour: aggregateWindow(readable.map((entry) => entry.fiveHour)),
    weekly: aggregateWindow(readable.map((entry) => entry.weekly)),
    checkedAt: Date.now()
  };
}

async function requestJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Read-only observer returned HTTP ${response.status}.`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function unwrap(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "code")) {
    if (value.code !== 0) {
      throw new Error("The read-only observer request was rejected.");
    }
    return value.data;
  }
  return value?.data ?? value;
}

function parseQuotaObservation(payload) {
  const rateLimit = payload?.rate_limit ?? payload?.rateLimit;
  return {
    fiveHour: parseWindow(rateLimit?.primary_window ?? rateLimit?.primaryWindow),
    weekly: parseWindow(rateLimit?.secondary_window ?? rateLimit?.secondaryWindow)
  };
}

function parseWindow(value) {
  const used = Number(value?.used_percent ?? value?.usedPercent);
  if (!Number.isFinite(used) || used < 0 || used > 100) {
    return undefined;
  }
  const reset = Number(value?.reset_at ?? value?.resetAt);
  const resetAt = Number.isFinite(reset) && reset > 0 ? (reset < 10_000_000_000 ? reset * 1000 : reset) : undefined;
  return { remainingUnits: Math.max(0, 1 - used / 100), capacityUnits: 1, remainingPercent: 100 - used, resetAt };
}

function aggregateWindow(windows) {
  const usable = windows.filter(Boolean);
  const capacityUnits = usable.reduce((sum, entry) => sum + entry.capacityUnits, 0);
  const remainingUnits = usable.reduce((sum, entry) => sum + entry.remainingUnits, 0);
  const resetValues = usable.map((entry) => entry.resetAt).filter((value) => Number.isFinite(value));
  return {
    accountCount: usable.length,
    remainingUnits,
    capacityUnits,
    remainingPercent: capacityUnits > 0 ? (remainingUnits / capacityUnits) * 100 : undefined,
    ...(resetValues.length ? { earliestResetAt: Math.min(...resetValues) } : {})
  };
}

module.exports = { fetchSub2ApiGatewayInventory };
