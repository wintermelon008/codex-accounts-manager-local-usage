import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGatewayClient } from "../src/gatewayClient.mjs";

describe("Feishu Gateway client", () => {
  it("uses bearer authorization and reads Gateway-owned usage", async () => {
    const calls = [];
    const client = createGatewayClient({
      baseUrl: "http://gateway.test/",
      token: "gateway-token",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          status: "ready",
          date: "2026-09-05",
          timeZone: "Asia/Shanghai",
          eventCount: 1,
          total: { totalTokens: 16 },
          byModel: [{ model: "gpt-6-astra", totalTokens: 16 }]
        });
      }
    });

    const usage = await client.getUsageToday();

    assert.equal(usage.source, "gateway");
    assert.equal(usage.byModel[0].model, "gpt-6-astra");
    assert.equal(calls[0].url, "http://gateway.test/v1/usage/today");
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer gateway-token");
  });

  it("creates one session per Feishu chat and reuses it for follow-up messages", async () => {
    const calls = [];
    let terminalText = "first reply";
    const client = createGatewayClient({
      baseUrl: "http://gateway.test",
      token: "gateway-token",
      pollIntervalMs: 0,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url === "http://gateway.test/v1/sessions" && init.method === "POST") {
          return jsonResponse({ sessionId: "session-1" });
        }
        if (url.endsWith("/messages") && init.method === "POST") {
          terminalText = "follow-up reply";
          return jsonResponse({ session: { id: "session-1", status: "queued" } });
        }
        if (url === "http://gateway.test/v1/sessions/session-1") {
          return jsonResponse({ status: "completed", result: { text: terminalText } });
        }
        throw new Error(`unexpected request ${url}`);
      }
    });

    assert.equal(await client.sendMessage("chat-1", "first message"), "first reply");
    assert.equal(await client.sendMessage("chat-1", "follow-up message"), "follow-up reply");

    const posts = calls.filter(({ init }) => init.method === "POST");
    assert.deepEqual(JSON.parse(posts[0].init.body), { mode: "develop", message: "first message" });
    assert.equal(posts[1].url, "http://gateway.test/v1/sessions/session-1/messages");
    assert.deepEqual(JSON.parse(posts[1].init.body), { message: "follow-up message" });
    assert.ok(calls.every(({ init }) => init.headers.get("authorization") === "Bearer gateway-token"));
  });
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}
