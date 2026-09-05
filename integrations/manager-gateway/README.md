# Manager Gateway

Manager 侧的独立 task/session Gateway。Research Workbench 只需配置 Gateway Base URL；Gateway 负责 session 生命周期、Codex runner、研究 provider 和 Manager 账号协调。Workbench 数据由独立的数据服务负责，Gateway 不打开 Workbench SQLite。

## 当前范围

- `POST /v1/sessions`：创建 `research` 或 `develop` session。
- `POST /v1/sessions/:id/messages`：在已有 session 中追加一轮对话，复用 Codex thread/上下文；只有显式创建新 session 才开始新会话。
- `GET /v1/sessions`、`GET /v1/sessions/:id`：读取 session 状态。
- `DELETE /v1/sessions/:id`：删除已结束的历史 session；运行中、恢复中或仍有未处理 develop worktree 的 session 不允许删除。
- `GET /v1/sessions/:id/events`：通过 SSE 读取事件。
- `POST /v1/sessions/:id/cancel`：取消 session。
- `POST /v1/accounts/switch`：手动强制中断活动 session、切换 Manager 账号并恢复可恢复 session。
- `GET /v1/recovery`：读取额度耗尽批次和恢复状态。
- `POST /v1/sessions/:id/apply`、`POST /v1/sessions/:id/discard`：对 develop session 的隔离 worktree 执行显式应用或丢弃。
- `GET /v1/capabilities`、`GET /healthz`：能力和健康检查。
- `GET /v1/manager/accounts`、`GET /v1/manager/status`：向受控客户端提供脱敏的 Manager 账号/状态摘要。
- 多 session 并行，使用 `MANAGER_GATEWAY_MAX_SESSIONS` 限制并发数。
- 同一活动账号的 session 在额度耗尽时先等待该批次相关任务终态；只对明确因额度耗尽结束的 session 切换一次并恢复，其他已结束 session 不会被重复执行，并优先使用原 Codex thread 恢复。
- 自动恢复会记录本 session 已尝试的账号，全部候选不可用时进入可解释的 `recovery_failed` 状态，不循环切号。
- develop session 使用独立 Git worktree；Codex 不直接写入 `MANAGER_GATEWAY_PROJECT_ROOT`，结果必须由客户端显式 apply 或 discard。

Manager 账号切换通过 Manager loopback control API 完成；Gateway 本身不持有账号凭据。每次 Codex 任务启动前，Gateway 会从 Manager control API 读取当前 resident Codex adapter 的临时地址和令牌，因此不会写死 Manager 重启后可能变化的随机端口。Feishu Helper 与 Workbench 浏览器都只需连接 Gateway 的固定外部端口；Feishu 不再直接依赖本机 Codex app-server thread。

Gateway 的账号控制能力依赖 Manager extension 在线，并依赖其已启用的外部控制接口。Feishu Helper 通过同一 task/session API 接入，不直接连接 Codex app-server。

## 配置

最小开发配置：

```dotenv
MANAGER_GATEWAY_HOST=127.0.0.1
MANAGER_GATEWAY_PORT=43118
MANAGER_CONTROL_URL=http://127.0.0.1:43117
# 也可以直接通过 Manager 已有的 CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN 环境文件提供令牌
MANAGER_CONTROL_TOKEN=<manager-control-token>
MANAGER_GATEWAY_CODEX_BINARY=<与 Manager extension 使用同版本的 Codex executable>
MANAGER_GATEWAY_CODEX_HOME=<absolute-codex-home-used-by-manager-extension>
MANAGER_GATEWAY_PROJECT_ROOT=<absolute-workbench-project-root>
MANAGER_GATEWAY_STATE_DIR=<absolute-gateway-state-dir>
WORKBENCH_DATA_URL=http://127.0.0.1:43119
# 可选：数据服务非回环监听时填写与数据服务相同的独立令牌
# WORKBENCH_DATA_TOKEN=<workbench-data-token>
# 可选：配置后 research 改用 OpenAI-compatible provider；省略则使用 Manager 管控的 Codex
MANAGER_GATEWAY_RESEARCH_BASE_URL=http://127.0.0.1:11434/v1
MANAGER_GATEWAY_RESEARCH_MODEL=<local-model>
MANAGER_GATEWAY_MAX_SESSIONS=4
```

浏览器对外连接使用固定端口：默认 Gateway 为 `43118`，Manager control API 为 `43117`。不要把 `MANAGER_GATEWAY_PORT` 配置为 `0`；Manager runtime 内部可能使用随机 loopback adapter 端口，但该地址只供 Manager/Codex 内部使用，不写入 Workbench 配置。

`MANAGER_GATEWAY_CODEX_BINARY` 必须与共享 `MANAGER_GATEWAY_CODEX_HOME` 的 Manager/Codex 版本一致。不同版本共用 `models_cache.json` 可能出现 `supports_parallel_tool_calls` 等字段解析错误；使用 Manager extension 管理的真实 CLI 或其同版本可执行文件，不要回退到旧的系统 Codex。

示例中的 `<absolute-...>` 文件系统路径必须替换为绝对路径。`MANAGER_GATEWAY_CODEX_HOME` 若配置，必须与 Manager extension 使用的 `CODEX_HOME` 指向完全相同的 Codex Home；不能配置相对路径，也不能为 Gateway 单独创建 Codex Home。Gateway 与 Manager extension 应由同一操作系统用户运行。省略 `MANAGER_GATEWAY_CODEX_HOME` 时，Gateway 使用启动它的同一用户的默认 Codex Home；此时 Manager extension 也必须由该用户运行，并且省略 `CODEX_HOME`、共同继承这个默认目录。若 Manager extension 显式配置了 `CODEX_HOME`，Gateway 必须配置同一个绝对路径。

`MANAGER_CONTROL_TOKEN` 未设置时，Gateway 也会读取 `CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN`；这样可以直接复用 Manager 的私有 control env 文件，不必复制令牌。该 control API 返回的 adapter 信息只用于同机 Gateway 的短生命周期任务，不应保存到 Workbench 配置或提交到仓库。

如果监听地址不是回环地址，必须配置 `MANAGER_GATEWAY_TOKEN`。Gateway 调用 Manager 时需要 `MANAGER_CONTROL_TOKEN`；Manager extension 使用同一个控制面令牌。真实令牌只放在目标设备的私有环境文件，不提交到仓库。

Feishu Helper 配置 `FEISHU_GATEWAY_URL=http://127.0.0.1:43118` 后，会复用本 Gateway 的 session、SSE、interjection、取消和账号恢复能力。Gateway 启动 Codex exec 时会注入 `WORKBENCH_DATA_URL` 和可选的 `WORKBENCH_DATA_TOKEN`，并把 Workbench HTTP API 约定加入 Codex 指令；因此飞书自然语言任务与 Workbench 网页端 AI 使用同一数据服务边界。

`MANAGER_GATEWAY_STATE_DIR` 只用于 Gateway 的运行状态和 develop worktree（默认 `worktrees/`）；Workbench SQLite 不属于 Gateway 的运行目录，也不由 Gateway 创建或管理。请按 Workbench 的 [`macos/docs/gateway-setup.md`](https://github.com/Layman-art/Research-Workbench/blob/main/macos/docs/gateway-setup.md) 单独启动数据服务，并通过 `WORKBENCH_DATA_URL` 让 Codex 访问数据接口。

## 运行

```bash
npm install
npm test
npm start
```

Gateway 需要 Node.js 22.5 或更新版本。Manager extension 在线时，Workbench 可通过浏览器或 SSH 端口转发访问该服务。
