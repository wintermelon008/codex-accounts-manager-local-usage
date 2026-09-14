#!/usr/bin/env node
"use strict";

// Read-only local evidence audit. No OAuth/model requests, account switches,
// injected verdicts, or credential writes. This does NOT replace UI acceptance.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const installed = option("--extension");
if (!installed || !path.isAbsolute(installed)) throw new Error("Provide the installed extension's absolute --extension path");
const seconds = Number(option("--observe-seconds") ?? 0);
if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new Error("Observation must be between 0 and 3600 seconds");
const expectedCounts = option("--expected-counts") ? JSON.parse(option("--expected-counts")) : undefined;
const storage = path.join(os.homedir(), "Library/Application Support/Code/User/globalStorage");
const accountRoot = path.join(storage, "wannanbigpig.codex-accounts-manager");
const mirrorRoot = path.join(os.homedir(), ".ai_deck/accounts/codex/accounts");
const state = require(path.join(installed, "out/application/accounts/accountState.js"));
const { resolveAccountHealth } = require(path.join(installed, "out/application/accounts/health.js"));
const codeHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(installed, "out/application/accounts/accountState.js"))).digest("hex");

function snapshot() {
  const raw = execFileSync("sqlite3", ["-readonly", path.join(storage, "state.vscdb"),
    "select value from ItemTable where key='wannanbigpig.codex-accounts-manager';"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const localState = raw.trim() ? JSON.parse(raw) : {};
  const persistedEvidenceAccounts = Object.keys(localState).filter(key => key.startsWith("accountHealthEvidence.v1.")).length;
  state.initAccountStatePersistence({
    keys: () => Object.keys(localState), get: key => localState[key],
    // Migration may enqueue evidence writes. Keep them in this in-memory copy;
    // never write the user's SQLite database or credentials during acceptance.
    update: async (key, value) => { localState[key] = structuredClone(value); }
  });
  const accounts = JSON.parse(fs.readFileSync(path.join(accountRoot, "accounts-index.json"), "utf8")).accounts;
  const mirrors = new Map();
  for (const name of fs.readdirSync(mirrorRoot).filter(name => name.endsWith(".json"))) {
    const record = JSON.parse(fs.readFileSync(path.join(mirrorRoot, name), "utf8"));
    mirrors.set(record.id, record.tokens);
  }
  const counts = {};
  const rows = accounts.map((account, index) => {
    const source = mirrors.get(account.id);
    const tokens = source?.access_token ? { accountId: source.account_id ?? account.accountId,
      accessToken: source.access_token, idToken: source.id_token, refreshToken: source.refresh_token } : undefined;
    const health = resolveAccountHealth(account, tokens, { enabled: true, intervalMs: 0, skewSeconds: 300, accounts: {} });
    counts[health.kind] = (counts[health.kind] ?? 0) + 1;
    if (health.kind === "healthy") assert.equal(health.availability, "usable");
    if (health.kind === "refresh_unavailable") assert.equal(health.availability, "usable");
    if (health.kind === "refresh_unavailable_unverified") {
      assert.equal(health.availability, "unknown"); assert.equal(health.renewal, "unavailable");
    }
    if (health.kind === "access_token_invalid") assert.equal(health.availability, "auth_unavailable");
    return { account: index + 1, active: Boolean(account.isActive), hidden: Boolean(account.isHidden),
      kind: health.kind, availability: health.availability, renewal: health.renewal,
      observedAt: health.observedAt ?? null };
  });
  if (expectedCounts) assert.deepEqual(counts, expectedCounts);
  return { checkedAt: new Date().toISOString(), accountCount: accounts.length, counts, rows,
    persistedEvidenceAccounts };
}

async function main() {
  const startedAt = Date.now();
  let previous, samples = 0;
  console.log(JSON.stringify({ audit: "resolver from supplied directory + real local records (not live UI / not an upstream probe)",
    extensionDirectory: installed, migrationDryRunOnly: true,
    codeHash, requestedSeconds: seconds, modelRequests: 0, switches: 0, credentialWrites: 0 }));
  do {
    const current = snapshot(); samples++;
    const signature = JSON.stringify({ rows: current.rows, evidence: current.persistedEvidenceAccounts });
    if (signature !== previous || Date.now() - startedAt >= seconds * 1000) {
      console.log(JSON.stringify({ ...current, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000), samples }));
    }
    previous = signature;
    if (Date.now() - startedAt >= seconds * 1000) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(30_000, seconds * 1000 - (Date.now() - startedAt))));
  } while (true);
  console.log(JSON.stringify({ completed: true, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000), samples,
    liveUiVerified: false, upstreamUsabilityVerified: false, modelRequests: 0, switches: 0, credentialWrites: 0 }));
}

main().catch(() => { console.error(JSON.stringify({ completed: false, error: "Local read-only audit failed; no credential data is printed" })); process.exitCode = 1; });
