import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { GatewayAttachmentStore } from "../src/attachments.mjs";
import { createGatewayServer, listen } from "../src/server.mjs";
import { GatewaySessionManager } from "../src/session-manager.mjs";

const servers = [];
const directories = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Gateway attachments", () => {
  it("stores, serves, and attaches a binary input to a session turn", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "manager-gateway-attachments-"));
    directories.push(stateDir);
    const attachments = new GatewayAttachmentStore({ stateDir, ttlMs: 60_000, maxBytes: 1024 * 1024 });
    await attachments.init();
    const sessions = new GatewaySessionManager({
      attachments,
      provider: {
        async run({ session }) {
          return { text: `received:${session.attachments?.[0]?.filename ?? "none"}` };
        }
      }
    });
    const config = { server: { host: "127.0.0.1", port: 0, token: "gateway-secret", corsOrigin: "*" } };
    const server = createGatewayServer({ sessions, config, attachments });
    servers.push(server);
    const address = await listen(server, config.server.host, 0);
    const baseUrl = `http://${address.host}:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/v1/attachments`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "secret"
    });
    assert.equal(unauthorized.status, 401);

    const uploaded = await fetch(`${baseUrl}/v1/attachments`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-secret",
        "content-type": "text/plain",
        "x-manager-filename": encodeURIComponent("notes.txt")
      },
      body: "hello attachment"
    });
    assert.equal(uploaded.status, 201);
    const descriptor = (await uploaded.json()).attachment;
    assert.equal(descriptor.filename, "notes.txt");
    assert.match(descriptor.url, /access_token=/u);

    const downloaded = await fetch(descriptor.url);
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), "hello attachment");

    const created = sessions.create({
      mode: "research",
      message: "read this",
      attachments: [{ id: descriptor.id }]
    });
    await sessions.waitForTerminal(created.id);
    const snapshot = sessions.get(created.id);
    assert.equal(snapshot.turns[0].attachments[0].filename, "notes.txt");
    assert.equal(snapshot.result.text, "received:notes.txt");
  });
});
