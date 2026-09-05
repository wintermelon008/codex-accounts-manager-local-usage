import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createGatewayServer, listen } from "../src/server.mjs";
import { QuotaExhaustionError } from "../src/providers.mjs";
import { GatewaySessionManager } from "../src/session-manager.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("manager gateway HTTP API", () => {
  it("creates and reads a session with bearer authorization", async () => {
    const switches = [];
    let activeAccountId = "account-a";
    const sessions = new GatewaySessionManager({
      maxSessions: 1,
      provider: {
        async run() {
          return { text: "ok", threadId: "thread-test" };
        }
      },
      manager: {
        async getActiveAccount() {
          return { id: activeAccountId, email: `${activeAccountId}@example.com` };
        },
        async switchAccount(accountId, options) {
          switches.push({ accountId, options });
          activeAccountId = accountId;
          return { status: "switched", accountId, email: `${accountId}@example.com` };
        }
      }
    });
    const config = {
      server: { host: "127.0.0.1", port: 0, token: "gateway-secret", corsOrigin: "*" }
    };
    const server = createGatewayServer({ sessions, config });
    servers.push(server);
    const address = await listen(server, config.server.host, 0);
    const baseUrl = `http://${address.host}:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/v1/capabilities`);
    assert.equal(unauthorized.status, 401);

    const preflight = await fetch(`${baseUrl}/v1/sessions/session-id`, {
      method: "OPTIONS",
      headers: {
        origin: "http://workbench.test",
        "access-control-request-method": "DELETE"
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, DELETE, OPTIONS");

    const capabilities = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: { authorization: "Bearer gateway-secret" }
    });
    assert.equal(capabilities.status, 200);
    const capabilityBody = await capabilities.json();
    assert.equal(capabilityBody.accountSwitch, true);
    assert.equal(capabilityBody.interjection, true);

    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ mode: "research", message: "hello" })
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.session.mode, "research");
    assert.equal(createdBody.session.message, "hello");

    const read = await fetch(`${baseUrl}/v1/sessions/${createdBody.sessionId}`, {
      headers: { authorization: "Bearer gateway-secret" }
    });
    assert.equal(read.status, 200);
    const body = await read.json();
    assert.equal(body.status, "completed");
    assert.equal(body.result.text, "ok");
    assert.equal(body.turns.length, 1);

    const followUp = await fetch(`${baseUrl}/v1/sessions/${createdBody.sessionId}/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ message: "follow up" })
    });
    assert.equal(followUp.status, 202);
    await sessions.waitForTerminal(createdBody.sessionId);
    const followUpBody = await (await fetch(`${baseUrl}/v1/sessions/${createdBody.sessionId}`, {
      headers: { authorization: "Bearer gateway-secret" }
    })).json();
    assert.deepEqual(followUpBody.turns.map((turn) => turn.message), ["hello", "follow up"]);

    const deleted = await fetch(`${baseUrl}/v1/sessions/${createdBody.sessionId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer gateway-secret" }
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true, sessionId: createdBody.sessionId });

    const missingAfterDelete = await fetch(`${baseUrl}/v1/sessions/${createdBody.sessionId}`, {
      headers: { authorization: "Bearer gateway-secret" }
    });
    assert.equal(missingAfterDelete.status, 404);

    const recovery = await fetch(`${baseUrl}/v1/recovery`, {
      headers: { authorization: "Bearer gateway-secret" }
    });
    assert.equal(recovery.status, 200);
    assert.equal((await recovery.json()).state, "idle");

    const switched = await fetch(`${baseUrl}/v1/accounts/switch`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ accountId: "account-b" })
    });
    assert.equal(switched.status, 200);
    assert.deepEqual(await switched.json(), {
      status: "switched",
      accountId: "account-b",
      recoveredSessionIds: []
    });
    assert.deepEqual(switches, [{ accountId: "account-b", options: { force: true } }]);
  });

  it("exposes read-only Manager status and account summaries to Gateway clients", async () => {
    const sessions = new GatewaySessionManager({
      provider: { async run() { return { text: "ok" }; } },
      manager: {
        async getAccounts() {
          return { accounts: [{ id: "account-a", email: "a@example.com", isActive: true }] };
        },
        async getStatus() {
          return { ok: true, activeAccountId: "account-a" };
        }
      }
    });
    const config = { server: { host: "127.0.0.1", port: 0, token: "gateway-secret", corsOrigin: "*" } };
    const server = createGatewayServer({ sessions, config });
    servers.push(server);
    const address = await listen(server, config.server.host, 0);
    const baseUrl = `http://${address.host}:${address.port}`;
    const headers = { authorization: "Bearer gateway-secret" };

    const accounts = await fetch(`${baseUrl}/v1/manager/accounts`, { headers });
    assert.equal(accounts.status, 200);
    assert.deepEqual(await accounts.json(), {
      accounts: [{ id: "account-a", email: "a@example.com", isActive: true }]
    });

    const status = await fetch(`${baseUrl}/v1/manager/status`, { headers });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { ok: true, activeAccountId: "account-a" });
  });

  it("reports unavailable optional capabilities instead of advertising them unconditionally", async () => {
    const sessions = new GatewaySessionManager({
      provider: { async run() { return { text: "unused" }; } }
    });
    const config = {
      server: { host: "127.0.0.1", port: 0, token: "gateway-secret", corsOrigin: "*" }
    };
    const server = createGatewayServer({ sessions, config });
    servers.push(server);
    const address = await listen(server, config.server.host, 0);
    const response = await fetch(`http://${address.host}:${address.port}/v1/capabilities`, {
      headers: { authorization: "Bearer gateway-secret" }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      api: "v1",
      modes: ["research", "develop"],
      sessionEvents: true,
      cancellation: true,
      interjection: true,
      accountSwitch: false,
      recoveryStatus: true,
      developWorktree: false,
      maxSessions: 4
    });
  });

  it("maps Manager availability failures to 503 while retaining switch conflicts as 409", async () => {
    const sessions = {
      maxSessions: 1,
      manualSwitch: async () => {
        const error = new Error("Manager 控制接口响应超时");
        error.statusCode = 503;
        throw error;
      }
    };
    const config = {
      server: { host: "127.0.0.1", port: 0, token: "gateway-secret", corsOrigin: "*" }
    };
    const server = createGatewayServer({ sessions, config });
    servers.push(server);
    const address = await listen(server, config.server.host, 0);
    const response = await fetch(`http://${address.host}:${address.port}/v1/accounts/switch`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ accountId: "account-b" })
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Manager 控制接口响应超时" });
  });

  it("keeps SSE open through quota recovery and closes after the recovered terminal state", async () => {
    let activeAccountId = "account-a";
    let releaseQuota;
    const quotaReady = new Promise((resolve) => {
      releaseQuota = resolve;
    });
    const switches = [];
    const sessions = new GatewaySessionManager({
      maxSessions: 1,
      provider: {
        async run({ session, emit }) {
          if (session.recoveryCount === 0) {
            await quotaReady;
            throw new QuotaExhaustionError("quota reached", { threadId: "sse-thread" });
          }
          emit({ type: "provider.completed", text: "recovered" });
          return { text: "recovered" };
        }
      },
      manager: {
        async getActiveAccount() {
          return { id: activeAccountId, email: `${activeAccountId}@example.com` };
        },
        async getAccounts() {
          return {
            accounts: [
              { id: "account-a", isActive: activeAccountId === "account-a", health: "healthy" },
              { id: "account-b", isActive: activeAccountId === "account-b", health: "healthy" }
            ]
          };
        },
        async switchAccount(accountId, options) {
          switches.push({ accountId, options });
          activeAccountId = accountId;
          return { status: "switched", accountId, email: `${accountId}@example.com` };
        }
      }
    });
    const config = {
      server: { host: "127.0.0.1", port: 0, token: "gateway-secret", corsOrigin: "*" }
    };
    const server = createGatewayServer({ sessions, config });
    servers.push(server);
    const address = await listen(server, config.server.host, 0);
    const baseUrl = `http://${address.host}:${address.port}`;
    const created = sessions.create({ mode: "research", message: "stream through recovery" });
    await waitUntil(() => sessions.get(created.id)?.status === "running");

    const response = await fetch(`${baseUrl}/v1/sessions/${created.id}/events`, {
      headers: { authorization: "Bearer gateway-secret" }
    });
    assert.equal(response.status, 200);
    releaseQuota();
    const body = await response.text();

    assert.match(body, /session\.quota_batch_pending/u);
    assert.match(body, /session\.recovery_queued/u);
    assert.match(body, /"status":"completed"/u);
    assert.match(body, /"text":"recovered"/u);
    assert.deepEqual(switches, [{ accountId: "account-b", options: { force: false } }]);
  });

  it("keeps a late SSE subscriber open while a recovered session is already running", async () => {
    let activeAccountId = "account-a";
    let releaseRecovery;
    const recoveryReady = new Promise((resolve) => {
      releaseRecovery = resolve;
    });
    const sessions = new GatewaySessionManager({
      maxSessions: 1,
      provider: {
        async run({ session, emit }) {
          if (session.recoveryCount === 0) {
            throw new QuotaExhaustionError("quota reached", { threadId: "late-thread" });
          }
          emit({ type: "provider.completed", text: "late recovered" });
          await recoveryReady;
          return { text: "late recovered" };
        }
      },
      manager: {
        async getActiveAccount() {
          return { id: activeAccountId, email: `${activeAccountId}@example.com` };
        },
        async getAccounts() {
          return {
            accounts: [
              { id: "account-a", isActive: activeAccountId === "account-a", health: "healthy" },
              { id: "account-b", isActive: activeAccountId === "account-b", health: "healthy" }
            ]
          };
        },
        async switchAccount(accountId) {
          activeAccountId = accountId;
          return { status: "switched", accountId, email: `${accountId}@example.com` };
        }
      }
    });
    const config = {
      server: { host: "127.0.0.1", port: 0, token: "gateway-secret", corsOrigin: "*" }
    };
    const server = createGatewayServer({ sessions, config });
    servers.push(server);
    const address = await listen(server, config.server.host, 0);
    const baseUrl = `http://${address.host}:${address.port}`;
    const created = sessions.create({ mode: "research", message: "late subscriber" });

    await waitUntil(() => sessions.get(created.id)?.status === "running" && sessions.get(created.id)?.recoveryCount === 1);
    const response = await fetch(`${baseUrl}/v1/sessions/${created.id}/events`, {
      headers: { authorization: "Bearer gateway-secret" }
    });
    const bodyPromise = response.text();
    releaseRecovery();
    const body = await bodyPromise;

    assert.match(body, /late recovered/u);
    assert.match(body, /"status":"completed"/u);
  });
});

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true before timeout");
}
