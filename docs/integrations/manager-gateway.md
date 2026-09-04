# Manager Gateway

`integrations/manager-gateway` 是 Manager 侧独立的 Node companion service。它提供统一的 task/session API，Workbench 只需配置 Gateway 地址；Gateway 不读取 Workbench 前端凭据，也不直接让浏览器访问 Manager 私有存储。

## 能力边界

- `research` 默认通过与 Manager 共享的 resident Codex adapter 执行；只有配置独立 provider 时才走 OpenAI-compatible provider。
- `develop` 通过 `codex exec` 执行，每个 session 使用隔离 Git worktree；用户通过 `apply` / `discard` 明确处理 diff。
- 多 session 并行共享当前 Manager 账号；额度耗尽时等待相关批次结束后只切换一次并恢复受影响 session。
- 手动切换强制中断活动 session、清除本次 Gateway 恢复池，并在切换成功后恢复受影响 session。
- 账号查询和切换通过 Manager loopback control API 完成，因此 Manager extension 必须在线。
- Gateway 每次启动 Codex 任务前从 Manager control API 获取当前 adapter 地址和临时令牌，不依赖重启后可能变化的随机端口。
- Workbench 浏览器数据不经过 Gateway 的数据存储；由独立的 Workbench 数据服务通过 `/api/workbench/*` 持有 SQLite。Gateway 内的 session/事件/恢复状态目前保存在 Gateway 内存中。

本轮不改动 Feishu adapter；后续 Feishu 入口应调用相同的 task/session API。

## 启动

Gateway 需要 Node.js 22.5+：

```bash
npm --prefix integrations/manager-gateway install
npm --prefix integrations/manager-gateway test
npm --prefix integrations/manager-gateway start
```

常用配置包括 `MANAGER_CONTROL_URL`、`MANAGER_CONTROL_TOKEN`、`MANAGER_GATEWAY_CODEX_HOME`、`MANAGER_GATEWAY_PROJECT_ROOT`、`MANAGER_GATEWAY_STATE_DIR` 和 `MANAGER_GATEWAY_MAX_SESSIONS`。Workbench 数据服务的 `WORKBENCH_DATA_DB`、`WORKBENCH_DATA_URL` 和 SSH 转发说明见 Workbench 的 [`macos/docs/gateway-setup.md`](https://github.com/Layman-art/Research-Workbench/blob/main/macos/docs/gateway-setup.md)。

Gateway 默认只监听回环地址。跨设备使用时，优先通过 SSH `-L` 转发；非回环监听必须设置 `MANAGER_GATEWAY_TOKEN` 和合适的 `MANAGER_GATEWAY_CORS_ORIGIN`。
