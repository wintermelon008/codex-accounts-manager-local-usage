import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createProvider } from "../src/providers.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("manager gateway Codex provider", () => {
  it("uses the current ChatGPT adapter route without forcing the external Gateway model", async () => {
    const harness = await createHarness("success");
    const provider = createProvider(harness.config, {
      manager: {
        async getCodexExecProviderConfig() {
          return {
            baseUrl: "http://127.0.0.1:39001/v1",
            token: "adapter-token",
            model: "gpt-test",
            route: "chatgpt",
            ready: true,
            instanceId: "runtime-a"
          };
        }
      }
    });

    await provider.run({
      session: sessionFor(harness.root, { mode: "research", message: "answer normally" }),
      emit() {}
    });
    const [{ argv, adapterToken }] = await readInvocations(harness.logPath);

    const configs = valuesFor(argv, "--config");
    assert.ok(configs.includes('model_provider="codex-accounts-manager-runtime"'));
    assert.ok(configs.some((value) => value.includes('base_url="http://127.0.0.1:39001/v1"')));
    assert.equal(configs.includes('model="gpt-test"'), false);
    assert.equal(adapterToken, "adapter-token");
  });

  it("passes the configured model when the Manager adapter is on the external Gateway route", async () => {
    const harness = await createHarness("success");
    const provider = createProvider(harness.config, {
      manager: {
        async getCodexExecProviderConfig() {
          return {
            baseUrl: "http://127.0.0.1:39001/v1",
            token: "adapter-token",
            model: "gpt-test",
            route: "gateway",
            ready: true,
            instanceId: "runtime-a"
          };
        }
      }
    });

    await provider.run({
      session: sessionFor(harness.root, { mode: "research", message: "answer normally" }),
      emit() {}
    });
    const [{ argv }] = await readInvocations(harness.logPath);
    assert.ok(valuesFor(argv, "--config").includes('model="gpt-test"'));
  });

  it("runs a fresh exec with host access so it can reach the Workbench data service", async () => {
    const harness = await createHarness("success");
    const provider = createProvider(harness.config);

    const result = await provider.run({
      session: sessionFor(harness.root, { message: "inspect the project" }),
      emit() {}
    });
    const [{ argv, workbenchDataUrl }] = await readInvocations(harness.logPath);

    assert.deepEqual(argv.slice(0, 2), ["exec", "--json"]);
    assertFlag(argv, "--color", "never");
    assert.ok(argv.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.equal(argv.includes("--sandbox"), false);
    assertFlag(argv, "--cd", harness.root);
    assert.deepEqual(valuesFor(argv, "--config"), [
      'approval_policy="never"',
      'web_search="disabled"'
    ]);
    assert.match(argv.at(-1), /AGENTS\.md/u);
    assert.match(argv.at(-1), /WORKBENCH_DATA_URL/u);
    assert.equal(workbenchDataUrl, "http://127.0.0.1:43119");
    assert.equal(result.text, "fake-response-1");
  });

  it("does not treat normal rate-limit metadata or response text as quota exhaustion", async () => {
    const harness = await createHarness("success-with-quota-words");
    const provider = createProvider(harness.config);

    const result = await provider.run({
      session: sessionFor(harness.root, { message: "answer normally" }),
      emit() {}
    });

    assert.equal(result.text, "The quota limit is still available.");
  });

  it("keeps host access on resume without unsupported color or sandbox flags", async () => {
    const harness = await createHarness("success");
    const provider = createProvider(harness.config);

    const result = await provider.run({
      session: sessionFor(harness.root, {
        message: "continue the existing task",
        resumeThreadId: "thread-to-resume"
      }),
      emit() {}
    });
    const [{ argv }] = await readInvocations(harness.logPath);

    assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "--json"]);
    assert.equal(argv.includes("--color"), false);
    assert.equal(argv.includes("--sandbox"), false);
    assert.ok(argv.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.deepEqual(valuesFor(argv, "--config"), [
      'approval_policy="never"',
      'web_search="disabled"'
    ]);
    assert.ok(argv.includes("thread-to-resume"));
    assert.equal(argv.at(-1), "continue the existing task");
    assert.equal(result.text, "fake-response-1");
  });

  it("uses a semantic fresh exec when resume fails normally", async () => {
    const harness = await createHarness("resume-failure");
    const provider = createProvider(harness.config);
    const events = [];

    const result = await provider.run({
      session: sessionFor(harness.root, {
        message: "continue the original task",
        resumeThreadId: "missing-thread"
      }),
      emit(event) {
        events.push(event);
      }
    });
    const invocations = await readInvocations(harness.logPath);

    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations[0].argv.slice(0, 3), ["exec", "resume", "--json"]);
    assert.deepEqual(invocations[1].argv.slice(0, 2), ["exec", "--json"]);
    assertFlag(invocations[1].argv, "--color", "never");
    assert.ok(invocations[1].argv.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.equal(invocations[1].argv.includes("--sandbox"), false);
    assert.ok(invocations[1].argv.some((argument) => argument.includes("continue the original task")));
    assert.ok(events.some((event) => event.type === "session.resume_fallback"));
    assert.equal(result.text, "fake-response-2");
  });

  it("does not use semantic fallback for a quota error during resume", async () => {
    const harness = await createHarness("resume-quota");
    const provider = createProvider(harness.config);
    const events = [];

    await assert.rejects(
      provider.run({
        session: sessionFor(harness.root, {
          message: "resume despite quota exhaustion",
          resumeThreadId: "quota-thread"
        }),
        emit(event) {
          events.push(event);
        }
      }),
      (error) => {
        assert.equal(error.name, "QuotaExhaustionError");
        assert.equal(error.code, "quota_exhausted");
        return true;
      }
    );

    const invocations = await readInvocations(harness.logPath);
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].argv.slice(0, 3), ["exec", "resume", "--json"]);
    assert.equal(events.some((event) => event.type === "session.resume_fallback"), false);
  });
});

async function createHarness(behavior) {
  const root = await mkdtemp(join(tmpdir(), "manager-gateway-provider-"));
  temporaryDirectories.push(root);
  const binary = join(root, "fake-codex.mjs");
  const logPath = join(root, "argv.jsonl");
  await writeFile(binary, fakeCodexSource(behavior), "utf8");
  await chmod(binary, 0o755);
  return {
    root,
    logPath,
    config: {
      codex: {
        binary,
        home: join(root, "codex-home"),
        projectRoot: root,
        timeoutSeconds: 5
      },
      research: { baseUrl: "" }
    }
  };
}

function sessionFor(root, overrides = {}) {
  return {
    mode: "develop",
    message: "default task",
    workspace: { cwd: root },
    ...overrides
  };
}

async function readInvocations(logPath) {
  const content = await readFile(logPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function valuesFor(argv, flag) {
  return argv.flatMap((argument, index) => argument === flag ? [argv[index + 1]] : []);
}

function assertFlag(argv, flag, value) {
  const index = argv.indexOf(flag);
  assert.notEqual(index, -1, `expected ${flag} in ${JSON.stringify(argv)}`);
  assert.equal(argv[index + 1], value);
}

function fakeCodexSource(behavior) {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const logPath = "argv.jsonl";
const previous = existsSync(logPath) ? readFileSync(logPath, "utf8").trim() : "";
const callNumber = previous ? previous.split("\\n").length + 1 : 1;
appendFileSync(logPath, JSON.stringify({ argv, adapterToken: process.env.CODEX_ACCOUNTS_GATEWAY_ADAPTER_TOKEN, workbenchDataUrl: process.env.WORKBENCH_DATA_URL }) + "\\n");

if (${JSON.stringify(behavior)} === "resume-failure" && callNumber === 1 && argv[1] === "resume") {
  process.stderr.write("thread not found\\n");
  process.exitCode = 1;
} else if (${JSON.stringify(behavior)} === "resume-quota" && argv[1] === "resume") {
  process.stdout.write(JSON.stringify({ type: "error", message: "usage limit reached" }) + "\\n");
  process.stderr.write("usage limit reached\\n");
  process.exitCode = 1;
} else if (${JSON.stringify(behavior)} === "success-with-quota-words") {
  process.stderr.write("rate limit telemetry is available\\n");
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-" + callNumber }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 12, output_tokens: 3 },
    rate_limits: { primary: { used_percent: 7, window_minutes: 300 } }
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "The quota limit is still available." }
  }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-" + callNumber }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fake-response-" + callNumber } }) + "\\n");
}
`;
}
