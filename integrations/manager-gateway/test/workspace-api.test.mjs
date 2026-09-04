import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createGatewayServer, listen } from "../src/server.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

function createSessions() {
  const calls = [];
  return {
    calls,
    maxSessions: 2,
    apply: async (id) => {
      calls.push({ action: "apply", id });
      if (id === "missing") {
        throw new Error("session not found");
      }
      if (id === "conflict") {
        throw new Error("worktree contains conflicting changes");
      }
      return {
        id,
        status: "completed",
        workspace: { status: "applied", diff: "" }
      };
    },
    discard: async (id) => {
      calls.push({ action: "discard", id });
      if (id === "missing") {
        throw new Error("session not found");
      }
      if (id === "conflict") {
        throw new Error("worktree could not be discarded");
      }
      return {
        id,
        status: "completed",
        workspace: { status: "discarded", diff: "" }
      };
    }
  };
}

async function startGateway(sessions) {
  const config = {
    server: { host: "127.0.0.1", port: 0, token: "gateway-secret", corsOrigin: "*" }
  };
  const server = createGatewayServer({ sessions, config });
  servers.push(server);
  const address = await listen(server, config.server.host, 0);
  return {
    baseUrl: `http://${address.host}:${address.port}`,
    headers: { authorization: "Bearer gateway-secret" }
  };
}

async function readJson(response) {
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/u);
  return response.json();
}

describe("manager gateway worktree HTTP API", () => {
  it("authenticates requests and returns JSON for apply and discard", async () => {
    const sessions = createSessions();
    const { baseUrl, headers } = await startGateway(sessions);

    const unauthorized = await fetch(`${baseUrl}/v1/sessions/session-1/apply`, {
      method: "POST"
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await readJson(unauthorized), { error: "unauthorized" });
    assert.deepEqual(sessions.calls, []);

    const applied = await fetch(`${baseUrl}/v1/sessions/session-1/apply`, {
      method: "POST",
      headers
    });
    assert.equal(applied.status, 200);
    assert.deepEqual(await readJson(applied), {
      session: {
        id: "session-1",
        status: "completed",
        workspace: { status: "applied", diff: "" }
      }
    });

    const discarded = await fetch(`${baseUrl}/v1/sessions/session-2/discard`, {
      method: "POST",
      headers
    });
    assert.equal(discarded.status, 200);
    assert.deepEqual(await readJson(discarded), {
      session: {
        id: "session-2",
        status: "completed",
        workspace: { status: "discarded", diff: "" }
      }
    });

    assert.deepEqual(sessions.calls, [
      { action: "apply", id: "session-1" },
      { action: "discard", id: "session-2" }
    ]);
  });

  it("maps worktree errors to the documented HTTP statuses", async () => {
    const sessions = createSessions();
    const { baseUrl, headers } = await startGateway(sessions);

    const missing = await fetch(`${baseUrl}/v1/sessions/missing/apply`, {
      method: "POST",
      headers
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await readJson(missing), { error: "session not found" });

    const conflict = await fetch(`${baseUrl}/v1/sessions/conflict/discard`, {
      method: "POST",
      headers
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await readJson(conflict), {
      error: "worktree could not be discarded"
    });
  });
});
