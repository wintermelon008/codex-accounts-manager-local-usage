import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createManagerClient, ManagerControlError } from "../src/managerClient.mjs";

describe("Manager control client", () => {
  it("sends the bearer token and JSON refresh body", async () => {
    const requests = [];
    const client = createManagerClient({
      baseUrl: "http://127.0.0.1:43117/",
      token: "control-token",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return response(202, { id: "job-1", state: "queued" });
      }
    });
    const job = await client.refreshQuotas(["account-1"]);
    assert.equal(job.id, "job-1");
    assert.equal(requests[0].url, "http://127.0.0.1:43117/api/manager/quotas/refresh");
    assert.equal(requests[0].options.headers.get("authorization"), "Bearer control-token");
    assert.deepEqual(JSON.parse(requests[0].options.body), { accountIds: ["account-1"] });
  });

  it("submits canonical accounts to the Manager import boundary", async () => {
    let request;
    const client = createManagerClient({
      baseUrl: "http://127.0.0.1:43117",
      token: "control-token",
      fetchImpl: async (url, options) => {
        request = { url, options };
        return response(202, { id: "import-1", state: "queued", total: 1 });
      }
    });
    const result = await client.enqueueImport([
      { email: "person@example.invalid", tokens: { id_token: "id", access_token: "access" } }
    ]);
    assert.equal(result.id, "import-1");
    assert.equal(request.url, "http://127.0.0.1:43117/api/manager/imports");
    assert.deepEqual(JSON.parse(request.options.body).accounts, [
      { email: "person@example.invalid", tokens: { id_token: "id", access_token: "access" } }
    ]);
  });

  it("returns a safe error for an unavailable Manager endpoint", async () => {
    const client = createManagerClient({
      baseUrl: "http://127.0.0.1:43117",
      token: "control-token",
      fetchImpl: async () => response(401, { error: "unauthorized" })
    });
    await assert.rejects(client.getHealth(), (error) => {
      assert.equal(error instanceof ManagerControlError, true);
      assert.match(error.message, /unauthorized/u);
      return true;
    });
  });
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
