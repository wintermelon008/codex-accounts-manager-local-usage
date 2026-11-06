#!/usr/bin/env node

// Exercise the built Manager writer against a real Codex CLI using synthetic
// credentials, disposable storage, and a loopback-only backend.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const codexBin = option("--codex") ?? process.env.CODEX_APP_SERVER_BIN ?? "codex";
const managerRoot = path.resolve(option("--manager-root") ?? fileURLToPath(new URL("..", import.meta.url)));
const home = await mkdtemp(path.join(tmpdir(), "manager-auth-reload-verification-"));
process.env.CODEX_HOME = home;
process.env.AIDECK_DATA_DIR = path.join(home, "aideck");
delete process.env.CODEX_ACCOUNTS_PRIVATE_DIR;

const require = createRequire(import.meta.url);
const { writeAuthFile } = require(path.join(managerRoot, "out/codex/authFile.js"));
const { readCurrentAuthAccountStorageId, buildAccountStorageId } = require(
  path.join(managerRoot, "out/utils/accountIdentity.js")
);
const cases = [
  { name: "access-only", email: "follower@example.invalid", accountId: "workspace-follower" },
  {
    name: "refreshable",
    email: "primary@example.invalid",
    accountId: "workspace-primary",
    refreshToken: "synthetic-refresh"
  },
  { name: "switch-back-access-only", email: "follower@example.invalid", accountId: "workspace-follower" },
  { name: "legacy-access-only-repair", email: "legacy@example.invalid", accountId: "workspace-legacy", legacy: true }
];
let currentCase;
let blockedExternalRequests = 0;
const backend = createServer((request, response) => {
  request.resume();
  const body = request.url?.includes("accounts/check")
    ? {
        accounts: [
          {
            id: currentCase.accountId,
            workspace_backend_origin: "https://chatgpt.com",
            account_routing_override: "NO_CONSTRAINT"
          }
        ]
      }
    : { models: [], data: [] };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
});
// Keep any unexpected HTTPS request inside the test as well.
backend.on("connect", (_request, socket) => {
  blockedExternalRequests += 1;
  socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
});
await new Promise((resolve, reject) => {
  backend.once("error", reject);
  backend.listen(0, "127.0.0.1", resolve);
});
const base = `http://127.0.0.1:${backend.address().port}`;
const version = execFileSync(codexBin, ["--version"], { encoding: "utf8" }).trim();
let coldStarts = 0;

try {
  for (const testCase of cases) {
    currentCase = testCase;
    const jwt = syntheticJwt(testCase.email, testCase.accountId);
    const tokens = {
      idToken: jwt,
      accessToken: jwt,
      accountId: testCase.accountId,
      refreshToken: testCase.refreshToken
    };
    if (testCase.legacy) {
      await writeFile(
        path.join(home, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { id_token: jwt, access_token: jwt, account_id: testCase.accountId },
          last_refresh: new Date().toISOString()
        })
      );
    }
    await writeAuthFile(tokens);
    for (let reload = 0; reload < 2; reload += 1) {
      const stored = JSON.parse(await readFile(path.join(home, "auth.json"), "utf8"));
      const identityBefore = await readCurrentAuthAccountStorageId();
      assert.equal(identityBefore, buildAccountStorageId(testCase.email, testCase.accountId));
      await verifyColdStart(testCase);
      assert.equal(
        await readCurrentAuthAccountStorageId(),
        identityBefore,
        `${testCase.name}: current account changed`
      );
      assert.equal(stored.tokens.refresh_token, testCase.refreshToken ?? "", `${testCase.name}: invalid refresh field`);
      coldStarts += 1;
    }
  }
  console.log(
    JSON.stringify({
      passed: true,
      executable: codexBin,
      version,
      managerRoot,
      cases: cases.map(({ name }) => name),
      coldStarts,
      currentAccountPreserved: true,
      authenticatedAfterReload: true,
      blockedExternalRequests
    })
  );
} finally {
  await new Promise((resolve) => backend.close(resolve));
  await rm(home, { recursive: true, force: true });
}

async function verifyColdStart(testCase) {
  const env = {
    ...process.env,
    HTTP_PROXY: base,
    http_proxy: base,
    HTTPS_PROXY: base,
    https_proxy: base,
    ALL_PROXY: base,
    all_proxy: base,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost"
  };
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_ACCOUNTS_REAL_CLI",
    "CODEX_ACCOUNTS_RUNTIME_OWNER_PATH",
    "CODEX_ACCOUNTS_CONTROL_SOCKET"
  ])
    delete env[key];
  const child = spawn(
    codexBin,
    [
      "app-server",
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      `chatgpt_base_url="${base}"`,
      "-c",
      "analytics.enabled=false",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "remote_plugin"
    ],
    { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] }
  );
  const rpc = rpcClient(child);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "manager_auth_reload_verification", version: "1" },
      capabilities: { experimentalApi: true }
    });
    rpc.notify("initialized", {});
    const account = await rpc.request("account/read", { refreshToken: false });
    assert.equal(account.account?.type, "chatgpt", `${testCase.name}: Codex lost its login after reload`);
    assert.equal(account.account?.email, testCase.email);
    if (account.workspaceRouting) assert.equal(account.workspaceRouting.chatgptAccountId, testCase.accountId);
    const auth = await rpc.request("getAuthStatus", { includeToken: false, refreshToken: false });
    assert.ok(["chatgpt", "chatgptAuthTokens"].includes(auth.authMethod), `${testCase.name}: missing auth method`);
  } finally {
    rpc.dispose();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exited;
      clearTimeout(timer);
    }
  }
}

function rpcClient(child) {
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  child.stderr.resume();
  const rejectAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.on("error", rejectAll);
  child.on("exit", () => rejectAll(new Error("Isolated Codex app-server exited")));
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request || message.method) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const notify = (method, params, id) => child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return {
    notify,
    request(method, params) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 10_000);
        pending.set(id, { resolve, reject, timer });
        notify(method, params, id);
      });
    },
    dispose() {
      lines.close();
      rejectAll(new Error("Verification client disposed"));
    }
  };
}

function syntheticJwt(email, accountId) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    email,
    exp: Math.floor(Date.now() / 1000) + 3_600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" }
  })}.verification`;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
