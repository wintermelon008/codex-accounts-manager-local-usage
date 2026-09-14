#!/usr/bin/env node
"use strict";

// Explicit, single-account live verification. This consumes one short model
// turn. It never switches the user's live runtime or writes their credentials.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

function option(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }

async function main() {
  const installed = option("--extension");
  const cli = option("--codex");
  const authPath = option("--auth") || path.join(os.homedir(), ".codex", "auth.json");
  const model = option("--model") || "gpt-5.6-sol";
  if (!installed || !cli || !path.isAbsolute(installed) || !path.isAbsolute(cli)) throw new Error("Provide --extension and --codex absolute paths");
  const { CodexHotSwitchBridge, getHotSwitchSocketPath } = require(path.join(installed, "out/codex/hotSwitchBridge.js"));
  const state = require(path.join(installed, "out/application/accounts/accountState.js"));
  const { resolveAccountHealth } = require(path.join(installed, "out/application/accounts/health.js"));
  const { observeAccountAvailability } = require(path.join(installed, "out/application/accounts/observeAvailability.js"));
  const manifest = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
  const raw = JSON.parse(await fs.readFile(authPath, "utf8"));
  const accessToken = raw.tokens?.access_token;
  const accountId = raw.tokens?.account_id;
  if (!accessToken || !accountId) throw new Error("Current auth file has no OAuth credentials");
  const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
  const email = claims.email || (raw.tokens.id_token && JSON.parse(Buffer.from(raw.tokens.id_token.split(".")[1], "base64url").toString("utf8")).email);
  if (!email) throw new Error("Cannot establish current account identity");
  const secrets = [accessToken, raw.tokens.refresh_token, raw.tokens.id_token, email].filter(Boolean);
  const sanitize = (value) => secrets.reduce((s, secret) => s.split(secret).join("[redacted]"), String(value))
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
  const probeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "manager-availability-live-"));
  await fs.chmod(probeDirectory, 0o700);
  const tokens = { accessToken, accountId, refreshToken: raw.tokens.refresh_token, idToken: raw.tokens.id_token };
  const account = { id: "isolated-live-account", accountId, email, isActive: true, createdAt: 1, updatedAt: 1 };
  const repo = { getAccount: async () => account, getTokens: async () => tokens,
    updateTokens: async () => { throw new Error("Live verification cannot rotate stored credentials"); },
    tryAcquireSchedulerLease: async () => { throw new Error("Live verification cannot rotate stored credentials"); } };
  const automation = { enabled: false, intervalMs: 0, skewSeconds: 300, accounts: {} };
  const child = spawn(path.join(installed, "runtime/codex-app-server-shim.cjs"), ["app-server",
    "-c", 'cli_auth_credentials_store="file"', "-c", 'model_reasoning_effort="low"',
    "-c", "analytics.enabled=false", "--disable", "apps", "--disable", "plugins", "--disable", "remote_plugin"], {
    cwd: probeDirectory, env: { ...process.env, CODEX_HOME: probeDirectory, CODEX_ACCOUNTS_REAL_CLI: cli },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let bridge;
  const rpc = createRpc(child, sanitize);
  try {
    await rpc.request("initialize", { clientInfo: { name: "manager_availability_verification", title: "Manager availability verification", version: "1" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized", {});
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fs.stat(getHotSwitchSocketPath(process.pid)); break; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    const observations = [];
    bridge = new CodexHotSwitchBridge(
      async () => ({ accessToken, chatgptAccountId: accountId, chatgptPlanType: "plus" }),
      async () => undefined, async () => undefined, process.pid, async () => ({ handled: true }),
      async (event) => {
        const status = await bridge.getStatus();
        assert.equal(event.runtimeId, status.availabilityRuntimeId);
        state.setAvailabilityRuntime(status.availabilityRuntimeId);
        await observeAccountAvailability(repo, event);
        observations.push(event.kind);
      }
    );
    const before = resolveAccountHealth(account, tokens, automation);
    await bridge.switchAccount({ accessToken, accountId, localAccountId: account.id, expectedEmail: email,
      previousAccountId: accountId, previousLocalAccountId: account.id, previousExpectedEmail: email,
      planType: "plus", gracePeriodMs: 0, longTurnPolicy: "defer" });
    const thread = await rpc.request("thread/start", { model, cwd: probeDirectory, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    const threadId = thread?.thread?.id;
    assert.equal(typeof threadId, "string");
    const completion = rpc.waitFor("turn/completed", p => p?.threadId === threadId);
    await rpc.request("turn/start", { threadId, input: [{ type: "text", text: "Reply only with OK. Do not use any tools.", text_elements: [] }] });
    const completed = await completion;
    if (completed?.turn?.status !== "completed") throw new Error(`Real turn failed: ${sanitize(JSON.stringify(completed?.turn?.error || completed?.turn?.status))}`);
    for (let attempt = 0; attempt < 100 && !observations.includes("usable"); attempt++) await new Promise(r => setTimeout(r, 50));
    const after = resolveAccountHealth(account, tokens, automation);
    assert.equal(after.availability, "usable");
    assert.equal(after.kind, "healthy");
    assert.deepEqual(observations, ["usable"]);
    console.log(JSON.stringify({ passed: true, version: manifest.version, model, accountCount: 1,
      realTurnStatus: completed.turn.status, runtimeObservation: "usable", healthBefore: before.kind,
      healthAfter: after.kind, credentialsRotated: false, source: "installed extension + real Codex CLI + real upstream" }));
  } catch (error) {
    throw new Error(sanitize(error.message));
  } finally {
    bridge?.dispose(); rpc.dispose();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await stopped; clearTimeout(killer);
    }
    await fs.rm(probeDirectory, { recursive: true, force: true });
  }
}

function createRpc(child, sanitize) {
  let sequence = 0, buffer = "";
  const pending = new Map(), waiters = [];
  const write = value => child.stdin.write(JSON.stringify(value) + "\n");
  child.stderr.resume(); // CLI logs may contain credentials: never copy them into the report.
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && m.method) {
        write({ id: m.id, error: { code: -32601, message: "Verification client does not support interactive requests" } });
      } else if (m.id !== undefined) {
        const request = pending.get(String(m.id)); if (!request) continue;
        clearTimeout(request.timer); pending.delete(String(m.id));
        if (m.error) request.reject(new Error(sanitize(m.error.message))); else request.resolve(m.result);
      } else {
        for (let i = waiters.length - 1; i >= 0; i--) {
          const waiter = waiters[i]; if (waiter.method === m.method && waiter.predicate(m.params)) {
            waiters.splice(i, 1); clearTimeout(waiter.timer); waiter.resolve(m.params);
          }
        }
      }
    }
  });
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = `verify-${++sequence}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45_000);
        pending.set(id, { resolve, reject, timer }); write({ id, method, params });
      });
    },
    notify(method, params) { write({ method, params }); },
    waitFor(method, predicate) {
      return new Promise((resolve, reject) => {
        const waiter = { method, predicate, resolve, timer: setTimeout(() => reject(new Error(`${method} timed out`)), 90_000) };
        waiters.push(waiter);
      });
    },
    dispose() { for (const p of pending.values()) clearTimeout(p.timer); for (const p of waiters) clearTimeout(p.timer); }
  };
}

main().catch(error => { console.error(JSON.stringify({ passed: false, message: error.message })); process.exitCode = 1; });
