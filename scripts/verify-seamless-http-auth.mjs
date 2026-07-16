#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const codexBin = readOption("--codex") ?? process.env.CODEX_APP_SERVER_BIN ?? "codex";
const codexHome = await mkdtemp(path.join(tmpdir(), "codex-seamless-auth-"));
const requests = [];
const observedEndpoints = [];
const server = createServer((request, response) => {
  observedEndpoints.push(`${request.method ?? "UNKNOWN"} ${request.url ?? ""}`);
  if (request.method === "POST" && request.url?.includes("/responses")) {
    requests.push({
      authorization: request.headers.authorization,
      accountId: request.headers["chatgpt-account-id"]
    });
  }
  request.resume();
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "intentional verification stop", type: "invalid_request_error" } }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Unable to bind the local verification server");
}

const providerId = "codex-accounts-auth-verification";
const providerConfig =
  `model_providers.${providerId}={ name="OpenAI", base_url="http://127.0.0.1:${address.port}/v1", ` +
  'wire_api="responses", requires_openai_auth=true, supports_websockets=false, request_max_retries=0, ' +
  "stream_max_retries=0 }";
const child = spawn(
  codexBin,
  [
    "app-server",
    "-c",
    `model_provider="${providerId}"`,
    "-c",
    providerConfig,
    "-c",
    "analytics.enabled=false",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin"
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost"
    },
    stdio: ["pipe", "pipe", "pipe"]
  }
);
const rpc = createRpcClient(child);

try {
  await rpc.request("initialize", {
    clientInfo: { name: "codex_accounts_auth_verification", title: "Codex Accounts Auth Verification", version: "1" },
    capabilities: { experimentalApi: true }
  });
  rpc.notify("initialized", {});

  const accountA = { id: "verification-account-a", token: createUnsignedJwt("first@example.invalid") };
  const accountB = { id: "verification-account-b", token: createUnsignedJwt("second@example.invalid") };
  await login(rpc, accountA);
  await verifyRuntimeEmail(rpc, "first@example.invalid");

  const started = await rpc.request("thread/start", {
    model: "gpt-5.4",
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only"
  });
  const threadId = started?.thread?.id;
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new Error("Codex did not return a thread identifier");
  }

  await runFailedProbeTurn(rpc, threadId, "first transport probe", requests, observedEndpoints, 1);
  await login(rpc, accountB);
  await verifyRuntimeEmail(rpc, "second@example.invalid");
  await runFailedProbeTurn(rpc, threadId, "second transport probe", requests, observedEndpoints, 2);

  const first = requests[0];
  const second = requests[1];
  const passed =
    first?.authorization === `Bearer ${accountA.token}` &&
    first?.accountId === accountA.id &&
    second?.authorization === `Bearer ${accountB.token}` &&
    second?.accountId === accountB.id;
  if (!passed) {
    throw new Error("The same thread did not use the newly selected HTTP credentials");
  }

  process.stdout.write(
    `${JSON.stringify({
      passed: true,
      sameThread: true,
      firstAccount: "a",
      secondAccount: "b",
      transport: "http",
      runtimeIdentityVerified: true
    })}\n`
  );
} finally {
  rpc.dispose();
  child.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
  await rm(codexHome, { recursive: true, force: true });
}

async function login(rpcClient, account) {
  await rpcClient.request("account/login/start", {
    type: "chatgptAuthTokens",
    accessToken: account.token,
    chatgptAccountId: account.id,
    chatgptPlanType: "plus"
  });
}

async function verifyRuntimeEmail(rpcClient, expectedEmail) {
  const account = await rpcClient.request("account/read", { refreshToken: false });
  if (account?.account?.email !== expectedEmail) {
    throw new Error("Codex account/read did not report the access-token email after login");
  }
}

async function runFailedProbeTurn(rpcClient, threadId, text, capturedRequests, endpoints, expectedCount) {
  const completed = rpcClient.waitForNotification("turn/completed", (params) => params?.threadId === threadId);
  await rpcClient.request("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }]
  });
  const completion = await completed;
  if (capturedRequests.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} Responses request(s), observed ${capturedRequests.length}; ` +
        `endpoints=${JSON.stringify(endpoints)} completion=${sanitize(JSON.stringify(completion))} ` +
        `stderr=${rpcClient.diagnostics()}`
    );
  }
}

function createUnsignedJwt(email) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    email,
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_plan_type: "plus" }
  })}.verification`;
}

function createRpcClient(processHandle) {
  let sequence = 0;
  let buffer = "";
  let stderr = "";
  const pending = new Map();
  const notificationWaiters = [];

  processHandle.stdout.setEncoding("utf8");
  processHandle.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        handleMessage(JSON.parse(line));
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  processHandle.stderr.setEncoding("utf8");
  processHandle.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  processHandle.on("exit", (code) => {
    const error = new Error(`Codex app-server exited unexpectedly (${code ?? "signal"}): ${sanitize(stderr)}`);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  });

  function handleMessage(message) {
    if (message.method === "attestation/generate" && message.id !== undefined) {
      write({ id: message.id, result: { token: "verification-attestation" } });
      return;
    }
    if (message.id !== undefined && !message.method) {
      const request = pending.get(String(message.id));
      if (!request) return;
      pending.delete(String(message.id));
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message ?? "Codex RPC failed"));
      else request.resolve(message.result);
      return;
    }
    if (message.method) {
      for (let index = notificationWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = notificationWaiters[index];
        if (waiter.method === message.method && waiter.predicate(message.params)) {
          notificationWaiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params);
        }
      }
    }
  }

  function write(message) {
    processHandle.stdin.write(`${JSON.stringify(message)}\n`);
  }

  return {
    request(method, params) {
      const id = `verify:${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out: ${sanitize(stderr)}`));
        }, 20_000);
        pending.set(id, { resolve, reject, timer });
        write({ id, method, params });
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    waitForNotification(method, predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = notificationWaiters.indexOf(waiter);
          if (index >= 0) notificationWaiters.splice(index, 1);
          reject(new Error(`${method} notification timed out: ${sanitize(stderr)}`));
        }, 20_000);
        const waiter = { method, predicate, resolve, reject, timer };
        notificationWaiters.push(waiter);
      });
    },
    dispose() {
      for (const request of pending.values()) clearTimeout(request.timer);
      for (const waiter of notificationWaiters) clearTimeout(waiter.timer);
      pending.clear();
      notificationWaiters.length = 0;
    },
    diagnostics() {
      return sanitize(stderr);
    }
  };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sanitize(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{3,}/gu, "[jwt-redacted]")
    .trim();
}
