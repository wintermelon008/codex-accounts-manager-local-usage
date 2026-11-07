import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

type Message = {
  id?: string;
  method?: string;
  params?: { method?: string };
  result?: unknown;
  error?: { code: number; message: string };
};

const timeoutMessage = "workspace routing discovery timed out";
const children: ChildProcessWithoutNullStreams[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0).reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function createRuntime() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manager-auth-read-recovery-"));
  directories.push(directory);
  const fixture = path.join(directory, "fake-codex.cjs");
  await writeFile(
    fixture,
    `#!/usr/bin/env node
const { createInterface } = require("node:readline");
let failures = Number(process.env.FAKE_ROUTING_FAILURES || 0);
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  emit({ method: "test/received", params: { method: message.method } });
  if (message.id === undefined) return;
  if (process.env.FAKE_HOLD_AUTH === "1" &&
      ["account/read", "getAuthStatus", "account/logout"].includes(message.method)) return;
  if (message.method === "account/read" && failures-- > 0) {
    emit({ id: message.id, error: { code: -32603,
      message: process.env.FAKE_ROUTING_ERROR || "workspace routing discovery timed out" } });
  } else {
    const result = message.method === "account/read"
      ? { account: { type: "chatgpt", email: "test@example.invalid", planType: "plus" }, requiresOpenaiAuth: true }
      : message.method === "getAuthStatus" ? { authMethod: "chatgpt" } : {};
    emit({ id: message.id, result });
  }
});
`,
    { mode: 0o700 }
  );
  return { directory, fixture };
}

async function startClient(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  name: string,
  environment: Record<string, string> = {},
  sharedOwner = false
) {
  const directory = path.join(runtime.directory, name);
  await mkdir(directory);
  for (const file of ["codex-app-server-shim.cjs", "codex-session-queue.cjs"]) {
    await copyFile(path.resolve(__dirname, "../runtime", file), path.join(directory, file));
  }
  await writeFile(
    path.join(directory, "codex-app-server-shim.json"),
    JSON.stringify({
      realCliPath: runtime.fixture,
      ...(sharedOwner ? { runtimeOwnerPath: path.join(runtime.directory, "owner.lease") } : {})
    })
  );
  const env = { ...process.env };
  for (const key of [
    "CODEX_ACCOUNTS_PRIVATE_DIR",
    "AIDECK_DATA_DIR",
    "CODEX_ACCOUNTS_REAL_CLI",
    "CODEX_ACCOUNTS_RUNTIME_OWNER_PATH",
    "CODEX_ACCOUNTS_CONTROL_SOCKET"
  ])
    delete env[key];
  const child = spawn(process.execPath, [path.join(directory, "codex-app-server-shim.cjs"), "app-server"], {
    env: { ...env, CODEX_HOME: path.join(runtime.directory, "codex-home"), ...environment },
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.push(child);
  child.stderr.resume();
  const messages: Message[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line) as Message));
  async function next(predicate: (message: Message) => boolean): Promise<Message> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const message = messages.find(predicate);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for isolated runtime response");
  }
  const send = (id: string, method: string, params = {}) => {
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  };
  send(`${name}-init`, "initialize", {});
  await next((message) => message.id === `${name}-init`);
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  return { child, messages, next, send };
}

describe("authentication reads across routing and owner recovery", () => {
  it.each([
    {
      label: "retries a transient routing timeout",
      failures: 1,
      error: timeoutMessage,
      refresh: false,
      calls: 2,
      succeeds: true
    },
    {
      label: "stops after one routing retry",
      failures: 2,
      error: timeoutMessage,
      refresh: false,
      calls: 2,
      succeeds: false
    },
    {
      label: "preserves authentication rejection",
      failures: 1,
      error: "workspace routing discovery unauthorized (401)",
      refresh: false,
      calls: 1,
      succeeds: false
    },
    {
      label: "does not repeat an explicit token refresh",
      failures: 1,
      error: timeoutMessage,
      refresh: true,
      calls: 1,
      succeeds: false
    }
  ])("$label", async ({ failures, error, refresh, calls, succeeds }) => {
    const runtime = await createRuntime();
    const client = await startClient(runtime, "query", {
      FAKE_ROUTING_FAILURES: String(failures),
      FAKE_ROUTING_ERROR: error
    });
    client.send("read", "account/read", { refreshToken: refresh });
    const response = await client.next((message) => message.id === "read");
    if (succeeds) {
      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({ account: { type: "chatgpt" } });
    } else {
      expect(response.error?.message).toBe(error);
    }
    expect(client.messages.filter((message) => message.params?.method === "account/read")).toHaveLength(calls);
    expect(client.messages.filter((message) => message.id === "read")).toHaveLength(1);
  });

  it("replays pending authentication reads after owner loss and rejects pending logout", async () => {
    const runtime = await createRuntime();
    const owner = await startClient(runtime, "owner", { FAKE_HOLD_AUTH: "1" }, true);
    const client = await startClient(runtime, "attached", {}, true);
    client.send("read", "account/read", { refreshToken: false });
    client.send("status", "getAuthStatus", { refreshToken: false, includeToken: false });
    client.send("logout", "account/logout");
    await client.next((message) => message.params?.method === "account/logout");
    const exited = new Promise<void>((resolve) => owner.child.once("exit", () => resolve()));
    owner.child.kill("SIGTERM");
    await exited;
    expect(await client.next((message) => message.id === "read")).toMatchObject({
      result: { account: { type: "chatgpt" } }
    });
    expect(await client.next((message) => message.id === "status")).toMatchObject({
      result: { authMethod: "chatgpt" }
    });
    expect(await client.next((message) => message.id === "logout")).toMatchObject({ error: { code: -32001 } });
    expect(client.messages.filter((message) => message.params?.method === "account/logout")).toHaveLength(1);
  }, 15_000);
});
