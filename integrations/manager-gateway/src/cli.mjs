#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { createManagerClient } from "./manager-client.mjs";
import { createProvider } from "./providers.mjs";
import { GatewaySessionManager } from "./session-manager.mjs";
import { createGatewayServer, listen } from "./server.mjs";
import { WorktreeManager } from "./worktree-manager.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
} else {
  await start();
}

async function start() {
  const config = loadConfig();
  const manager = config.manager.token
    ? createManagerClient({
        baseUrl: config.manager.baseUrl,
        token: config.manager.token,
        timeoutMs: config.manager.timeoutMs
      })
    : undefined;
  const sessions = new GatewaySessionManager({
    provider: createProvider(config, { manager }),
    manager,
    workspaces: new WorktreeManager({
      projectRoot: config.codex.projectRoot,
      stateDir: config.server.stateDir
    }),
    maxSessions: config.maxSessions
  });
  const server = createGatewayServer({ sessions, config });
  const address = await listen(server, config.server.host, config.server.port);
  console.log(`[manager-gateway] listening on ${address.host}:${address.port}`);

  let stopping = false;
  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    server.close(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function printHelp() {
  console.log(`manager-gateway

环境变量：
  MANAGER_GATEWAY_HOST              监听地址，默认 127.0.0.1
  MANAGER_GATEWAY_PORT              监听端口，默认 43118
  MANAGER_GATEWAY_TOKEN             非回环监听时必需
  MANAGER_CONTROL_URL               Manager 控制接口地址
  MANAGER_CONTROL_TOKEN             Manager 控制令牌
  MANAGER_GATEWAY_CODEX_BINARY      Codex executable，默认 codex
  MANAGER_GATEWAY_CODEX_HOME        Codex Home
  MANAGER_GATEWAY_PROJECT_ROOT      develop 模式项目根目录
  WORKBENCH_DATA_URL                Workbench 数据服务地址，默认 http://127.0.0.1:43119
  WORKBENCH_DATA_TOKEN              Workbench 数据服务令牌（可选）
  MANAGER_GATEWAY_RESEARCH_BASE_URL research 模式 OpenAI-compatible 地址
  MANAGER_GATEWAY_RESEARCH_API_KEY  research provider key
  MANAGER_GATEWAY_MAX_SESSIONS      并行 session 上限，默认 4
`);
}
