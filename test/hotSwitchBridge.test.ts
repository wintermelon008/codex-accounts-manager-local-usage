import * as childProcess from "node:child_process";
import * as http from "node:http";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    modelProviders?: string[] | null;
    turnId?: string;
    goalStatus?: string;
    inputText?: string;
    recoveryMetadata?: string;
    recoveryContext?: string;
    statusCode?: number;
    hasAdapterToken?: boolean;
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
      runtimeProtocolVersion: 11,
      ready: true,
      initializeResponseReceived: true,
      initializedNotificationReceived: true,
      activeTurns: 0,
      usageLimitObservationEnabled: true,
      httpTransportForced: true,
      transportMode: "http"
    });
    await expect(messages.next((message) => message.method === "test/runtimeArgs")).resolves.toMatchObject({
      params: {
        args: expect.arrayContaining([
          'model_provider="codex-accounts-seamless-http"',
          expect.stringContaining("model_providers.codex-accounts-gateway="),
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
    await expect(
      bridge.activateUsageAttribution({
        localAccountId: "local-a",
        accountId: "account-a",
        expectedEmail: "a@example.invalid"
      })
    ).resolves.toEqual({ active: true, localAccountId: "local-a" });
  });

  it("waits for the app-server identity to settle after login before committing a switch", async () => {
    const root = path.resolve(__dirname, "..");
    const shimPath = path.join(root, "runtime", "codex-app-server-shim.cjs");
    const fakeCliPath = path.join(root, "test", "fixtures", "fake-codex-app-server.cjs");
    shim = childProcess.spawn(shimPath, ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: fakeCliPath,
        FAKE_CODEX_LOGIN_SETTLE_MS: "180"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "settle-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "settle-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
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
    ).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      email: "b@example.invalid"
    });

    expect(
      messages.all.filter(
        (message) => message.method === "test/received" && message.params?.method === "account/read"
      ).length
    ).toBeGreaterThanOrEqual(1);
    await expect(bridge.getIdentity()).resolves.toMatchObject({
      accountType: "chatgpt",
      email: "b@example.invalid",
      externalAuthActive: true,
      managedAccountId: "account-b",
      managedLocalAccountId: "local-b"
    });
  }, 15_000);

  it("accepts the login completion event when Gateway mode hides account/read identity", async () => {
    const root = path.resolve(__dirname, "..");
    const shimPath = path.join(root, "runtime", "codex-app-server-shim.cjs");
    const fakeCliPath = path.join(root, "test", "fixtures", "fake-codex-app-server.cjs");
    shim = childProcess.spawn(shimPath, ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: fakeCliPath,
        FAKE_CODEX_ACCOUNT_READ_REQUIRES_OPENAI_AUTH: "false"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "hidden-account-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "hidden-account-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
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
    ).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      email: "b@example.invalid"
    });
    expect(
      messages.all.filter(
        (message) => message.method === "test/received" && message.params?.method === "account/login/start"
      )
    ).toHaveLength(1);
  }, 15_000);

  it("clears and disables low-quota observation without affecting later fresh observations", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "observation-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "observation-initialize");

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    await expect(bridge.configureUsageLimitObservation(false)).resolves.toEqual({ enabled: false });
    shim.stdin.write(
      `${JSON.stringify({ id: "observation-disabled-turn", method: "turn/start", params: { threadId: "disabled-thread", input: [] } })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "disabled-thread"
    );
    shim.stdin.write(
      `${JSON.stringify({ id: "observation-disabled-fail", method: "test/failUsageLimit", params: {} })}\n`
    );
    await messages.next((message) => message.id === "observation-disabled-fail");
    await expect(bridge.getStatus()).resolves.toMatchObject({
      usageLimitObservationEnabled: false,
      recentUsageLimitedThreads: 0,
      usageLimitExhaustionReady: false,
      observedUsageLimitFailures: 0
    });

    await expect(bridge.configureUsageLimitObservation(true)).resolves.toEqual({ enabled: true });
    shim.stdin.write(
      `${JSON.stringify({ id: "observation-enabled-turn", method: "turn/start", params: { threadId: "enabled-thread", input: [] } })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "enabled-thread"
    );
    shim.stdin.write(
      `${JSON.stringify({ id: "observation-enabled-fail", method: "test/failUsageLimit", params: {} })}\n`
    );
    await messages.next((message) => message.id === "observation-enabled-fail");
    await expect(bridge.getStatus()).resolves.toMatchObject({
      usageLimitObservationEnabled: true,
      recentUsageLimitedThreads: 1,
      usageLimitExhaustionReady: true,
      observedUsageLimitFailures: 1
    });

    await expect(bridge.resetUsageLimitObservation()).resolves.toEqual({ reset: true });
    await expect(bridge.getStatus()).resolves.toMatchObject({
      usageLimitObservationEnabled: true,
      recentUsageLimitedThreads: 0,
      usageLimitExhaustionReady: false,
      observedUsageLimitFailures: 0
    });
  }, 15_000);

  it("keeps the real Gateway key in memory and forwards it only through the loopback adapter", async () => {
    const root = path.resolve(__dirname, "..");
    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-gateway-runtime-"));
    const shimPath = path.join(runtimeDirectory, "codex-app-server-shim.cjs");
    const diagnosticPath = path.join(runtimeDirectory, "gateway-last-failure.json");
    const upstreamRequests: Array<{ authorization?: string; method?: string; url?: string }> = [];
    const shimStderr: string[] = [];
    let failNextResponse = false;
    let upstreamClosed = false;
    const upstream = http.createServer((request, response) => {
      upstreamRequests.push({ authorization: request.headers.authorization, method: request.method, url: request.url });
      if (request.url === "/v1/responses") {
        request.resume();
        if (failNextResponse) {
          failNextResponse = false;
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "upstream failure" } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: response.completed\n");
        response.end(
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}}\n\n'
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Test upstream did not receive a TCP port");
    }

    try {
      await copyFile(path.join(root, "runtime", "codex-app-server-shim.cjs"), shimPath);
      const gatewayBaseUrl = `http://127.0.0.1:${upstreamAddress.port}/v1`;
      await writeFile(
        path.join(runtimeDirectory, "codex-app-server-shim.json"),
        JSON.stringify({
          realCliPath: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs"),
          forceHttpTransport: true,
          gateway: {
            displayName: "Gateway",
            baseUrl: gatewayBaseUrl,
            model: "gateway-test-model"
          }
        }),
        "utf8"
      );
      const runtimeConfigText = await readFile(path.join(runtimeDirectory, "codex-app-server-shim.json"), "utf8");
      expect(runtimeConfigText).not.toContain("real-gateway-key");

      shim = childProcess.spawn(shimPath, ["app-server"], {
        cwd: root,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      shim.stderr.on("data", (chunk) => shimStderr.push(String(chunk)));
      const messages = createMessageCollector(shim.stdout);
      shim.stdin.write(`${JSON.stringify({ id: "gateway-initialize", method: "initialize", params: {} })}\n`);
      await messages.next((message) => message.id === "gateway-initialize");

      bridge = new CodexHotSwitchBridge(async () => ({
        accessToken: "unused-token",
        chatgptAccountId: "account-a",
        chatgptPlanType: "plus"
      }));
      await waitForSocket(getHotSwitchSocketPath(process.pid));
      await expect(bridge.getStatus()).resolves.toMatchObject({
        gatewayActive: true,
        providerKind: "gateway",
        gatewayBaseUrl,
        gatewayModel: "gateway-test-model"
      });
      await expect(bridge.getGatewayStatus()).resolves.toMatchObject({ active: true, ready: false });
      await expect(messages.next((message) => message.method === "test/runtimeArgs")).resolves.toMatchObject({
        params: {
          hasLoopbackNoProxyBypass: true,
          args: expect.arrayContaining([
            'model_provider="codex-accounts-seamless-http"',
            'model="gateway-test-model"',
            expect.stringContaining("model_providers.codex-accounts-gateway="),
            expect.stringContaining('base_url="http://127.0.0.1:')
          ])
        }
      });

      shim.stdin.write(`${JSON.stringify({ id: "gateway-probe-before", method: "test/probeGateway", params: {} })}\n`);
      const delayedGatewayProbe = messages.next(
        (message) => message.method === "test/gatewayProbe" && message.params?.statusCode === 200
      );
      await waitFor(() =>
        shimStderr.join("").includes("Gateway request is waiting for credential: method=GET path=/v1/models")
      );
      expect(upstreamRequests).toEqual([]);

      await expect(bridge.configureGatewayCredential("real-gateway-key")).resolves.toMatchObject({
        active: true,
        ready: true
      });
      await expect(delayedGatewayProbe).resolves.toMatchObject({ params: { hasAdapterToken: true } });
      expect(upstreamRequests).toEqual([
        { authorization: "Bearer real-gateway-key", method: "GET", url: "/v1/models" }
      ]);
      await waitFor(() => shimStderr.join("").includes("Gateway credential configured"));
      const credentialLogText = shimStderr.join("");
      expect(credentialLogText).not.toContain("real-gateway-key");
      expect(credentialLogText).not.toContain('"input"');
      shim.stdin.write(
        `${JSON.stringify({ id: "gateway-response-probe", method: "test/probeGatewayResponse", params: {} })}\n`
      );
      await expect(
        messages.next((message) => message.method === "test/gatewayResponseProbe" && message.params?.statusCode === 200)
      ).resolves.toMatchObject({ params: { hasAdapterToken: true } });
      expect(upstreamRequests).toEqual([
        { authorization: "Bearer real-gateway-key", method: "GET", url: "/v1/models" },
        { authorization: "Bearer real-gateway-key", method: "POST", url: "/v1/responses" }
      ]);
      failNextResponse = true;
      shim.stdin.write(
        `${JSON.stringify({ id: "gateway-failing-response-probe", method: "test/probeGatewayResponse", params: {} })}\n`
      );
      await expect(
        messages.next((message) => message.method === "test/gatewayResponseProbe" && message.params?.statusCode === 502)
      ).resolves.toMatchObject({ params: { hasAdapterToken: true } });
      await expect(bridge.getGatewayStatus()).resolves.toMatchObject({
        requestCount: 3,
        successfulRequestCount: 2,
        failedRequestCount: 1,
        lastFailureOrigin: "upstream",
        lastFailureStatusCode: 502,
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 3,
        reasoningTokens: 2,
        totalTokens: 18
      });
      const upstreamDiagnosticText = await readFile(diagnosticPath, "utf8");
      expect(JSON.parse(upstreamDiagnosticText)).toMatchObject({
        schema: "codex-accounts-gateway-diagnostic/v1",
        origin: "upstream",
        statusCode: 502,
        upstreamStatusCode: 502,
        request: {
          method: "POST",
          path: "/v1/responses",
          contentLength: expect.any(Number)
        }
      });
      expect(upstreamDiagnosticText).not.toContain("real-gateway-key");
      expect(upstreamDiagnosticText).not.toContain('"input"');
      await waitFor(() => shimStderr.join("").includes("Gateway forwarding failed: origin=upstream status=502"));
      const upstreamLogText = shimStderr.join("");
      expect(upstreamLogText).toContain("upstreamStatus=502 method=POST path=/v1/responses");
      expect(upstreamLogText).not.toContain("real-gateway-key");
      expect(upstreamLogText).not.toContain('"input"');

      (upstream as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          upstreamClosed = true;
          resolve();
        });
      });
      const previousResponseProbeCount = messages.all.filter(
        (message) => message.method === "test/gatewayResponseProbe"
      ).length;
      shim.stdin.write(
        `${JSON.stringify({ id: "gateway-connection-refused-probe", method: "test/probeGatewayResponse", params: {} })}\n`
      );
      await waitFor(
        () =>
          messages.all.filter((message) => message.method === "test/gatewayResponseProbe").length >
          previousResponseProbeCount
      );
      expect(messages.all.filter((message) => message.method === "test/gatewayResponseProbe").at(-1)).toMatchObject({
        params: { statusCode: 502, hasAdapterToken: true }
      });
      await expect(bridge.getGatewayStatus()).resolves.toMatchObject({
        requestCount: 4,
        successfulRequestCount: 2,
        failedRequestCount: 2,
        lastFailureOrigin: "adapter",
        lastFailureStatusCode: 502,
        lastFailureTransportCode: expect.stringMatching(/^[A-Z][A-Z0-9_]+$/u),
        lastFailureRequestMethod: "POST",
        lastFailureRequestPath: "/v1/responses"
      });
      const adapterDiagnosticText = await readFile(diagnosticPath, "utf8");
      expect(JSON.parse(adapterDiagnosticText)).toMatchObject({
        schema: "codex-accounts-gateway-diagnostic/v1",
        origin: "adapter",
        statusCode: 502,
        transportCode: expect.stringMatching(/^[A-Z][A-Z0-9_]+$/u),
        request: { method: "POST", path: "/v1/responses" }
      });
      expect(adapterDiagnosticText).not.toContain("real-gateway-key");
      expect(adapterDiagnosticText).not.toContain('"input"');
      await waitFor(() => shimStderr.join("").includes("Gateway forwarding failed: origin=adapter status=502"));
      expect(shimStderr.join("")).toMatch(
        /Gateway forwarding failed: origin=adapter status=502 transport=[A-Z][A-Z0-9_]+ method=POST path=\/v1\/responses/u
      );
    } finally {
      bridge?.dispose();
      bridge = undefined;
      shim?.kill("SIGTERM");
      shim = undefined;
      if (!upstreamClosed) {
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  }, 15_000);

  it("refreshes the model list for the active Gateway route", async () => {
    const root = path.resolve(__dirname, "..");
    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-gateway-models-"));
    const shimPath = path.join(runtimeDirectory, "codex-app-server-shim.cjs");
    const upstreamRequests: Array<{ authorization?: string; method?: string; url?: string }> = [];
    const upstream = http.createServer((request, response) => {
      upstreamRequests.push({ authorization: request.headers.authorization, method: request.method, url: request.url });
      request.resume();
      if (request.url !== "/v1/models") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            { id: "grok-4-fast", name: "Grok 4 Fast" },
            { id: "grok-4-latest" },
            { id: "grok-4-fast" }
          ]
        })
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Test upstream did not receive a TCP port");
    }

    try {
      await copyFile(path.join(root, "runtime", "codex-app-server-shim.cjs"), shimPath);
      await writeFile(
        path.join(runtimeDirectory, "codex-app-server-shim.json"),
        JSON.stringify({
          realCliPath: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs"),
          forceHttpTransport: true,
          gateway: {
            displayName: "Gateway",
            baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
            model: "grok-4-latest",
            autoFallbackToChatGpt: false
          }
        }),
        "utf8"
      );
      shim = childProcess.spawn(shimPath, ["app-server"], {
        cwd: root,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const messages = createMessageCollector(shim.stdout);
      shim.stdin.write(`${JSON.stringify({ id: "model-list-initialize", method: "initialize", params: {} })}\n`);
      await messages.next((message) => message.id === "model-list-initialize");

      bridge = new CodexHotSwitchBridge(async () => ({
        accessToken: "oauth-token",
        chatgptAccountId: "oauth-account",
        chatgptPlanType: "plus"
      }));
      await waitForSocket(getHotSwitchSocketPath(process.pid));
      await bridge.configureGatewayCredential("gateway-key");

      shim.stdin.write(`${JSON.stringify({ id: "startup-account-read", method: "account/read", params: {} })}\n`);
      await messages.next((message) => message.id === "startup-account-read");
      await waitFor(() => messages.all.filter((message) => message.method === "account/updated").length === 1);

      shim.stdin.write(`${JSON.stringify({ id: "gateway-models", method: "model/list", params: {} })}\n`);
      await expect(messages.next((message) => message.id === "gateway-models")).resolves.toMatchObject({
        result: {
          data: [
            {
              id: "grok-4-fast",
              model: "grok-4-fast",
              displayName: "Grok 4 Fast",
              hidden: false,
              isDefault: false,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }]
            },
            {
              id: "grok-4-latest",
              model: "grok-4-latest",
              isDefault: true
            }
          ],
          nextCursor: null
        }
      });
      expect(upstreamRequests).toEqual([
        { authorization: "Bearer gateway-key", method: "GET", url: "/v1/models" }
      ]);
      expect(messages.all.some((message) => message.method === "test/received" && message.params?.method === "model/list")).toBe(
        false
      );

      const accountUpdatedBeforeChatGptRoute = messages.all.filter((message) => message.method === "account/updated").length;
      await expect(
        bridge.switchGatewayRoute({
          route: "chatgpt",
          chatgptAccessToken: "oauth-token",
          gracePeriodMs: 0,
          longTurnPolicy: "defer"
        })
      ).resolves.toMatchObject({ status: "switched" });
      await waitFor(
        () => messages.all.filter((message) => message.method === "account/updated").length > accountUpdatedBeforeChatGptRoute
      );
      shim.stdin.write(`${JSON.stringify({ id: "chatgpt-models", method: "model/list", params: {} })}\n`);
      await expect(messages.next((message) => message.id === "chatgpt-models")).resolves.toMatchObject({
        result: { data: [{ id: "gpt-5.6-terra", model: "gpt-5.6-terra" }] }
      });
      expect(upstreamRequests).toHaveLength(1);

      shim.stdin.write(`${JSON.stringify({ id: "delay-chatgpt-models", method: "test/delayNextModelList", params: {} })}\n`);
      await messages.next((message) => message.id === "delay-chatgpt-models");
      shim.stdin.write(`${JSON.stringify({ id: "stale-chatgpt-models", method: "model/list", params: {} })}\n`);
      await messages.next(
        (message) => message.method === "test/received" && message.params?.id === "stale-chatgpt-models"
      );
      const accountUpdatedBeforeGatewayRoute = messages.all.filter((message) => message.method === "account/updated").length;
      await expect(
        bridge.switchGatewayRoute({
          route: "gateway",
          accountId: "virtual:gateway",
          gracePeriodMs: 0,
          longTurnPolicy: "defer"
        })
      ).resolves.toMatchObject({ status: "switched" });
      await waitFor(
        () => messages.all.filter((message) => message.method === "account/updated").length > accountUpdatedBeforeGatewayRoute
      );
      await expect(messages.next((message) => message.id === "stale-chatgpt-models")).resolves.toMatchObject({
        result: { data: [{ id: "grok-4-fast" }, { id: "grok-4-latest" }] }
      });
      expect(upstreamRequests).toHaveLength(2);
    } finally {
      bridge?.dispose();
      bridge = undefined;
      shim?.kill("SIGTERM");
      shim = undefined;
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  }, 15_000);

  it("switches a non-fallback Gateway route in place through the turn barrier", async () => {
    const root = path.resolve(__dirname, "..");
    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-gateway-route-"));
    const shimPath = path.join(runtimeDirectory, "codex-app-server-shim.cjs");
    try {
      await copyFile(path.join(root, "runtime", "codex-app-server-shim.cjs"), shimPath);
      await writeFile(
        path.join(runtimeDirectory, "codex-app-server-shim.json"),
        JSON.stringify({
          realCliPath: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs"),
          forceHttpTransport: true,
          gateway: {
            displayName: "Gateway",
            baseUrl: "http://127.0.0.1:1/v1",
            model: "gateway-test-model",
            autoFallbackToChatGpt: false
          }
        }),
        "utf8"
      );
      shim = childProcess.spawn(shimPath, ["app-server"], {
        cwd: root,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const messages = createMessageCollector(shim.stdout);
      shim.stdin.write(`${JSON.stringify({ id: "route-initialize", method: "initialize", params: {} })}\n`);
      await messages.next((message) => message.id === "route-initialize");
      bridge = new CodexHotSwitchBridge(async () => ({
        accessToken: "oauth-token",
        chatgptAccountId: "oauth-account",
        chatgptPlanType: "plus"
      }));
      await waitForSocket(getHotSwitchSocketPath(process.pid));
      await bridge.configureGatewayCredential("gateway-key");

      shim.stdin.write(
        `${JSON.stringify({ id: "route-active-turn", method: "turn/start", params: { threadId: "route-thread", input: [] } })}\n`
      );
      await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "route-thread");
      await expect(
        bridge.switchGatewayRoute({ route: "chatgpt", gracePeriodMs: 0, longTurnPolicy: "defer" })
      ).resolves.toMatchObject({ status: "deferred", reason: "activeOrdinaryTurns" });
      await expect(bridge.getGatewayStatus()).resolves.toMatchObject({ active: true, route: "gateway" });
      shim.stdin.write(`${JSON.stringify({ id: "route-complete-turn", method: "test/complete", params: {} })}\n`);
      await messages.next((message) => message.id === "route-complete-turn");

      await expect(
        bridge.switchGatewayRoute({
          route: "chatgpt",
          chatgptAccessToken: "oauth-token",
          gracePeriodMs: 0,
          longTurnPolicy: "defer"
        })
      ).resolves.toMatchObject({ status: "switched", email: null });
      await expect(bridge.getGatewayStatus()).resolves.toMatchObject({
        active: false,
        route: "chatgpt",
        autoFallbackToChatGpt: false
      });

      await expect(
        bridge.switchGatewayRoute({
          route: "gateway",
          accountId: "virtual:sub2api-gateway",
          gracePeriodMs: 0,
          longTurnPolicy: "defer"
        })
      ).resolves.toMatchObject({ status: "switched", accountId: "virtual:sub2api-gateway" });
      await expect(bridge.getGatewayStatus()).resolves.toMatchObject({ active: true, route: "gateway" });
    } finally {
      bridge?.dispose();
      bridge = undefined;
      shim?.kill("SIGTERM");
      shim = undefined;
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  }, 15_000);

  it("falls back only after a semantic Gateway quota-exhaustion signal and keeps the same HTTP provider", async () => {
    const root = path.resolve(__dirname, "..");
    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-gateway-fallback-"));
    const shimPath = path.join(runtimeDirectory, "codex-app-server-shim.cjs");
    let emitQuotaExhaustion = false;
    const upstream = http.createServer((request, response) => {
      request.resume();
      response.writeHead(emitQuotaExhaustion ? 429 : 502, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          emitQuotaExhaustion
            ? { error: { code: "quota_exhausted", message: "no_available_accounts" } }
            : { error: { message: "temporary upstream failure" } }
        )
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Test upstream did not receive a TCP port");
    }

    try {
      await copyFile(path.join(root, "runtime", "codex-app-server-shim.cjs"), shimPath);
      await writeFile(
        path.join(runtimeDirectory, "codex-app-server-shim.json"),
        JSON.stringify({
          realCliPath: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs"),
          forceHttpTransport: true,
          gateway: {
            displayName: "Gateway",
            baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
            model: "gateway-test-model",
            autoFallbackToChatGpt: true
          }
        }),
        "utf8"
      );
      shim = childProcess.spawn(shimPath, ["app-server"], {
        cwd: root,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const messages = createMessageCollector(shim.stdout);
      shim.stdin.write(`${JSON.stringify({ id: "fallback-initialize", method: "initialize", params: {} })}\n`);
      await messages.next((message) => message.id === "fallback-initialize");
      const runtimeArgs = await messages.next((message) => message.method === "test/runtimeArgs");
      const adapterBaseUrl = readGatewayAdapterBaseUrl(runtimeArgs);
      const activatedLocalAccounts: string[] = [];
      bridge = new CodexHotSwitchBridge(
        async () => ({ accessToken: "unused-token", chatgptAccountId: "account-a", chatgptPlanType: "plus" }),
        async (localAccountId) => {
          activatedLocalAccounts.push(localAccountId);
        }
      );
      await waitForSocket(getHotSwitchSocketPath(process.pid));
      await bridge.configureGatewayCredential("real-gateway-key");

      await expect(postGatewayResponse(adapterBaseUrl)).resolves.toMatchObject({ statusCode: 502 });
      await expect(bridge.getGatewayStatus()).resolves.toMatchObject({
        quotaExhaustionCount: 0,
        route: "gateway"
      });

      emitQuotaExhaustion = true;
      await expect(postGatewayResponse(adapterBaseUrl)).resolves.toMatchObject({ statusCode: 429 });
      await waitFor(async () => (await bridge!.getGatewayStatus()).quotaExhaustionCount === 1);

      await expect(
        bridge.fallbackToChatGpt({
          accessToken: "access-token-b",
          accountId: "account-b",
          localAccountId: "local-b",
          previousAccountId: "account-a",
          previousLocalAccountId: "local-a",
          previousExpectedEmail: "a@example.invalid",
          expectedEmail: "b@example.invalid",
          planType: "plus",
          gracePeriodMs: 0,
          longTurnPolicy: "defer"
        })
      ).resolves.toMatchObject({ status: "switched", accountId: "account-b", email: "b@example.invalid" });
      expect(activatedLocalAccounts).toEqual(["local-b"]);
      await expect(bridge.getGatewayStatus()).resolves.toMatchObject({
        active: false,
        ready: true,
        route: "chatgpt",
        quotaExhaustionCount: 1
      });
      await expect(bridge.getStatus()).resolves.toMatchObject({
        providerKind: "chatgpt",
        gatewayActive: false,
        gatewayConfigured: true,
        gatewayAutoFallbackEnabled: true
      });
    } finally {
      bridge?.dispose();
      bridge = undefined;
      shim?.kill("SIGTERM");
      shim = undefined;
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  }, 15_000);

  it("rolls a failed Gateway fallback back to the previous auth identity and Gateway route", async () => {
    const root = path.resolve(__dirname, "..");
    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-gateway-fallback-rollback-"));
    const shimPath = path.join(runtimeDirectory, "codex-app-server-shim.cjs");
    const upstream = http.createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Test upstream did not receive a TCP port");
    }

    try {
      await copyFile(path.join(root, "runtime", "codex-app-server-shim.cjs"), shimPath);
      await writeFile(
        path.join(runtimeDirectory, "codex-app-server-shim.json"),
        JSON.stringify({
          realCliPath: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs"),
          forceHttpTransport: true,
          gateway: {
            displayName: "Gateway",
            baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
            model: "gateway-test-model",
            autoFallbackToChatGpt: true
          }
        }),
        "utf8"
      );
      shim = childProcess.spawn(shimPath, ["app-server"], {
        cwd: root,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const messages = createMessageCollector(shim.stdout);
      shim.stdin.write(`${JSON.stringify({ id: "fallback-rollback-initialize", method: "initialize", params: {} })}\n`);
      await messages.next((message) => message.id === "fallback-rollback-initialize");
      const restoredContexts: string[] = [];
      bridge = new CodexHotSwitchBridge(
        async () => ({ accessToken: "unused-token", chatgptAccountId: "account-a", chatgptPlanType: "plus" }),
        async () => {
          throw new Error("local account commit failed");
        },
        async (rollbackContextId) => {
          restoredContexts.push(rollbackContextId);
        }
      );
      await waitForSocket(getHotSwitchSocketPath(process.pid));
      await bridge.configureGatewayCredential("real-gateway-key");

      await expect(
        bridge.fallbackToChatGpt({
          accessToken: "access-token-b",
          accountId: "account-b",
          localAccountId: "local-b",
          previousAccountId: "account-a",
          previousExpectedEmail: "a@example.invalid",
          previousAccessToken: "access-token-a",
          previousPlanType: "plus",
          rollbackContextId: "snapshot-a",
          expectedEmail: "b@example.invalid",
          planType: "plus",
          gracePeriodMs: 0,
          longTurnPolicy: "defer"
        })
      ).rejects.toThrow("local account commit failed");
      expect(restoredContexts).toEqual(["snapshot-a"]);
      await expect(bridge.getGatewayStatus()).resolves.toMatchObject({ active: true, route: "gateway" });
      await expect(bridge.getIdentity()).resolves.toMatchObject({
        email: "a@example.invalid",
        managedAccountId: null,
        managedLocalAccountId: null
      });
      const loginAccountIds = messages.all
        .filter((message) => message.method === "test/received" && message.params?.method === "account/login/start")
        .map((message) => message.params?.accountId);
      expect(loginAccountIds).toEqual(["account-b", "account-a"]);
    } finally {
      bridge?.dispose();
      bridge = undefined;
      shim?.kill("SIGTERM");
      shim = undefined;
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  }, 15_000);

  it("backfills active threads when usage attribution activates and writes only compact records", async () => {
    const root = path.resolve(__dirname, "..");
    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-runtime-attribution-"));
    const shimPath = path.join(runtimeDirectory, "codex-app-server-shim.cjs");
    const attributionDirectory = path.join(runtimeDirectory, "account-usage-attribution");
    const fakeCliPath = path.join(root, "test", "fixtures", "fake-codex-app-server.cjs");
    try {
      await copyFile(path.join(root, "runtime", "codex-app-server-shim.cjs"), shimPath);
      await writeFile(
        path.join(runtimeDirectory, "codex-app-server-shim.json"),
        JSON.stringify({
          realCliPath: fakeCliPath,
          forceHttpTransport: true,
          usageAttributionDirectory: attributionDirectory
        }),
        "utf8"
      );
      shim = childProcess.spawn(shimPath, ["app-server"], {
        cwd: root,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const messages = createMessageCollector(shim.stdout);
      shim.stdin.write(`${JSON.stringify({ id: "initialize", method: "initialize", params: {} })}\n`);
      await messages.next((message) => message.id === "initialize");

      bridge = new CodexHotSwitchBridge(async () => ({
        accessToken: "unused-token",
        chatgptAccountId: "account-a",
        chatgptPlanType: "plus"
      }));
      await waitForSocket(getHotSwitchSocketPath(process.pid));

      shim.stdin.write(
        `${JSON.stringify({
          id: "start-attributed-turn",
          method: "turn/start",
          params: { threadId: "thread-a", input: [] }
        })}\n`
      );
      await messages.next((message) => message.id === "start-attributed-turn");
      await bridge.activateUsageAttribution({
        localAccountId: "local-account-a",
        accountId: "workspace-sensitive-marker",
        expectedEmail: "a@example.invalid"
      });

      shim.stdin.write(
        `${JSON.stringify({
          id: "start-later-attributed-turn",
          method: "turn/start",
          params: { threadId: "thread-b", input: [] }
        })}\n`
      );
      await messages.next((message) => message.id === "start-later-attributed-turn");

      const exited = new Promise<void>((resolve) => shim?.once("exit", () => resolve()));
      bridge.dispose();
      bridge = undefined;
      shim.stdin.end();
      shim.kill("SIGTERM");
      await exited;
      const journal = await readFile(path.join(attributionDirectory, `${shim.pid}.jsonl`), "utf8");
      expect(journal).toContain('"th":"thread-a"');
      expect(journal).toContain('"th":"thread-b"');
      expect(journal).toContain('"a":"local-account-a"');
      expect(journal).not.toContain("a@example.invalid");
      expect(journal).not.toContain("workspace-sensitive-marker");
      expect(journal).not.toContain("unused-token");
    } finally {
      bridge?.dispose();
      bridge = undefined;
      if (shim && !shim.killed) {
        shim.stdin.end();
        shim.kill("SIGTERM");
      }
      shim = undefined;
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  });

  it("lists history across runtime provider IDs without overriding explicit provider filters", async () => {
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
    const requests = [
      { id: "history-current", method: "thread/list", params: { cursor: null, modelProviders: null } },
      { id: "history-all", method: "thread/list", params: { cursor: null, modelProviders: [] } },
      {
        id: "history-explicit",
        method: "thread/list",
        params: { cursor: null, modelProviders: ["openai"] }
      },
      { id: "history-omitted", method: "thread/list", params: { cursor: null } }
    ];
    shim.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);

    const received = await Promise.all(
      requests.map((request) =>
        messages.next((message) => message.method === "test/received" && message.params?.id === request.id)
      )
    );
    expect(received.map((message) => message.params?.modelProviders)).toEqual([[], [], ["openai"], undefined]);
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
        operationId: "managed-rollback-status",
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
    await expect(bridge.getOperationStatus("managed-rollback-status")).resolves.toMatchObject({
      operationId: "managed-rollback-status",
      state: "failed",
      message: expect.stringContaining("local commit failed")
    });
    const loginAccountIds = messages.all
      .filter((message) => message.method === "test/received" && message.params?.method === "account/login/start")
      .map((message) => message.params?.accountId);
    expect(loginAccountIds).toEqual(["account-b", "account-a"]);
  }, 15_000);

  it("rolls back from an in-memory auth snapshot when the previous account is no longer managed", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "snapshot-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "snapshot-initialize");
    shim.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    const refreshAuth = vi.fn();
    const activations: string[] = [];
    const restoredContexts: string[] = [];
    bridge = new CodexHotSwitchBridge(
      refreshAuth,
      async (localAccountId) => {
        activations.push(localAccountId);
        throw new Error("local commit failed");
      },
      async (rollbackContextId) => {
        restoredContexts.push(rollbackContextId);
      }
    );
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    await expect(
      bridge.switchAccount({
        accessToken: "access-token-b",
        accountId: "account-b",
        localAccountId: "local-b",
        previousAccountId: "account-a",
        previousExpectedEmail: "a@example.invalid",
        previousAccessToken: "snapshot-access-token-a",
        previousPlanType: "plus",
        rollbackContextId: "snapshot-context-a",
        expectedEmail: "b@example.invalid",
        planType: "plus",
        gracePeriodMs: 25,
        longTurnPolicy: "defer"
      })
    ).rejects.toThrow("local commit failed");
    expect(refreshAuth).not.toHaveBeenCalled();
    expect(activations).toEqual(["local-b"]);
    expect(restoredContexts).toEqual(["snapshot-context-a"]);
    const loginAccountIds = messages.all
      .filter((message) => message.method === "test/received" && message.params?.method === "account/login/start")
      .map((message) => message.params?.accountId);
    expect(loginAccountIds).toEqual(["account-b", "account-a"]);
    await expect(bridge.getIdentity()).resolves.toMatchObject({
      accountType: "chatgpt",
      email: "a@example.invalid",
      externalAuthActive: true,
      managedAccountId: null,
      managedLocalAccountId: null
    });
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

  it("does not resurrect a completed turn when the turn/start response arrives last", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "late-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "late-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({ id: "reorder-next", method: "test/reorderNextTurnStartResponse", params: {} })}\n`
    );
    await messages.next((message) => message.id === "reorder-next");
    shim.stdin.write(
      `${JSON.stringify({ id: "late-turn", method: "turn/start", params: { threadId: "late-thread", input: [] } })}\n`
    );
    await messages.next((message) => message.id === "late-turn");

    await expect(bridge.getStatus()).resolves.toMatchObject({ activeTurns: 0 });
  }, 15_000);

  it("reconciles an already inactive turn and continues the account switch", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "inactive-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "inactive-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({ id: "inactive-turn", method: "turn/start", params: { threadId: "inactive-thread", input: [] } })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "inactive-thread"
    );
    shim.stdin.write(`${JSON.stringify({ id: "forget-active", method: "test/forget-active", params: {} })}\n`);
    await messages.next((message) => message.id === "forget-active");

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
        longTurnPolicy: "interruptAndContinue"
      })
    ).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      activeTurns: 0,
      interruptedTurns: 0,
      continuedThreads: 0
    });
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

  it("leaves multi-agent subagent recovery to its parent", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "subagent-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "subagent-initialize");
    shim.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({
        id: "subagent-original-turn",
        method: "turn/start",
        params: { threadId: "subagent-thread", input: [] }
      })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "subagent-thread"
    );
    shim.stdin.write(
      `${JSON.stringify({ id: "mark-subagent", method: "test/markSubagent", params: { threadId: "subagent-thread" } })}\n`
    );
    await messages.next((message) => message.id === "mark-subagent");

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
        gracePeriodMs: 0,
        longTurnPolicy: "interruptAndContinue"
      })
    ).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      interruptedTurns: 1,
      continuedThreads: 0
    });

    expect(
      messages.all.some(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "thread/read" &&
          message.params?.threadId === "subagent-thread"
      )
    ).toBe(true);
    expect(
      messages.all.some(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "subagent-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).toBe(false);
  }, 15_000);

  it("resynchronizes a replaced active turn before interrupting and continuing it", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "resync-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "resync-initialize");
    shim.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({
        id: "resync-original-turn",
        method: "turn/start",
        params: { threadId: "resync-thread", input: [] }
      })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "resync-thread");
    shim.stdin.write(`${JSON.stringify({ id: "resync-replace", method: "test/replaceActiveTurn", params: {} })}\n`);
    await messages.next((message) => message.id === "resync-replace");

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
        gracePeriodMs: 0,
        longTurnPolicy: "interruptAndContinue"
      })
    ).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      interruptedTurns: 1,
      continuedThreads: 1
    });

    const interruptTurnIds = messages.all
      .filter((message) => message.method === "test/received" && message.params?.method === "turn/interrupt")
      .map((message) => message.params?.turnId);
    expect(interruptTurnIds).toEqual(["turn-1", "turn-2"]);
    await expect(
      messages.next(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "resync-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).resolves.toMatchObject({ params: { runtimeAccountId: "account-b", inputText: "Continue." } });
  }, 15_000);

  it("continues a recently quota-exhausted ordinary thread after an emergency switch", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "quota-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "quota-initialize");

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({
        id: "quota-original-turn",
        method: "turn/start",
        params: { threadId: "quota-thread", input: [] }
      })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "quota-thread");
    shim.stdin.write(
      `${JSON.stringify({ id: "quota-failed", method: "test/failUsageLimitNotification", params: {} })}\n`
    );
    await messages.next((message) => message.id === "quota-failed");
    await expect(bridge.getStatus()).resolves.toMatchObject({
      activeTurns: 0,
      recentUsageLimitedThreads: 1,
      usageLimitExhaustionReady: true,
      usageLimitExhaustionBatchId: 1,
      observedUsageLimitFailures: 1,
      recoveredUsageLimitedThreads: 0
    });

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
        gracePeriodMs: 0,
        longTurnPolicy: "interruptAndContinue",
        recoverRecentUsageLimitedTurns: true
      })
    ).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      interruptedTurns: 0,
      continuedThreads: 1,
      activeTurns: 1
    });

    await expect(
      messages.next(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "quota-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).resolves.toMatchObject({
      params: {
        runtimeAccountId: "account-b",
        inputText: "Continue."
      }
    });
    await expect(bridge.getStatus()).resolves.toMatchObject({
      recentUsageLimitedThreads: 0,
      usageLimitExhaustionReady: false,
      usageLimitExhaustionBatchId: 0,
      observedUsageLimitFailures: 1,
      recoveredUsageLimitedThreads: 1
    });

    shim.stdin.write(`${JSON.stringify({ id: "quota-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "quota-complete");
  }, 15_000);

  it("cancels only the exhaustion decision when a peer finishes normally and still recovers the stopped thread", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "mixed-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "mixed-initialize");

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({ id: "mixed-failed-turn", method: "turn/start", params: { threadId: "mixed-failed", input: [] } })}\n`
    );
    shim.stdin.write(
      `${JSON.stringify({ id: "mixed-complete-turn", method: "turn/start", params: { threadId: "mixed-complete", input: [] } })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "mixed-failed");
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "mixed-complete"
    );

    shim.stdin.write(`${JSON.stringify({ id: "mixed-fail", method: "test/failUsageLimit", params: {} })}\n`);
    await messages.next((message) => message.id === "mixed-fail");
    shim.stdin.write(`${JSON.stringify({ id: "mixed-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "mixed-complete");

    await expect(bridge.getStatus()).resolves.toMatchObject({
      activeTurns: 0,
      recentUsageLimitedThreads: 1,
      usageLimitExhaustionReady: false,
      usageLimitExhaustionBatchId: 0
    });

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
        gracePeriodMs: 0,
        longTurnPolicy: "defer",
        recoverRecentUsageLimitedTurns: true
      })
    ).resolves.toMatchObject({ status: "switched", continuedThreads: 1 });
    await expect(
      messages.next(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "mixed-failed" &&
          message.params?.recoveryMetadata === "true"
      )
    ).resolves.toMatchObject({ params: { runtimeAccountId: "account-b", inputText: "Continue." } });
  }, 15_000);

  it("does not recreate a canceled exhaustion batch from a delayed terminal failure", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "late-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "late-initialize");

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    // Start the peer first so test/complete finishes it while the delayed
    // usage-limit notification belongs to the second, still-active thread.
    shim.stdin.write(
      `${JSON.stringify({ id: "late-peer-turn", method: "turn/start", params: { threadId: "late-peer", input: [] } })}\n`
    );
    shim.stdin.write(
      `${JSON.stringify({ id: "late-failed-turn", method: "turn/start", params: { threadId: "late-failed", input: [] } })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "late-peer");
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "late-failed");

    shim.stdin.write(
      `${JSON.stringify({ id: "late-notify", method: "test/notifyUsageLimit", params: { threadId: "late-failed" } })}\n`
    );
    await messages.next((message) => message.id === "late-notify");
    shim.stdin.write(`${JSON.stringify({ id: "late-peer-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "late-peer-complete");
    shim.stdin.write(`${JSON.stringify({ id: "late-failed-terminal", method: "test/failUsageLimit", params: {} })}\n`);
    await messages.next((message) => message.id === "late-failed-terminal");

    await expect(bridge.getStatus()).resolves.toMatchObject({
      activeTurns: 0,
      recentUsageLimitedThreads: 1,
      usageLimitExhaustionReady: false,
      usageLimitExhaustionBatchId: 0
    });

    // A new turn explicitly resets the observation scope, so a future real
    // exhaustion can form a fresh batch rather than being suppressed forever.
    shim.stdin.write(
      `${JSON.stringify({ id: "late-fresh-turn", method: "turn/start", params: { threadId: "late-fresh", input: [] } })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "late-fresh");
    shim.stdin.write(`${JSON.stringify({ id: "late-fresh-fail", method: "test/failUsageLimit", params: {} })}\n`);
    await messages.next((message) => message.id === "late-fresh-fail");
    await expect(bridge.getStatus()).resolves.toMatchObject({
      activeTurns: 0,
      recentUsageLimitedThreads: 2,
      usageLimitExhaustionReady: true,
      usageLimitExhaustionBatchId: 1
    });
  }, 15_000);

  it("marks a batch ready only after every originally active conversation reaches quota exhaustion", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "batch-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "batch-initialize");

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({ id: "batch-turn-a", method: "turn/start", params: { threadId: "batch-a", input: [] } })}\n`
    );
    shim.stdin.write(
      `${JSON.stringify({ id: "batch-turn-b", method: "turn/start", params: { threadId: "batch-b", input: [] } })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "batch-a");
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "batch-b");

    shim.stdin.write(`${JSON.stringify({ id: "batch-fail-a", method: "test/failUsageLimit", params: {} })}\n`);
    await messages.next((message) => message.id === "batch-fail-a");
    await expect(bridge.getStatus()).resolves.toMatchObject({
      activeTurns: 1,
      recentUsageLimitedThreads: 1,
      usageLimitExhaustionReady: false,
      usageLimitExhaustionBatchId: 0
    });

    shim.stdin.write(`${JSON.stringify({ id: "batch-fail-b", method: "test/failUsageLimit", params: {} })}\n`);
    await messages.next((message) => message.id === "batch-fail-b");
    await expect(bridge.getStatus()).resolves.toMatchObject({
      activeTurns: 0,
      recentUsageLimitedThreads: 2,
      usageLimitExhaustionReady: true,
      usageLimitExhaustionBatchId: 1
    });
  }, 15_000);

  it("continues a quota-exhausted thread when turn/start returns a structured RPC error", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "quota-response-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "quota-response-initialize");

    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({ id: "quota-response-prepare", method: "test/failNextTurnStartWithUsageLimit", params: {} })}\n`
    );
    await messages.next((message) => message.id === "quota-response-prepare");
    shim.stdin.write(
      `${JSON.stringify({
        id: "quota-response-turn",
        method: "turn/start",
        params: { threadId: "quota-response-thread", input: [] }
      })}\n`
    );
    await messages.next(
      (message) => message.id === "quota-response-turn" && message.error?.data?.codexErrorInfo === "usageLimitExceeded"
    );
    await expect(bridge.getStatus()).resolves.toMatchObject({
      activeTurns: 0,
      recentUsageLimitedThreads: 1,
      observedUsageLimitFailures: 1
    });

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
        gracePeriodMs: 0,
        longTurnPolicy: "interruptAndContinue",
        recoverRecentUsageLimitedTurns: true
      })
    ).resolves.toMatchObject({ status: "switched", continuedThreads: 1, activeTurns: 1 });
    await expect(
      messages.next(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "quota-response-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).resolves.toMatchObject({ params: { runtimeAccountId: "account-b", inputText: "Continue." } });
    await expect(bridge.getStatus()).resolves.toMatchObject({
      recentUsageLimitedThreads: 0,
      observedUsageLimitFailures: 1,
      recoveredUsageLimitedThreads: 1
    });

    shim.stdin.write(`${JSON.stringify({ id: "quota-response-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "quota-response-complete");
  }, 15_000);

  it("waits before retrying a model-capacity RPC rejection", async () => {
    const root = path.resolve(__dirname, "..");
    shim = childProcess.spawn(path.join(root, "runtime", "codex-app-server-shim.cjs"), ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs"),
        CODEX_ACCOUNTS_CAPACITY_RECOVERY_DELAY_MS: "120"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "capacity-rpc-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-rpc-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(`${JSON.stringify({ id: "capacity-rpc-prepare", method: "test/failNextTurnStartWithCapacity", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-rpc-prepare");
    shim.stdin.write(
      `${JSON.stringify({
        id: "capacity-rpc-turn",
        method: "turn/start",
        params: { threadId: "capacity-rpc-thread", input: [] }
      })}\n`
    );
    await messages.next(
      (message) =>
        message.id === "capacity-rpc-turn" &&
        message.params?.method === undefined &&
        message.params?.threadId === undefined &&
        message.params?.runtimeAccountId === undefined
    );
    await expect(bridge.getStatus()).resolves.toMatchObject({
      capacityRecoveryThreads: 1,
      capacityRecoveryWaitingThreads: 1
    });
    await sleep(40);
    expect(
      messages.all.some(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "capacity-rpc-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).toBe(false);

    await expect(
      messages.next(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "capacity-rpc-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).resolves.toMatchObject({ params: { inputText: "Continue." } });
    await expect(bridge.getStatus()).resolves.toMatchObject({
      capacityRecoveryThreads: 0,
      capacityRecoveryWaitingThreads: 0,
      activeTurns: 1
    });
    shim.stdin.write(`${JSON.stringify({ id: "capacity-rpc-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-rpc-complete");

    shim.stdin.write(
      `${JSON.stringify({
        id: "capacity-notification-start",
        method: "turn/start",
        params: { threadId: "capacity-notification-thread", input: [] }
      })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "capacity-notification-thread"
    );
    shim.stdin.write(
      `${JSON.stringify({
        id: "capacity-notification-fail",
        method: "test/failCapacityNotification",
        params: { errorField: "camel" }
      })}\n`
    );
    await messages.next((message) => message.id === "capacity-notification-fail");
    await expect(bridge.getStatus()).resolves.toMatchObject({
      capacityRecoveryThreads: 1,
      capacityRecoveryWaitingThreads: 1
    });
    await expect(
      messages.next(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "capacity-notification-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).resolves.toMatchObject({ params: { inputText: "Continue." } });
    shim.stdin.write(`${JSON.stringify({ id: "capacity-notification-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-notification-complete");

    shim.stdin.write(`${JSON.stringify({ id: "capacity-clear-prepare", method: "test/failNextTurnStartWithCapacity", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-clear-prepare");
    shim.stdin.write(
      `${JSON.stringify({ id: "capacity-clear-failed", method: "turn/start", params: { threadId: "capacity-clear-thread", input: [] } })}\n`
    );
    await messages.next((message) => message.id === "capacity-clear-failed" && message.params === undefined);
    shim.stdin.write(
      `${JSON.stringify({ id: "capacity-clear-new", method: "turn/start", params: { threadId: "capacity-clear-thread", input: [] } })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "capacity-clear-thread"
    );
    await expect(bridge.getStatus()).resolves.toMatchObject({
      capacityRecoveryThreads: 0,
      capacityRecoveryWaitingThreads: 0
    });
    shim.stdin.write(`${JSON.stringify({ id: "capacity-clear-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-clear-complete");
    await sleep(160);
    expect(
      messages.all.some(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "capacity-clear-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).toBe(false);
  }, 15_000);

  it("keeps capacity retries independent and restarts the timer after a retry is rejected", async () => {
    const root = path.resolve(__dirname, "..");
    shim = childProcess.spawn(path.join(root, "runtime", "codex-app-server-shim.cjs"), ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs"),
        CODEX_ACCOUNTS_CAPACITY_RECOVERY_DELAY_MS: "100"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "capacity-independent-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-independent-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    for (const [id, threadId] of [
      ["capacity-independent-start-a", "capacity-thread-a"],
      ["capacity-independent-start-b", "capacity-thread-b"]
    ] as const) {
      shim.stdin.write(`${JSON.stringify({ id, method: "turn/start", params: { threadId, input: [] } })}\n`);
      await messages.next((message) => message.method === "turn/started" && message.params?.threadId === threadId);
    }
    shim.stdin.write(`${JSON.stringify({ id: "capacity-independent-fail-a", method: "test/failCapacity", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-independent-fail-a");
    shim.stdin.write(`${JSON.stringify({ id: "capacity-independent-fail-b", method: "test/failCapacity", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-independent-fail-b");
    await expect(bridge.getStatus()).resolves.toMatchObject({
      capacityRecoveryThreads: 2,
      capacityRecoveryWaitingThreads: 2
    });
    const firstRecoveryThreads = new Set<string>();
    while (firstRecoveryThreads.size < 2) {
      const message = await messages.next(
        (candidate) =>
          candidate.method === "test/received" &&
          candidate.params?.method === "turn/start" &&
          candidate.params?.recoveryMetadata === "true" &&
          !firstRecoveryThreads.has(candidate.params?.threadId ?? "")
      );
      firstRecoveryThreads.add(message.params?.threadId ?? "");
    }
    expect(firstRecoveryThreads).toEqual(new Set(["capacity-thread-a", "capacity-thread-b"]));
    const firstThreadARecoveryCount = messages.all.filter(
      (message) =>
        message.method === "test/received" &&
        message.params?.method === "turn/start" &&
        message.params?.threadId === "capacity-thread-a" &&
        message.params?.recoveryMetadata === "true"
    ).length;

    // The next timer retry is rejected; it must create a fresh waiting entry
    // instead of disappearing with the failed internal turn/start.
    shim.stdin.write(
      `${JSON.stringify({ id: "capacity-repeat-prepare", method: "test/failNextTurnStartWithCapacity", params: {} })}\n`
    );
    await messages.next((message) => message.id === "capacity-repeat-prepare");
    shim.stdin.write(`${JSON.stringify({ id: "capacity-repeat-fail-a", method: "test/failCapacity", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-repeat-fail-a");
    await waitFor(
      () =>
        messages.all.filter(
          (message) =>
            message.method === "test/received" &&
            message.params?.method === "turn/start" &&
            message.params?.threadId === "capacity-thread-a" &&
            message.params?.recoveryMetadata === "true"
        ).length >= firstThreadARecoveryCount + 1
    );
    await expect(bridge.getStatus()).resolves.toMatchObject({
      capacityRecoveryThreads: 1,
      capacityRecoveryWaitingThreads: 1
    });
    await waitFor(
      () =>
        messages.all.filter(
          (message) =>
            message.method === "test/received" &&
            message.params?.method === "turn/start" &&
            message.params?.threadId === "capacity-thread-a" &&
            message.params?.recoveryMetadata === "true"
        ).length >= firstThreadARecoveryCount + 2
    );
    shim.stdin.write(`${JSON.stringify({ id: "capacity-repeat-complete-a", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-repeat-complete-a");
    shim.stdin.write(`${JSON.stringify({ id: "capacity-repeat-complete-b", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-repeat-complete-b");
  }, 15_000);

  it("lets an in-flight seamless switch claim a waiting capacity recovery", async () => {
    const root = path.resolve(__dirname, "..");
    shim = childProcess.spawn(path.join(root, "runtime", "codex-app-server-shim.cjs"), ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs"),
        CODEX_ACCOUNTS_CAPACITY_RECOVERY_DELAY_MS: "140"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "capacity-switch-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-switch-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(`${JSON.stringify({ id: "capacity-switch-start", method: "turn/start", params: { threadId: "capacity-switch-thread", input: [] } })}\n`);
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "capacity-switch-thread");
    shim.stdin.write(`${JSON.stringify({ id: "capacity-switch-fail", method: "test/failCapacity", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-switch-fail");

    const switchResult = bridge.switchAccount({
      accessToken: "access-token-b",
      accountId: "account-b",
      localAccountId: "local-b",
      previousAccountId: "account-a",
      previousLocalAccountId: "local-a",
      previousExpectedEmail: "a@example.invalid",
      expectedEmail: "b@example.invalid",
      planType: "plus",
      gracePeriodMs: 0,
      longTurnPolicy: "interruptAndContinue"
    });
    await expect(
      messages.next(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "capacity-switch-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).resolves.toMatchObject({ params: { runtimeAccountId: "account-b", inputText: "Continue." } });
    await expect(switchResult).resolves.toMatchObject({
      status: "switched",
      continuedThreads: 1,
      activeTurns: 1
    });
    await expect(bridge.getStatus()).resolves.toMatchObject({
      capacityRecoveryThreads: 0,
      capacityRecoveryWaitingThreads: 0
    });
    shim.stdin.write(`${JSON.stringify({ id: "capacity-switch-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-switch-complete");
  }, 15_000);

  it("starts a new capacity timer when the switch continuation is rejected", async () => {
    const root = path.resolve(__dirname, "..");
    shim = childProcess.spawn(path.join(root, "runtime", "codex-app-server-shim.cjs"), ["app-server"], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_ACCOUNTS_REAL_CLI: path.join(root, "test", "fixtures", "fake-codex-app-server.cjs"),
        CODEX_ACCOUNTS_CAPACITY_RECOVERY_DELAY_MS: "100"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const messages = createMessageCollector(shim.stdout);
    shim.stdin.write(`${JSON.stringify({ id: "capacity-switch-retry-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-switch-retry-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({ id: "capacity-switch-retry-start", method: "turn/start", params: { threadId: "capacity-switch-retry-thread", input: [] } })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "capacity-switch-retry-thread"
    );
    shim.stdin.write(`${JSON.stringify({ id: "capacity-switch-retry-fail", method: "test/failCapacity", params: {} })}\n`);
    await messages.next((message) => message.id === "capacity-switch-retry-fail");
    shim.stdin.write(
      `${JSON.stringify({ id: "capacity-switch-retry-prepare", method: "test/failNextTurnStartWithCapacity", params: {} })}\n`
    );
    await messages.next((message) => message.id === "capacity-switch-retry-prepare");

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
        gracePeriodMs: 0,
        longTurnPolicy: "interruptAndContinue"
      })
    ).resolves.toMatchObject({ status: "switched", continuedThreads: 0, activeTurns: 0 });
    await expect(bridge.getStatus()).resolves.toMatchObject({
      capacityRecoveryThreads: 1,
      capacityRecoveryWaitingThreads: 1
    });

    await expect(
      messages.next(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.threadId === "capacity-switch-retry-thread" &&
          message.params?.recoveryMetadata === "true"
      )
    ).resolves.toMatchObject({ params: { inputText: "Continue." } });
  }, 15_000);

  it("does not continue a stale quota failure after newer work starts on the same thread", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "stale-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "stale-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({ id: "stale-failed-turn", method: "turn/start", params: { threadId: "stale-thread", input: [] } })}\n`
    );
    await messages.next((message) => message.method === "turn/started" && message.params?.threadId === "stale-thread");
    shim.stdin.write(`${JSON.stringify({ id: "stale-failed", method: "test/failUsageLimit", params: {} })}\n`);
    await messages.next((message) => message.id === "stale-failed");

    shim.stdin.write(
      `${JSON.stringify({ id: "stale-newer-turn", method: "turn/start", params: { threadId: "stale-thread", input: [] } })}\n`
    );
    await messages.next((message) => message.id === "stale-newer-turn");
    shim.stdin.write(`${JSON.stringify({ id: "stale-newer-complete", method: "test/complete", params: {} })}\n`);
    await messages.next((message) => message.id === "stale-newer-complete");

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
        gracePeriodMs: 0,
        longTurnPolicy: "interruptAndContinue",
        recoverRecentUsageLimitedTurns: true
      })
    ).resolves.toMatchObject({ status: "switched", continuedThreads: 0, activeTurns: 0 });
  }, 15_000);

  it("pauses and resumes a recently quota-exhausted goal instead of sending an ordinary Continue", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "quota-goal-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "quota-goal-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({
        id: "quota-goal-set",
        method: "thread/goal/set",
        params: { threadId: "quota-goal-thread", objective: "Keep working", status: "active" }
      })}\n`
    );
    await messages.next((message) => message.id === "quota-goal-set");
    shim.stdin.write(
      `${JSON.stringify({ id: "quota-goal-turn", method: "turn/start", params: { threadId: "quota-goal-thread", input: [] } })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "quota-goal-thread"
    );
    shim.stdin.write(
      `${JSON.stringify({ id: "quota-goal-failed", method: "test/failUsageLimitNotification", params: {} })}\n`
    );
    await messages.next((message) => message.id === "quota-goal-failed");

    const switchResult = bridge.switchAccount({
      accessToken: "access-token-b",
      accountId: "account-b",
      localAccountId: "local-b",
      previousAccountId: "account-a",
      previousLocalAccountId: "local-a",
      previousExpectedEmail: "a@example.invalid",
      expectedEmail: "b@example.invalid",
      planType: "plus",
      gracePeriodMs: 0,
      longTurnPolicy: "interruptAndContinue",
      recoverRecentUsageLimitedTurns: true
    });
    await messages.next(
      (message) =>
        message.method === "thread/goal/updated" &&
        message.params?.threadId === "quota-goal-thread" &&
        message.params?.goal?.status === "paused"
    );
    await messages.next(
      (message) =>
        message.method === "thread/goal/updated" &&
        message.params?.threadId === "quota-goal-thread" &&
        message.params?.goal?.status === "active"
    );
    await expect(switchResult).resolves.toMatchObject({
      status: "switched",
      accountId: "account-b",
      continuedThreads: 0,
      activeTurns: 0
    });
    await expect(bridge.getStatus()).resolves.toMatchObject({
      recentUsageLimitedThreads: 0,
      observedUsageLimitFailures: 1,
      recoveredUsageLimitedThreads: 0,
      resumedUsageLimitedGoals: 1
    });
    expect(
      messages.all.some(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.recoveryMetadata === "true"
      )
    ).toBe(false);
  }, 15_000);

  it("reactivates a usage-limited goal after an emergency switch without an ordinary Continue", async () => {
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
    shim.stdin.write(`${JSON.stringify({ id: "usage-goal-initialize", method: "initialize", params: {} })}\n`);
    await messages.next((message) => message.id === "usage-goal-initialize");
    bridge = new CodexHotSwitchBridge(async () => ({
      accessToken: "rollback-token-a",
      chatgptAccountId: "account-a",
      chatgptPlanType: "plus"
    }));
    await waitForSocket(getHotSwitchSocketPath(process.pid));

    shim.stdin.write(
      `${JSON.stringify({
        id: "usage-goal-set",
        method: "thread/goal/set",
        params: { threadId: "usage-goal-thread", objective: "Keep working", status: "active" }
      })}\n`
    );
    await messages.next((message) => message.id === "usage-goal-set");
    await messages.next(
      (message) =>
        message.method === "thread/goal/updated" &&
        message.params?.threadId === "usage-goal-thread" &&
        message.params?.goal?.status === "active"
    );
    shim.stdin.write(
      `${JSON.stringify({
        id: "usage-goal-turn",
        method: "turn/start",
        params: { threadId: "usage-goal-thread", input: [] }
      })}\n`
    );
    await messages.next(
      (message) => message.method === "turn/started" && message.params?.threadId === "usage-goal-thread"
    );
    shim.stdin.write(
      `${JSON.stringify({ id: "usage-goal-failed", method: "test/failUsageLimitNotification", params: {} })}\n`
    );
    await messages.next((message) => message.id === "usage-goal-failed");
    shim.stdin.write(
      `${JSON.stringify({
        id: "usage-goal-status",
        method: "test/setGoalUsageLimited",
        params: { threadId: "usage-goal-thread" }
      })}\n`
    );
    await messages.next(
      (message) =>
        message.method === "thread/goal/updated" &&
        message.params?.threadId === "usage-goal-thread" &&
        message.params?.goal?.status === "usageLimited"
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
      gracePeriodMs: 0,
      longTurnPolicy: "interruptAndContinue",
      recoverRecentUsageLimitedTurns: true
    });
    await messages.next(
      (message) =>
        message.method === "thread/goal/updated" &&
        message.params?.threadId === "usage-goal-thread" &&
        message.params?.goal?.status === "active"
    );
    await expect(switchResult).resolves.toMatchObject({ status: "switched", continuedThreads: 0 });
    await expect(bridge.getStatus()).resolves.toMatchObject({
      recentUsageLimitedThreads: 0,
      observedUsageLimitFailures: 1,
      recoveredUsageLimitedThreads: 0,
      resumedUsageLimitedGoals: 1
    });
    expect(
      messages.all.some(
        (message) =>
          message.method === "test/received" &&
          message.params?.method === "turn/start" &&
          message.params?.recoveryMetadata === "true"
      )
    ).toBe(false);
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

function readGatewayAdapterBaseUrl(message: Message): string {
  const providerConfig = message.params?.args?.find((arg) => arg.includes("base_url="));
  const baseUrl = providerConfig && /base_url="([^"\\]+)"/u.exec(providerConfig)?.[1];
  if (!baseUrl) {
    throw new Error("The fake app-server did not receive a Gateway base URL");
  }
  return baseUrl;
}

async function postGatewayResponse(baseUrl: string): Promise<{ statusCode: number; body: string }> {
  const target = new URL("responses", `${baseUrl.replace(/\/+$/u, "")}/`);
  const body = JSON.stringify({ model: "gateway-test-model", input: "test", stream: false });
  return new Promise((resolve, reject) => {
    const request = http.request(
      target,
      {
        method: "POST",
        headers: {
          authorization: "Bearer synthetic-oauth-token",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    request.once("error", reject);
    request.end(body);
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

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
