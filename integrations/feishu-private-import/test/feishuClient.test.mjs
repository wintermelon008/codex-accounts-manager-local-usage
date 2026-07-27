import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFeishuClient } from "../src/feishuClient.mjs";

describe("Feishu API client", () => {
  it("uses a cached tenant token and sends only an explicit text reply", async () => {
    const requests = [];
    const client = createFeishuClient({
      appId: "app-placeholder",
      appSecret: "secret-placeholder",
      apiBase: "https://api.example.invalid",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith("tenant_access_token/internal")) {
          return response({ code: 0, tenant_access_token: "tenant-token", expire: 600 });
        }
        return response({ code: 0 });
      }
    });

    await client.sendText("chat-id", "safe reply");
    await client.sendText("chat-id", "next reply");

    assert.equal(requests.length, 3);
    assert.match(requests[0].url, /tenant_access_token\/internal/u);
    assert.match(requests[1].url, /receive_id_type=chat_id/u);
    assert.match(requests[1].options.headers.authorization, /^Bearer /u);
    assert.equal(JSON.parse(requests[1].options.body).content, JSON.stringify({ text: "safe reply" }));
  });
});

function response(body) {
  return {
    ok: true,
    json: async () => body
  };
}
