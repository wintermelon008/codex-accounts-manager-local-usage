# Manager Gateway

`integrations/manager-gateway` 是 Manager 侧独立的 Node companion service。它提供统一的 task/session API，Workbench 只需配置 Gateway 地址；Gateway 不读取 Workbench 前端凭据，也不直接让浏览器访问 Manager 私有存储。

## 能力边界

- `research` 默认通过与 Manager 共享的 resident Codex adapter 执行；只有配置独立 provider 时才走 OpenAI-compatible provider。
- `develop` 通过 `codex exec` 执行，每个 session 使用隔离 Git worktree；用户通过 `apply` / `discard` 明确处理 diff。
- 多 session 并行共享当前 Manager 账号；额度耗尽时等待相关批次结束后只切换一次并恢复受影响 session。
- `GET /v1/usage/today`：按日持久化 Gateway session 的最终 token 用量，并提供按模型统计。
- 手动切换强制中断活动 session、清除本次 Gateway 恢复池，并在切换成功后恢复受影响 session。
- 账号查询、切换和自动恢复通过 Manager loopback control API 完成；普通 session 和 token 统计不要求该可选接口在线。
- Gateway 每次启动 Codex 任务前从 Manager control API 获取当前 adapter 地址和临时令牌，不依赖重启后可能变化的随机端口。
- Gateway 的 Codex executable 必须与 Manager extension 共享的 Codex Home 使用同一版本；否则共享 `models_cache.json` 可能出现 schema 解析错误。
- Workbench 浏览器数据不经过 Gateway 的数据存储；由独立的 Workbench 数据服务通过 `/api/workbench/*` 持有 SQLite。Gateway 内的 session/事件/恢复状态保存在内存中，token ledger 保存在 `MANAGER_GATEWAY_STATE_DIR/usage-ledger-v1.json`，不保存 prompt、响应正文或凭据。

VServer 上的 Feishu Helper 配置 `FEISHU_GATEWAY_URL=http://127.0.0.1:43118` 后，普通飞书私聊会通过相同的 task/session API 创建或继续 session，并与 Workbench 浏览器共用 token ledger。Gateway 启动 Codex 时注入 `WORKBENCH_DATA_URL`（及可选的独立 `WORKBENCH_DATA_TOKEN`），所以飞书自然语言任务可以像网页端 AI 一样通过独立数据服务的 `/api/workbench/*` 接口查询、创建、修改和删除记录及日程；Feishu Helper 与 Gateway 均不打开 SQLite。Manager control 接口缺失时，AI session、Gateway 用量和健康/状态的可用部分仍可工作，账号切换、自动恢复、额度刷新和导入任务则不可用。

## 启动

Gateway 需要 Node.js 22.5+：

```bash
npm --prefix integrations/manager-gateway install
npm --prefix integrations/manager-gateway test
npm --prefix integrations/manager-gateway start
```

常用配置包括 `MANAGER_CONTROL_URL`、可选的 `MANAGER_CONTROL_TOKEN`、`MANAGER_GATEWAY_CODEX_HOME`、`MANAGER_GATEWAY_PROJECT_ROOT`、`MANAGER_GATEWAY_STATE_DIR`、`MANAGER_GATEWAY_MAX_SESSIONS` 和 `WORKBENCH_DATA_URL`。无 Manager control 接口的设备如需给共享 Codex CLI 的 usage 指定模型，可配置仅用于统计归属的 `MANAGER_GATEWAY_CODEX_MODEL`（例如官方名称 `gpt-6-astra`）；它不会改变 Codex CLI 实际模型。Feishu 连接使用 `FEISHU_GATEWAY_URL` 及必要时的 `FEISHU_GATEWAY_TOKEN`。Workbench 数据服务的 `WORKBENCH_DATA_DB`、`WORKBENCH_DATA_URL` 和 SSH 转发说明见 Workbench 的 [`macos/docs/gateway-setup.md`](https://github.com/Layman-art/Research-Workbench/blob/main/macos/docs/gateway-setup.md)。

Gateway 默认只监听回环地址。跨设备使用时，优先通过 SSH `-L` 转发；非回环监听必须设置 `MANAGER_GATEWAY_TOKEN` 和合适的 `MANAGER_GATEWAY_CORS_ORIGIN`。
