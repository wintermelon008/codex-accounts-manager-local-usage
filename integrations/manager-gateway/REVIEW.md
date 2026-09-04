# Manager Gateway 独立审查记录

审查日期：2026-09-04
审查对象：`integrations/manager-gateway` 当前工作树
审查范围：`session-manager.mjs` 的自动额度批次、手动强制切号、thread resume，以及 `server.mjs` 的 SSE/API 竞态。
变更边界：本次未修改生产代码、测试或其他文件；仅新增本记录。

## 结论

初审发现的 4 个 P1 问题已在当前工作树修复，并由新增回归测试覆盖。本文保留初审复现条件，便于后续交接；当前状态以“修复状态”小节为准。

架构说明：文中的 Workbench 数据 CORS finding 属于 Gateway 曾经承载数据接口的历史实现。当前 Workbench 数据接口已移至 Research Workbench 仓库的独立数据服务，Manager Gateway 不再打开或管理 Workbench SQLite；该 finding 仅保留为历史记录。

## Findings

### P1 — 所有账号额度耗尽时会无限切号，甚至饿死事件循环

状态：已修复。session 记录已尝试账号，批次候选耗尽后进入 `recovery_failed`，不再循环。

- 位置：`src/session-manager.mjs:407-433`、`src/session-manager.mjs:446-462`、`src/session-manager.mjs:465-482`。
- 触发条件：provider 对每次恢复都抛出 `QuotaExhaustionError`；Manager 始终返回两个 `healthy` 账号。
- 原因：每次恢复只排除当前账号，没有记录本 session 已尝试过的账号，也没有最大恢复次数/批次终止条件。因此流程会在账号 A/B 间反复切换并重新排队同一 session。
- 复现：使用内存 fake provider/manager，`maxSessions=1`，provider 在一次 `setImmediate` 后始终抛出额度异常，运行 50 ms 后观测到：

  ```json
  {"switches":140,"status":"running","recoveryCount":140,"recovery":{"state":"idle"}}
  ```

  将 provider 改为立即抛错后，50 ms 定时器无法触发；单个 Gateway 进程持续执行恢复 microtask，表现为事件循环饥饿。
- 影响：所有账号确实不可用时，session 不会进入可解释的失败/等待状态，Manager 会被持续切换请求占用，HTTP/SSE 处理也可能失去调度机会。
- 最小修复建议：在恢复批次或 session 上记录已尝试账号；候选账号全部尝试过时结束恢复并发出明确的 `recovery_failed`/终态事件。恢复计数应有明确上限，不能依赖账号健康缓存最终更新来终止循环。

### P1 — 自动切号与手动强制切号竞态会丢失恢复任务

状态：已修复。自动切换 promise 与手动切换共用 Gateway 内部协调状态；手动路径等待正在进行的自动切换，并在 Manager 成功返回后再清空恢复池。

- 位置：`src/session-manager.mjs:124-175` 与 `src/session-manager.mjs:407-433`。
- 复现方式：让自动 `manager.switchAccount("account-b", { force: false })` 延迟返回；在 `getRecoveryStatus().state === "switching"` 时调用 `manualSwitch("account-c")`。让第二次 Manager 调用模拟现有 `RuntimeSwitchCoordinator` 的返回：`{ status: "suppressed", reason: "operationInProgress" }`。
- 实际结果：调用顺序为自动 B、手动 C；手动请求以 `Manager account switch failed` 拒绝；手动路径先清除了 `#exhaustionBatch`，自动请求稍后返回时因 batch 已不存在而直接退出；原 session 保持：

  ```json
  {
    "manualError":"Manager account switch failed",
    "recovery":{"state":"idle"},
    "session":{"status":"quota_exhausted","recoveryCount":0}
  }
  ```

- 影响：用户在自动切号窗口中手动切号时，强制切号未完成，且原本应自动恢复的 session 被永久留在 `quota_exhausted`；两个切号请求也可能同时作用于 Manager runtime。
- 最小修复建议：让自动和手动切号共用一个明确的 switch transaction/锁。手动请求应等待或接管正在进行的自动切号；在底层切号 promise settle 前不得清除 batch；若返回 `suppressed(operationInProgress)`，应保留批次并重新协调，而不是把 session 留在终态。

### P1 — `exec resume` 使用了当前 CLI 不支持的参数，原 thread resume 实际不可达

状态：已修复。resume 使用独立 argv，只保留当前 CLI 接受的 `--json` / `--config`；正常 resume 失败才进入语义 fallback，quota 错误不会误触发 fallback。

- 位置：`src/providers.mjs:53-66`。
- 当前环境：`codex-cli 0.147.0`。
- 代码给 `codex exec resume` 复用了普通 exec 的 `--color never` 和 `--sandbox <mode>`。实际命令验证：

  ```text
  $ codex exec resume --color never --json --sandbox read-only ...
  error: unexpected argument '--color' found

  $ codex exec resume --json --sandbox read-only ...
  error: unexpected argument '--sandbox' found
  ```

  `--config` 仍可被当前 resume 子命令接受；问题是上述两个复用参数已经足以使进程在真正加载 thread 前退出。
- `createCodexProvider` 会把该退出识别为 `codex_failed`，随后进入 `src/providers.mjs:81-95` 的 semantic fallback。因此现有测试中的“resumeThreadId 传递”只验证了 fake provider 的 session 字段，没有验证真实 CLI；在当前 CLI 上所有恢复都会退化为新 session，原 thread 从未真正恢复。
- 影响：丢失原对话上下文和 thread 级连续性；对于 develop 任务，语义 fallback 还可能重复已完成步骤。它不会总是表现为 session 失败，因而容易被 fallback 掩盖。
- 最小修复建议：为 `exec` 和 `exec resume` 分别构造参数，只传 resume 子命令实际支持的选项；增加 provider 层 argv/真实 CLI smoke test，确认成功走原 thread 后再允许 semantic fallback。

### P1 — [历史架构] Workbench 数据 PUT 的 CORS 预检没有声明 `PUT`

状态：已被架构替换。旧 Gateway 数据接口的 CORS 曾包含该问题；当前 Workbench 数据服务独立实现 `/api/workbench/*`，由 Workbench 仓库自己的数据服务测试覆盖。

- 位置：`src/server.mjs:292-298`。
- 复现：配置 `corsOrigin: "http://workbench.test"`，发送
  `OPTIONS /v1/workbench/data`，并带上 `Access-Control-Request-Method: PUT`。响应为：

  ```json
  {"status":204,"allowMethods":"GET, POST, OPTIONS","allowOrigin":"http://workbench.test"}
  ```

- `PUT /v1/workbench/data` 本身存在，但浏览器的跨源预检会因 `Access-Control-Allow-Methods` 缺少 `PUT` 而阻止实际请求。Node `fetch` 直连测试能够成功，不能覆盖浏览器行为。
- 影响（旧实现）：Workbench 从独立前端 origin 访问 Gateway 时无法保存中央 SQLite 数据，跨设备/浏览器数据同步链路因此不可用。
- 旧修复建议：在允许方法中加入 `PUT`，并补充浏览器语义的 OPTIONS 回归测试。

## SSE/API 竞态审查结果

- 对当前同步的 `GatewaySessionManager.subscribe()` 实现，使用延迟 provider 通过真实 HTTP server 读取 `GET /v1/sessions/:id/events`，收到了 `session.snapshot`、历史 `session.created` 和最终 `session.terminal`；未复现终态事件丢失。
- `streamEvents()` 在读取历史后立即同步安装订阅，当前实现中间没有 `await`，所以“历史读取与订阅之间”的常规事件循环竞态目前不可达。若后续把 session store 改成异步，必须重新审查这一假设。
- 初审发现的旧 API 层问题是上面的 PUT CORS 预检；当前 Workbench 数据服务已独立维护该接口。除此之外，本轮未把假设性 race 记为 finding。

## 验证命令与结果

使用 Node 22（`/home/melon/.local/node-v22.23.2-linux-x64/bin` 前置于 `PATH`）：

```bash
npm test
```

初审时工作树完整测试结果为 16 passed；修复后 Gateway 包测试已扩展为 27 passed。新增测试覆盖并发、有限恢复、自动/手动切换竞态、真实 argv、worktree apply、能力字段、SSE 生命周期和候选账号过滤；Workbench 数据服务的 SQLite 与 CORS 测试位于 Research Workbench 仓库。
