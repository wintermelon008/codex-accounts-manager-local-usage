"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  Sms688Client,
  Sms688PhoneOrderSession,
  normalizeLease,
  orderHasCode
} = require("../../src/operations/sms688-phone-order.cjs");

test("SMS688 client follows the documented manual SMS endpoints", async () => {
  const requests = [];
  const client = new Sms688Client({
    token: "sms688-secret-key",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ path: parsed.pathname, options });
      if (parsed.pathname === "/api/v1/manual-sms/me") return response({ quota: { available_uses: 8, remaining_uses: 9 } });
      if (parsed.pathname === "/api/v1/manual-sms/leases" && options.method === "POST") {
        return response({ job_id: "job-1", status: "waiting_code", phone: "+8613800000000" }, 202);
      }
      if (parsed.pathname === "/api/v1/manual-sms/leases/job-1" && options.method === "GET") {
        return response({ job_id: "job-1", status: "waiting_code", phone: "+8613800000000" });
      }
      if (parsed.pathname.endsWith("/change")) {
        return response({ job_id: "job-1", status: "waiting_code", phone: "+8613911111111", lease_generation: 2 }, 202);
      }
      if (parsed.pathname.endsWith("/release")) {
        return response({ job_id: "job-1", status: "cancelled", lease_generation: 3 }, 202);
      }
      throw new Error(`unexpected request ${options.method} ${url}`);
    }
  });

  assert.deepEqual(await client.profile(), { quota: { available_uses: 8, remaining_uses: 9 } });
  const created = await client.createLease();
  await client.orderStatus(created.id);
  await client.changeLease({ ...created, execution_generation: 4, lease_generation: 1 });
  await client.releaseLease({ ...created, execution_generation: 4, lease_generation: 2 });

  assert.equal(requests[0].options.headers.authorization, "Bearer sms688-secret-key");
  assert.equal(requests[1].options.method, "POST");
  assert.match(requests[1].options.headers["idempotency-key"], /^sms688-lease-/u);
  assert.equal(requests[2].path, "/api/v1/manual-sms/leases/job-1");
  assert.equal(requests[3].options.headers["x-execution-generation"], "4");
  assert.equal(requests[3].options.headers["x-phone-lease-generation"], "1");
  assert.equal(requests[4].options.headers["x-phone-lease-generation"], "2");
  assert.equal(orderHasCode({ status: "code_received", sms_code: "123456" }), true);
  assert.deepEqual(normalizeLease({ lease: { job_id: "nested-1", status: "queued" } }), {
    job_id: "nested-1",
    id: "nested-1",
    status: "queued",
    phone: "",
    sms_code: ""
  });
});

test("SMS688 order sessions poll the same lease and expose the received code", async () => {
  let statusCalls = 0;
  const calls = [];
  const client = {
    async profile() {
      calls.push("profile");
      return { quota: { available_uses: 3, remaining_uses: 4 } };
    },
    async createLease() {
      calls.push("create");
      return { job_id: "job-2", status: "waiting_code", phone: "+8613800000000" };
    },
    async orderStatus(jobId) {
      calls.push(["status", jobId]);
      statusCalls += 1;
      return statusCalls === 1
        ? { job_id: jobId, status: "waiting_code", phone: "+8613800000000" }
        : { job_id: jobId, status: "code_received", phone: "+8613800000000", sms_code: "654321" };
    }
  };
  const session = new Sms688PhoneOrderSession({
    clientFactory: () => client,
    pollIntervalMs: 5,
    orderTimeoutMs: 1000
  });

  const started = await session.start("sms688-secret-key");
  assert.equal(started.order.phone, "+8613800000000");
  assert.doesNotMatch(JSON.stringify(started), /sms688-secret-key/u);
  await waitFor(() => session.snapshot().phase === "received");

  assert.deepEqual(calls.slice(0, 2), ["profile", "create"]);
  assert.equal(session.snapshot().card.availableUses, 3);
  assert.equal(session.snapshot().order.smsCode, "654321");
  await session.dispose();
});

test("SMS688 sessions use explicit actions for replacement and release", async () => {
  const calls = [];
  const client = {
    async profile() { return { quota: { available_uses: 2 } }; },
    async createLease() { return { job_id: "job-3", status: "waiting_code", phone: "+8613800000000" }; },
    async orderStatus() { return { job_id: "job-3", status: "waiting_code", phone: "+8613800000000" }; },
    async changeLease() {
      calls.push("change");
      return { job_id: "job-3", status: "waiting_code", phone: "+8613911111111" };
    },
    async releaseLease() {
      calls.push("release");
      return { job_id: "job-3", status: "cancelled", phone: "+8613911111111" };
    }
  };
  const session = new Sms688PhoneOrderSession({ clientFactory: () => client, pollIntervalMs: 1000 });

  await session.start("key");
  const replaced = await session.replaceNumber();
  assert.equal(replaced.order.phone, "+8613911111111");
  const cancelled = await session.cancelNumber();
  assert.equal(cancelled.phase, "cancelled");
  assert.deepEqual(calls, ["change", "release"]);
  await session.dispose();
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
