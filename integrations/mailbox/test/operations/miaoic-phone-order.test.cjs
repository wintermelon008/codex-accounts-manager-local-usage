"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MiaoicClient,
  MiaoicPhoneOrderSession,
  normalizeMiaoicState
} = require("../../src/operations/miaoic-phone-order.cjs");

test("Miaoic client redeems a CDK into an internal account cookie", async () => {
  const requests = [];
  const client = new MiaoicClient({
    fetchImpl: async (url, options) => {
      requests.push({ path: new URL(url).pathname, options });
      return response("兑换成功");
    }
  });

  const token = await client.redeem("miaoic-cdk");

  assert.match(token, /^[a-f0-9]{32}$/u);
  assert.equal(requests[0].path, "/me/redeem");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.cookie, `bj_user=${token}`);
  assert.equal(requests[0].options.headers["content-type"], "application/x-www-form-urlencoded;charset=UTF-8");
  assert.equal(requests[0].options.body, "codes=miaoic-cdk");
});

test("Miaoic redemption replaces a legacy token and retries a stale account token", async () => {
  const legacyRequests = [];
  const legacyClient = new MiaoicClient({
    token: "miaoic-page-token",
    fetchImpl: async (url, options) => {
      legacyRequests.push(options.headers.cookie);
      return response("兑换成功");
    }
  });
  const legacyReplacement = await legacyClient.redeem("miaoic-cdk");
  assert.match(legacyReplacement, /^[a-f0-9]{32}$/u);
  assert.equal(legacyRequests.length, 1);
  assert.equal(legacyRequests[0], `bj_user=${legacyReplacement}`);

  const staleToken = "0123456789abcdef0123456789abcdef";
  const staleRequests = [];
  const staleClient = new MiaoicClient({
    token: staleToken,
    fetchImpl: async (url, options) => {
      staleRequests.push(options.headers.cookie);
      return staleRequests.length === 1 ? response("还没有 Token", 400) : response("兑换成功");
    }
  });
  const staleReplacement = await staleClient.redeem("miaoic-cdk");
  assert.match(staleReplacement, /^[a-f0-9]{32}$/u);
  assert.notEqual(staleReplacement, staleToken);
  assert.deepEqual(staleRequests, [`bj_user=${staleToken}`, `bj_user=${staleReplacement}`]);
});

test("Miaoic client uses the internal account cookie and recv endpoints", async () => {
  const requests = [];
  const client = new MiaoicClient({
    token: "0123456789abcdef0123456789abcdef",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ path: parsed.pathname, options });
      if (parsed.pathname === "/recv/state" && options.method === "GET") {
        return response({ ok: true, balance: 8, active: false, phone: "", code: "" });
      }
      if (parsed.pathname === "/recv/open") {
        return response({ ok: true, balance: 7, active: true, phone: "+8613800000000", can_switch: true, can_release: true });
      }
      if (parsed.pathname === "/recv/switch") {
        return response({ ok: true, active: true, phone: "+8613911111111", can_switch: true, can_release: true });
      }
      if (parsed.pathname === "/recv/release") {
        return response({ ok: true, active: false, phone: "", code: "" });
      }
      throw new Error(`unexpected request ${options.method} ${url}`);
    }
  });

  assert.equal((await client.profile()).quota.available_uses, 8);
  const opened = await client.createLease();
  await client.changeLease(opened);
  await client.releaseLease(opened);

  assert.equal(requests[0].options.headers.cookie, "bj_user=0123456789abcdef0123456789abcdef");
  assert.equal(requests[0].options.headers["x-requested-with"], "fetch");
  assert.deepEqual(requests.map((request) => [request.options.method, request.path]), [
    ["GET", "/recv/state"],
    ["POST", "/recv/open"],
    ["POST", "/recv/switch"],
    ["POST", "/recv/release"]
  ]);
  assert.equal(normalizeMiaoicState({ ok: true, active: true, phone: "+8613800000000", code: "123456" }, "unused", "state").status, "code_received");
});

test("Miaoic reuses an active page lease instead of opening a duplicate", async () => {
  const requests = [];
  const client = new MiaoicClient({
    token: "0123456789abcdef0123456789abcdef",
    fetchImpl: async (url, options) => {
      requests.push([options.method, new URL(url).pathname]);
      return response({ ok: true, balance: 4, active: true, phone: "+8613800000000", can_switch: true, can_release: true });
    }
  });

  await client.profile();
  const active = await client.createLease();
  assert.equal(active.phone, "+8613800000000");
  assert.deepEqual(requests, [["GET", "/recv/state"]]);
});

test("Miaoic order sessions poll the shared state until a code arrives", async () => {
  let statusCalls = 0;
  const calls = [];
  const client = {
    async profile() {
      calls.push("profile");
      return { quota: { available_uses: 3, remaining_uses: 3 } };
    },
    async createLease() {
      calls.push("open");
      return { id: "miaoic", status: "waiting_code", phone: "+8613800000000", can_change: true, can_release: true };
    },
    async orderStatus() {
      calls.push("state");
      statusCalls += 1;
      return statusCalls === 1
        ? { id: "miaoic", status: "waiting_code", phone: "+8613800000000", can_change: true, can_release: true }
        : { id: "miaoic", status: "code_received", phone: "+8613800000000", sms_code: "654321" };
    }
  };
  const session = new MiaoicPhoneOrderSession({
    clientFactory: () => client,
    pollIntervalMs: 5,
    orderTimeoutMs: 1000
  });

  const started = await session.start("miaoic-token");
  assert.equal(started.order.phone, "+8613800000000");
  assert.doesNotMatch(JSON.stringify(started), /miaoic-token/u);
  await waitFor(() => session.snapshot().phase === "received");

  assert.deepEqual(calls.slice(0, 2), ["profile", "open"]);
  assert.equal(session.snapshot().card.availableUses, 3);
  assert.equal(session.snapshot().order.smsCode, "654321");
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
