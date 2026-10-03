import * as childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Message = { id?: string; method?: string; params?: Record<string, unknown> };

describe("Manager session queue runtime", () => {
  let shim: childProcess.ChildProcessWithoutNullStreams | undefined;
  let temporaryHome: string | undefined;

  afterEach(async () => {
    const currentShim = shim;
    shim = undefined;
    if (currentShim && currentShim.exitCode === null && currentShim.signalCode === null) {
      currentShim.kill("SIGTERM");
      await new Promise<void>((resolve) => currentShim.once("exit", () => resolve()));
    }
    if (temporaryHome) {
      await rm(temporaryHome, { recursive: true, force: true });
      temporaryHome = undefined;
    }
  });

  it("queues a same-thread start until the previous turn completes", async () => {
    const root = path.resolve(__dirname, "..");
    temporaryHome = await mkdtemp(path.join(os.tmpdir(), "codex-session-queue-runtime-"));
    const environment = { ...process.env };
    delete environment.CODEX_ACCOUNTS_PRIVATE_DIR;
    delete environment.AIDECK_DATA_DIR;
    environment.CODEX_HOME = path.join(temporaryHome, "codex-home");
    environment.CODEX_ACCOUNTS_REAL_CLI = path.join(root, "test", "fixtures", "fake-codex-app-server.cjs");
    shim = childProcess.spawn(path.join(root, "runtime", "codex-app-server-shim.cjs"), ["app-server"], {
      cwd: root,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const messages = collectMessages(shim.stdout);

    shim.stdin.write(`${JSON.stringify({ id: "queue-init", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "queue-init");

    shim.stdin.write(
      `${JSON.stringify({ id: "queue-first", method: "turn/start", params: { threadId: "queue-thread", input: [] } })}\n`
    );
    await messages.next((message) => message.id === "queue-first");
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "queue-thread");

    shim.stdin.write(
      `${JSON.stringify({ id: "queue-second", method: "turn/start", params: { threadId: "queue-thread", input: [] } })}\n`
    );
    shim.stdin.write(`${JSON.stringify({ id: "queue-complete", method: "test/complete", params: {} })}\n`);

    const completion = await messages.next((message) => message.id === "queue-complete");
    expect(completion).toMatchObject({ id: "queue-complete" });
    const secondResponse = await messages.next((message) => message.id === "queue-second");
    expect(secondResponse).toMatchObject({ id: "queue-second" });
    expect(messages.seen.findIndex((message) => message.method === "turn/completed")).toBeLessThan(
      messages.seen.findIndex((message) => message.id === "queue-second")
    );
  }, 15_000);
});

function collectMessages(stream: NodeJS.ReadableStream) {
  let buffer = "";
  const seen: Message[] = [];
  const waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void }> = [];

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const message = JSON.parse(line) as Message;
        seen.push(message);
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          if (waiters[index].predicate(message)) {
            const waiter = waiters.splice(index, 1)[0];
            waiter.resolve(message);
            break;
          }
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  return {
    seen,
    next(predicate: (message: Message) => boolean): Promise<Message> {
      const existing = seen.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    }
  };
}
