"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FutureClient,
  FuturePhoneOrderSession,
  extractSessionToken
} = require("../../src/operations/future-phone-order.cjs");

test("Future redeems a CDK and uses the returned session token for manual-sms", async () => {
  const requests = [];
  const client = new FutureClient({
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ path: parsed.pathname, options });
      if (parsed.pathname === "/api/v1/auth/redeem") {
        assert.deepEqual(JSON.parse(options.body), { code: "future-cdk" });
        return response({ session_token: "future-session-token" });
      }
      if (parsed.pathname === "/api/v1/manual-sms/me") {
        return response({ quota: { available_uses: 4, remaining_uses: 5 } });
      }
      if (parsed.pathname === "/api/v1/manual-sms/leases" && options.method === "POST") {
        return response({ job_id: "future-job-1", status: "waiting_code", phone: "+8613800000000" }, 202);
      }
      throw new Error(`unexpected Future request ${options.method} ${url}`);
    }
  });

  const token = await client.redeem("future-cdk");
  client.token = token;
  const profile = await client.profile();
  const lease = await client.createLease();

  assert.equal(token, "future-session-token");
  assert.deepEqual(profile, { quota: { available_uses: 4, remaining_uses: 5 } });
  assert.equal(lease.id, "future-job-1");
  assert.equal(requests[0].path, "/api/v1/auth/redeem");
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.equal(requests[1].options.headers.authorization, "Bearer future-session-token");
  assert.match(requests[2].options.headers["idempotency-key"], /^future-lease-/u);
});

test("Future phone order sessions use the Future source and hide the session token", async () => {
  let statusCalls = 0;
  const client = {
    async profile() { return { quota: { available_uses: 2 } }; },
    async createLease() { return { job_id: "future-job-2", status: "waiting_code", phone: "+8613800000000" }; },
    async orderStatus() {
      statusCalls += 1;
      return statusCalls === 1
        ? { job_id: "future-job-2", status: "waiting_code", phone: "+8613800000000" }
        : { job_id: "future-job-2", status: "code_received", phone: "+8613800000000", sms_code: "654321" };
    }
  };
  const session = new FuturePhoneOrderSession({
    clientFactory: () => client,
    pollIntervalMs: 5,
    orderTimeoutMs: 1000
  });

  const started = await session.start("future-session-token");
  assert.equal(started.card.source, "future");
  assert.equal(started.card.availableUses, 2);
  assert.doesNotMatch(JSON.stringify(started), /future-session-token/u);
  await waitFor(() => session.snapshot().phase === "received");
  assert.equal(session.snapshot().order.smsCode, "654321");
  assert.match(session.snapshot().message, /Future/u);
  await session.dispose();
});

test("Future redemption errors do not echo the CDK", async () => {
  const client = new FutureClient({
    fetchImpl: async () => response({ error: "invalid future-cdk" }, 400)
  });

  await assert.rejects(
    () => client.redeem("future-cdk"),
    (error) => {
      assert.match(error.message, /invalid \[已隐藏\]/u);
      assert.doesNotMatch(error.message, /future-cdk/u);
      return true;
    }
  );
});

test("Future token extraction accepts the documented and nested response shapes", () => {
  assert.equal(extractSessionToken({ session_token: "top-level" }), "top-level");
  assert.equal(extractSessionToken({ data: { sessionToken: "nested" } }), "nested");
  assert.equal(extractSessionToken({}), "");
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); }
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
