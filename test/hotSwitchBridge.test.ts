import * as childProcess from "node:child_process";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexHotSwitchBridge,
  getHotSwitchSocketPath,
  type HotSwitchRefreshRequest
} from "../src/codex/hotSwitchBridge";

type Message = {
  id?: string;
  method?: string;
  params?: {
    accountId?: string;
    runtimeAccountId?: string;
    hasAccessToken?: boolean;
    id?: string;
    method?: string;
    threadId?: string;
    turnId?: string;
    goalStatus?: string;
    inputText?: string;
    recoveryMetadata?: string;
    recoveryContext?: string;
    cwd?: string;
    runtimeWorkspaceRoots?: string[];
    approvalPolicy?: string;
    permissions?: string;
    args?: string[];
    goal?: {
      status?: string;
      updatedAt?: number;
    };
  };
};

describe("CodexHotSwitchBridge", () => {
  let shim: childProcess.ChildProcessWithoutNullStreams | undefined;
  let bridge: CodexHotSwitchBridge | undefined;

  afterEach(() => {
    bridge?.dispose();
    bridge = undefined;
    shim?.kill("SIGTERM");
    shim = undefined;
  });

  it("is ready when initialized arrives before the initialize response", async () => {
    const root = path.resolve(__dirname, "..");
    const shimPath = path.join(root, "runtime", "codex-app-server-shim.cjs");
    const fakeCliPath = path.join(root, "test", "fixtures", "fake-codex-app-server.cjs");
    shim = childProcess.spawn(shimPath, ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: fakeCliPath
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(
      `${JSON.stringify({ id: "initialize-reordered", method: "initialize", params: {} })}\n${JSON.stringify({ method: "initialized", params: {} })}\n`
    );
    await messages.next((message) => message.id === "initialize-reordered");

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "unused-token",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    await expect(bridge.getStatus()).resolves.toMatchObject({
      runtimeProtocolVersion: 2,
      ready: true,
      initializeResponseReceived: true,
      initializedNotificationReceived: true,
      activeTurns: 0,
      httpTransportForced: true,
      transportMode: "http"
    });
    await expect(messages.next((message) => message.method === "test/runtimeArgs")).resolves.toMatchObject({
      params: {
        args: expect.arrayContaining([
          'model_provider="codex-accounts-seamless-http"',
          expect.stringContaining("supports_websockets=false")
        ])
      }
    });
    await expect(bridge.getIdentity()).resolves.toMatchObject({
      accountType: "chatgpt",
      email: "a@example.invalid",
      externalAuthActive: false,
      managedAccountId: null,
      managedLocalAccountId: null,
      httpTransportForced: true
    });
  });

  it("is ready after a successful initialize response without an initialized notification", async () => {
    const root = path.resolve(__dirname, "..");
    shim = childProcess.spawn(path.join(root, "runtime", "codex-app-server-shim.cjs"), ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "initialize-response-only", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "initialize-response-only");

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "unused-token",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    await expect(bridge.getStatus()).resolves.toMatchObject({
      ready: true,
      initializeResponseReceived: true,
      initializedNotificationReceived: false,
      activeTurns: 0
    });
  });

  it("rolls back both runtime auth and the managed active account when local commit fails", async () => {
    const root = path.resolve(__dirname, "..");
    shim = childProcess.spawn(path.join(root, "runtime", "codex-app-server-shim.cjs"), ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "commit-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "commit-initialize");
    shim.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    const activations: string[] = [];
    bridge = new CodexHotSwitchBridge(
      async () => ({
        accessToken: "rollback-token-a",
        chatgptAccountId: "account-a",
        chatgptPlanType: "plus"
      }),
      async (localAccountId) => {
        activations.push(localAccountId);
        if (localAccountId === "local-b") {
          throw new Error("local commit failed");
        }
      }
    );
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    await expect(
      bridge.switchAccount({
        accessToken: "access-token-b",
        accountId: "account-b",
        localAccountId: "local-b",
        previousAccountId: "account-a",
        previousLocalAccountId: "local-a",
        previousExpectedEmail: "a@example.invalid",
        expectedEmail: "b@example.invalid",
        planType: "plus",
        gracePeriodMs: 25,
        longTurnPolicy: "defer"
      })
    ).rejects.toThrow("local commit failed");
    expect(activations).toEqual(["local-b", "local-a"]);
    const loginAccountIds = messages.all
      .filter((message) => message.method === "test/received" && message.params?.method === "account/login/start")
      .map((message) => message.params?.accountId);
    expect(loginAccountIds).toEqual(["account-b", "account-a"]);
  }, 15_000);

  it("waits for active turns and queues new turns behind the account switch barrier", async () => {
    const root = path.resolve(__dirname, "..");
    const shimPath = path.join(root, "runtime", "codex-app-server-shim.cjs");
    const fakeCliPath = path.join(root, "test", "fixtures", "fake-codex-app-server.cjs");
    shim = childProcess.spawn(shimPath, ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: fakeCliPath
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "initialize-custom", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "initialize-custom");
    shim.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    let refreshCalls = 0;
    const refreshRequests: HotSwitchRefreshRequest[] = [];
    bridge = new CodexHotSwitchBridge(async (request) => {
      refreshCalls += 1;
      refreshRequests.push(request);
      return {
        accessToken: "refreshed-token",
        chatgptAccountId: "account-b",
        chatgptPlanType: "plus"
      };
    });
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({ id: "turn-1-request", method: "turn/start", params: { threadId: "thread-1", input: [] } })}\n`
    );
    shim.stdin.write(
      `${JSON.stringify({ id: "turn-2-request", method: "turn/start", params: { threadId: "thread-2", input: [] } })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "thread-1");
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "thread-2");

    const switchPromise = bridge.switchAccount({
      accessToken: "access-token-b",
      accountId: "account-b",
      localAccountId: "local-b",
      previousAccountId: "account-a",
      previousLocalAccountId: "local-a",
      previousExpectedEmail: "a@example.invalid",
      expectedEmail: "b@example.invalid",
      planType: "plus",
      gracePeriodMs: 10_000,
      longTurnPolicy: "defer"
    });
    await waitFor(async () => (await bridge!.getStatus()).pendingSwitch);

    shim.stdin.write(
      `${JSON.stringify({ id: "turn-3-request", method: "turn/start", params: { threadId: "thread-3", input: [] } })}\n`
    );
    shim.stdin.write(`${JSON.stringify({ id: "complete-1", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "complete-1");
    await waitFor(async () => (await bridge!.getStatus()).activeTurns === 1);
    expect(
      messages.all.some(
        (message) => message.method === "test/received" && message.params?.method === "account/login/start"
      )
    ).toBe(false);

    shim.stdin.write(`${JSON.stringify({ id: "complete-2", method: "test/complete", params: {} })}\n`);

    await expect(switchPromise).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      email: "b@example.invalid"
    });
    await messages.next(
      (message) =>
        message.method === "test/received" &&
        message.params?.method === "turn/start" &&
        message.params.id === "turn-3-request"
    );

    const receivedMethods = messages.all
      .filter((message) => message.method === "test/received")
      .map((message) => message.params?.method)
      .filter((method) => method !== "thread/goal/get");
    expect(receivedMethods).toEqual([
      "initialize",
      "initialized",
      "turn/start",
      "turn/start",
      "test/complete",
      "test/complete",
      "account/login/start",
      "account/read",
      "turn/start"
    ]);
    await expect(bridge.getIdentity()).resolves.toMatchObject({
      accountType: "chatgpt",
      email: "b@example.invalid",
      externalAuthActive: true,
      managedAccountId: "account-b",
      managedLocalAccountId: "local-b",
      httpTransportForced: true
    });

    shim.stdin.write(`${JSON.stringify({ id: "complete-3", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "complete-3");
    shim.stdin.write(`${JSON.stringify({ id: "refresh-request", method: "test/requestRefresh", params: {} })}\n`);
    await expect(messages.next((message) => message.method === "test/refreshResult")).resolves.toMatchObject({
      params: {
        accountId: "account-b",
        hasAccessToken: true
      }
    });
    expect(refreshCalls).toBe(1);
    expect(refreshRequests[0]).toEqual({
      previousAccountId: "account-b",
      localAccountId: "local-b",
      expectedEmail: "b@example.invalid"
    });

    await expect(
      bridge.switchAccount({
        accessToken: "access-token-c",
        accountId: "account-c",
        localAccountId: "local-c",
        previousAccountId: "account-b",
        previousLocalAccountId: "local-b",
        previousExpectedEmail: "b@example.invalid",
        expectedEmail: "c@example.invalid",
        planType: "plus",
        gracePeriodMs: 10_000,
        longTurnPolicy: "defer"
      })
    ).rejects.toThrow("different account");
    const loginAccountIds = messages.all
      .filter((message) => message.method === "test/received" && message.params?.method === "account/login/start")
      .map((message) => message.params?.accountId);
    expect(loginAccountIds).toEqual(["account-b", "account-c", "account-b"]);
    expect(refreshCalls).toBe(2);
    expect(refreshRequests[1]).toEqual({
      previousAccountId: "account-b",
      localAccountId: "local-b",
      expectedEmail: "b@example.invalid"
    });
  }, 15_000);

  it("pauses an active goal, switches accounts, and resumes it with sticky workspace permissions", async () => {
    const root = path.resolve(__dirname, "..");
    const shimPath = path.join(root, "runtime", "codex-app-server-shim.cjs");
    const fakeCliPath = path.join(root, "test", "fixtures", "fake-codex-app-server.cjs");
    shim = childProcess.spawn(shimPath, ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: fakeCliPath
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "goal-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "goal-initialize");
    shim.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({
        id: "goal-set-active",
        method: "thread/goal/set",
        params: { threadId: "goal-thread", objective: "Keep the workspace healthy", status: "active" }
      })}\n`
    );
    await messages.next((message) => message.id === "goal-set-active");
    const initialGoalUpdate = await messages.next(
      (message) => message.method === "thread/goal/updated" && message.params?.goal?.status === "active"
    );

    shim.stdin.write(
      `${JSON.stringify({
        id: "goal-turn-1",
        method: "turn/start",
        params: {
          threadId: "goal-thread",
          input: [],
          cwd: "/workspace/project",
          runtimeWorkspaceRoots: ["/workspace/project", "/workspace/shared"],
          approvalPolicy: "on-request",
          permissions: "workspace-profile"
        }
      })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "goal-thread");

    const switchPromise = bridge.switchAccount({
      accessToken: "access-token-b",
      accountId: "account-b",
      localAccountId: "local-b",
      previousAccountId: "account-a",
      previousLocalAccountId: "local-a",
      previousExpectedEmail: "a@example.invalid",
      expectedEmail: "b@example.invalid",
      planType: "plus",
      gracePeriodMs: 25,
      longTurnPolicy: "defer"
    });
    const pausedGoalUpdate = await messages.next(
      (message) => message.method === "thread/goal/updated" && message.params?.goal?.status === "paused"
    );
    expect(pausedGoalUpdate.params?.goal?.updatedAt).toBeGreaterThan(initialGoalUpdate.params?.goal?.updatedAt ?? 0);

    const resumedGoalUpdatePromise = messages.next(
      (message) =>
        message.method === "thread/goal/updated" &&
        message.params?.goal?.status === "active" &&
        (message.params.goal.updatedAt ?? 0) > (pausedGoalUpdate.params?.goal?.updatedAt ?? 0)
    );
    await messages.next(
      (message) =>
        message.method === "test/received" &&
        message.params?.method === "turn/interrupt" &&
        message.params?.threadId === "goal-thread"
    );
    await resumedGoalUpdatePromise;

    shim.stdin.write(
      `${JSON.stringify({
        id: "goal-auto-continuation",
        method: "turn/start",
        params: { threadId: "goal-thread", input: [] }
      })}\n`
    );

    await expect(switchPromise).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      interruptedTurns: 1,
      continuedThreads: 0
    });
    const continuation = await messages.next(
      (message) => message.method === "test/received" && message.params?.id === "goal-auto-continuation"
    );
    expect(continuation.params?.runtimeAccountId).toBe("account-b");
    await expect(
      messages.next(
        (message) => message.method === "test/effectiveTurnSettings" && message.params?.id === "goal-auto-continuation"
      )
    ).resolves.toMatchObject({
      params: {
        threadId: "goal-thread",
        cwd: "/workspace/project",
        runtimeWorkspaceRoots: ["/workspace/project", "/workspace/shared"],
        approvalPolicy: "on-request",
        permissions: "workspace-profile"
      }
    });

    const receivedMethods = messages.all
      .filter((message) => message.method === "test/received")
      .map((message) => `${message.params?.method}:${message.params?.goalStatus ?? ""}`);
    expect(receivedMethods.indexOf("thread/goal/set:paused")).toBeLessThan(
      receivedMethods.indexOf("account/login/start:")
    );
    expect(receivedMethods.indexOf("account/read:")).toBeLessThan(
      receivedMethods.lastIndexOf("thread/goal/set:active")
    );
    expect(receivedMethods.lastIndexOf("thread/goal/set:active")).toBeLessThan(
      receivedMethods.indexOf("turn/start:", receivedMethods.indexOf("turn/start:") + 1)
    );

    shim.stdin.write(`${JSON.stringify({ id: "goal-complete-2", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "goal-complete-2");
  }, 15_000);

  it("defers a switch after the grace period when an ordinary turn is still active", async () => {
    const root = path.resolve(__dirname, "..");
    shim = childProcess.spawn(path.join(root, "runtime", "codex-app-server-shim.cjs"), ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "defer-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "defer-initialize");
    shim.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    const activations: string[] = [];
    bridge = new CodexHotSwitchBridge(
      async () => ({
        accessToken: "rollback-token-a",
        chatgptAccountId: "account-a",
        chatgptPlanType: "plus"
      }),
      async (localAccountId) => {
        activations.push(localAccountId);
      }
    );
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({ id: "defer-turn", method: "turn/start", params: { threadId: "defer-thread", input: [] } })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "defer-thread");

    await expect(
      bridge.switchAccount({
        accessToken: "access-token-b",
        accountId: "account-b",
        localAccountId: "local-b",
        previousAccountId: "account-a",
        previousLocalAccountId: "local-a",
        previousExpectedEmail: "a@example.invalid",
        expectedEmail: "b@example.invalid",
        planType: "plus",
        gracePeriodMs: 25,
        longTurnPolicy: "defer"
      })
    ).resolves.toMatchObject({
      status: "deferred",
      reason: "activeOrdinaryTurns",
      activeTurns: 1
    });
    expect(activations).toEqual([]);
    expect(
      messages.all.some(
        (message) => message.method === "test/received" && message.params?.method === "account/login/start"
      )
    ).toBe(false);

    shim.stdin.write(`${JSON.stringify({ id: "defer-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "defer-complete");
  }, 15_000);

  it("interrupts and continues an ordinary thread on the new account when explicitly enabled", async () => {
    const root = path.resolve(__dirname, "..");
    shim = childProcess.spawn(path.join(root, "runtime", "codex-app-server-shim.cjs"), ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "continue-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "continue-initialize");
    shim.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    const activations: string[] = [];
    bridge = new CodexHotSwitchBridge(
      async () => ({
        accessToken: "rollback-token-a",
        chatgptAccountId: "account-a",
        chatgptPlanType: "plus"
      }),
      async (localAccountId) => {
        activations.push(localAccountId);
      }
    );
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({
        id: "continue-original-turn",
        method: "turn/start",
        params: {
          threadId: "continue-thread",
          input: [],
          cwd: "/workspace/continue-project",
          runtimeWorkspaceRoots: ["/workspace/continue-project", "/workspace/shared"],
          approvalPolicy: "on-request",
          permissions: "workspace-profile"
        }
      })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "continue-thread"
    );

    const switchResult = bridge.switchAccount({
      accessToken: "access-token-b",
      accountId: "account-b",
      localAccountId: "local-b",
      previousAccountId: "account-a",
      previousLocalAccountId: "local-a",
      previousExpectedEmail: "a@example.invalid",
      expectedEmail: "b@example.invalid",
      planType: "plus",
      gracePeriodMs: 25,
      longTurnPolicy: "interruptAndContinue"
    });
    await messages.next(
      (message) =>
        message.method === "test/received" &&
        message.params?.method === "turn/interrupt" &&
        message.params?.threadId === "continue-thread"
    );

    await expect(switchResult).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      interruptedTurns: 1,
      continuedThreads: 1,
      activeTurns: 1
    });
    expect(activations).toEqual(["local-b"]);

    const recovery = await messages.next(
      (message) =>
        message.method === "test/received" &&
        message.params?.method === "turn/start" &&
        message.params?.threadId === "continue-thread" &&
        message.params?.recoveryMetadata === "true"
    );
    expect(recovery.params?.runtimeAccountId).toBe("account-b");
    expect(recovery.params?.inputText).toBe("Continue.");
    expect(recovery.params?.recoveryContext).toContain("do not repeat non-idempotent actions");
    await expect(
      messages.next(
        (message) =>
          message.method === "test/effectiveTurnSettings" &&
          message.params?.threadId === "continue-thread" &&
          message.params?.id !== "continue-original-turn"
      )
    ).resolves.toMatchObject({
      params: {
        cwd: "/workspace/continue-project",
        runtimeWorkspaceRoots: ["/workspace/continue-project", "/workspace/shared"],
        approvalPolicy: "on-request",
        permissions: "workspace-profile"
      }
    });

    shim.stdin.write(`${JSON.stringify({ id: "continue-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "continue-complete");
  }, 15_000);

  it("resumes a paused goal when the manager disconnects before the active turn completes", async () => {
    const root = path.resolve(__dirname, "..");
    const shimPath = path.join(root, "runtime", "codex-app-server-shim.cjs");
    const fakeCliPath = path.join(root, "test", "fixtures", "fake-codex-app-server.cjs");
    shim = childProcess.spawn(shimPath, ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: fakeCliPath
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "disconnect-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "disconnect-initialize");
    shim.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({
        id: "disconnect-goal-set",
        method: "thread/goal/set",
        params: { threadId: "disconnect-thread", objective: "Keep running", status: "active" }
      })}\n`
    );
    await messages.next((message) => message.id === "disconnect-goal-set");
    shim.stdin.write(
      `${JSON.stringify({
        id: "disconnect-turn",
        method: "turn/start",
        params: { threadId: "disconnect-thread", input: [] }
      })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "disconnect-thread"
    );

    const switchResult = bridge
      .switchAccount({
        accessToken: "access-token-b",
        accountId: "account-b",
        localAccountId: "local-b",
        previousAccountId: "account-a",
        previousLocalAccountId: "local-a",
        previousExpectedEmail: "a@example.invalid",
        expectedEmail: "b@example.invalid",
        planType: "plus",
        gracePeriodMs: 10_000,
        longTurnPolicy: "defer"
      })
      .catch((error: unknown) => error);
    const pausedGoalUpdate = await messages.next(
      (message) => message.method === "thread/goal/updated" && message.params?.goal?.status === "paused"
    );

    bridge.dispose();
    bridge = undefined;
    await messages.next(
      (message) =>
        message.method === "thread/goal/updated" &&
        message.params?.goal?.status === "active" &&
        (message.params.goal.updatedAt ?? 0) > (pausedGoalUpdate.params?.goal?.updatedAt ?? 0)
    );
    await expect(switchResult).resolves.toBeInstanceOf(Error);

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "unused-token",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await expect(bridge.getStatus()).resolves.toMatchObject({
      pendingSwitch: false,
      switching: false,
      activeTurns: 1
    });

    shim.stdin.write(`${JSON.stringify({ id: "disconnect-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "disconnect-complete");
  }, 15_000);
});

function createMessageCollector(stream: NodeJS.ReadableStream): {
  all: Message[];
  next: (predicate: (message: Message) => boolean) => Promise<Message>;
} {
  const all: Message[] = [];
  const waiters: Array<{
    predicate: (message: Message) => boolean;
    resolve: (message: Message) => void;
  }> = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      buffer = buffer.slice(newlineIndex + 1);
      const message = JSON.parse(line) as Message;
      all.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter?.predicate(message)) {
          waiters.splice(index, 1);
          waiter.resolve(message);
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  return {
    all,
    next: (predicate) => {
      const existing = all.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<Message>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    }
  };
}

async function waitForSocket(socketPath: string): Promise<void> {
  await waitFor(async () => {
    try {
      const stat = await import("node:fs/promises").then((fs) => fs.stat(socketPath));
      return stat.isSocket();
    } catch {
      return false;
    }
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for test condition");
}
