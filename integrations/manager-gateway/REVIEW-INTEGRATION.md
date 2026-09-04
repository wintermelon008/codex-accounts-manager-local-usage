# Manager Gateway × Research Workbench 集成审查

审查日期：2026-09-04
审查范围：

- `/home/melon/codex-accounts-manager-usage/integrations/manager-gateway`
- `/home/melon/Research-Workbench/macos/src/features/gateway`
- 为核对跨目录行为，仅读取 Workbench 的 `BrowserWorkbenchRepository`、`App`、`SettingsView` 及 Manager 的 control API 调用方。

本次不修改生产代码、测试或既有文件，仅新增本记录。

## 结论

这是修复前的集成初审记录。初审提出的 5 个问题，以及后续复核发现的恢复中间态、断线重连和候选过滤问题，已在当前工作树分别修复或明确为部署前置条件；修复后的测试结果见文末“修复后复验”。其中 `CODEX_HOME` 仍需要 Manager extension 与 Gateway 的部署者提供同一个绝对目录，Gateway 不会替部署者推断或同步两个独立进程的凭据目录。

架构说明：本文早期内容曾假定 Gateway 暴露 Workbench 数据接口。当前 Workbench 数据服务已独立为 Research Workbench 的 `/api/workbench/*` 服务并持有 SQLite，Manager Gateway 不再提供 `workbenchData` capability，也不打开该数据库；下文涉及旧数据接口的内容仅作历史审查记录。

## Findings

### P1 — 额度恢复把中间状态当成 SSE 最终状态，浏览器收不到恢复结果

状态：已修复。Gateway 现在把 quota terminal 作为可恢复中间状态，SSE 会保持到恢复成功或 `recovery_failed` 等最终事件；Workbench 仍使用同一条订阅接收后续事件。

位置：

- `src/server.mjs:217-221`
- `src/session-manager.mjs:302-308`、`src/session-manager.mjs:467-476`
- Workbench `macos/src/features/gateway/AssistantPanel.tsx:89-104`

复现条件：使用 `maxSessions=1` 的 fake provider；第一次运行延迟后抛出 `QuotaExhaustionError`，Manager 切到账号 B，第二次运行返回成功。先在第一次运行尚未结束时连接 `/v1/sessions/:id/events`。

实际结果：SSE 在收到 `session.terminal`（状态为 `quota_exhausted`）后被 Gateway 关闭；随后 session-manager 才发出 `session.recovery_queued`、新的 `session.started` 和最终 `session.terminal`。探针观察到：

```text
SSE: session.snapshot, session.created, session.started, session.terminal
最终 GET: status=completed, recoveryCount=1
```

Workbench 只为该 session 建立一次订阅，连接关闭后不会重新订阅，因此实时界面可能停在“额度耗尽”，即使 Gateway 最终已经恢复并完成任务。

最小建议：明确区分“可恢复的额度耗尽事件”和最终终态；SSE 只有在最终不可恢复或最终完成时关闭。若保留 `quota_exhausted` 状态，应由 server 判断恢复批次是否已结束后再关闭流，或新增非终态的额度事件。

### P1 — `capabilities` 的能力字段与实际运行条件不一致

状态：已修复。能力字段按 Manager 和 develop worktree 的实际注入条件动态计算；依赖不可用时 apply/discard 返回 503，真实 session 状态冲突仍返回 409。Workbench 数据服务不属于该能力集合。

位置：`src/server.mjs:56-67`。

复现：用没有 `manager`、没有 `workspaces` 的 `GatewaySessionManager` 启动 server。

实际结果：

```json
{
  "accountSwitch": true,
  "developWorktree": true
}
```

但同一实例上的 `POST /v1/accounts/switch` 返回 HTTP 409 `Manager account switching is unavailable`，develop session 的 `apply` 返回 HTTP 409 `session has no open develop worktree`。原因是 `sessions.apply` / `sessions.discard` 是类方法，即使未注入 worktree manager 也始终存在；`accountSwitch` 则被无条件写成 `true`。旧实现还曾把数据层能力错误地放在 Gateway；该能力现已移出，不再由 capabilities 宣布。

最小建议（旧实现）：由 session manager 暴露实际依赖可用性，按 `manager.switchAccount` 和 `workspaces` 生成能力字段；数据服务独立检查其自身状态，不加入 Manager Gateway capabilities。不可用依赖建议返回 503，真正的状态冲突再返回 409。

### P1 — Gateway 的 Codex 子进程可能不使用 Manager 刚切换的账号

状态：已明确为部署前置条件。Gateway 拒绝相对 `CODEX_HOME`，文档统一要求与 Manager extension 完全相同的绝对目录；当前最小方案不增加跨进程凭据同步协议。

位置：

- Gateway `src/providers.mjs:74-83`
- Manager `src/codex/authFile.ts:25-30,36-38,72-78`
- Manager `src/presentation/workbench/accountsWorkbench.ts:442-485`
- Workbench `macos/docs/gateway-setup.md:28-35`

Gateway 启动 Codex 时把 `MANAGER_GATEWAY_CODEX_HOME` 原样写入子进程的 `CODEX_HOME`。Manager 切号写入的 `auth.json` 则使用 Manager extension 进程自己的 `process.env.CODEX_HOME`。两者没有协议字段或启动检查保证相同。

当前 Workbench 文档示例还使用 `MANAGER_GATEWAY_CODEX_HOME=./codex-home`。Gateway 同时把 Codex 子进程的 `cwd` 设为项目根或隔离 worktree，因此这个相对路径按子进程 cwd 解析，而不是明确按 Gateway 启动目录解析。若它与 Manager 的 `CODEX_HOME` 不同，control API 会返回切换成功，但后续 Gateway `codex exec` 可能继续读旧 auth.json，或读到不存在的认证目录。

最小建议：测试版先要求 Gateway 与 Manager 使用同一个绝对 `CODEX_HOME`，启动时校验并在文档明确写出；更完整的方案是由 Manager 提供按活动账号解析的执行环境/凭据句柄，Gateway 不自行猜测认证路径。

### P1 — 空 diff 的 develop session 没有可见的 apply/discard 操作，worktree 会遗留

状态：已修复。停止且 worktree 仍 open 的 develop session 即使 diff 为空也显示清理操作；apply/discard 均可用于释放 worktree。

位置：Workbench `macos/src/features/gateway/AssistantPanel.tsx:354-369`。

复现：创建 develop session，Codex 正常完成但不修改文件。Gateway 返回的 session 仍包含 `workspace.status="open"`，而 `diff` 为空字符串；`WorktreeManager.apply()` 即使 diff 为空也会负责移除 worktree。

实际结果：Workbench 的操作区条件包含 `session.diff &&`，空 diff 时整个 apply/discard 区域不渲染。用户无法从当前界面显式释放该 worktree，和文档中“结束后必须由客户端显式 apply 或 discard”的边界不一致。

最小建议：对已停止且 `workspace.status="open"` 的 develop session 始终显示操作区；空 diff 时可以将 apply 作为清理操作，至少应提供 discard。

### P2 — Manager 不在线/超时被 Gateway 统一映射为 409，和文档及错误语义不一致

状态：已修复。Manager control API 的不可用/超时/5xx 映射为 503；账号不存在或切换冲突保持 409，并保留原始状态码信息。

位置：

- Gateway `src/server.mjs:106-123`
- Gateway `src/manager-client.mjs:4-7,60-64`
- Workbench `macos/docs/gateway-setup.md` 的常见问题

复现：让 Manager control API 返回 HTTP 503。`ManagerControlError` 会保留 `statusCode=503`，但 Gateway `/v1/accounts/switch` 捕获所有异常后统一返回 HTTP 409。实际响应为：

```json
{
  "httpStatus": 409,
  "body": { "error": "manager offline（HTTP 503）" }
}
```

文档把 Manager 不在线列为 HTTP 503 场景；客户端也无法依据状态区分“服务不可用”和“账号切换冲突”。

最小建议：Manager control 连接失败、超时和 5xx 映射为 503；目标账号不存在或运行时切换冲突使用 409；保留原始 `error.code` / `statusCode` 供 Workbench 展示和重试判断。

## 已核对且未发现问题的部分

- `POST /v1/sessions` 的 `{ sessionId, session }` 响应和 Workbench 的兼容解析一致。
- `GET /v1/sessions/:id`、取消、apply、discard 的路径和嵌套 `{ session }` 响应字段一致。
- SSE 的 `event: <event.type>` 与 JSON `data.type` 一致；客户端能处理分块、多行 data 和 `eventId` 去重。上面的额度恢复问题是流生命周期问题，不是字段名问题。
- Workbench 数据服务的 `/api/workbench/data` `GET` / `PUT` 路径、`{ state, updatedAt }` 读取响应和 `{ state }` 写入请求由 Research Workbench 仓库单独维护；它不属于 Manager Gateway API。
- Manager Gateway 当前 CORS 仅覆盖其 session API 使用的 `GET, POST, DELETE, OPTIONS`；Workbench 数据服务独立声明自己的数据 API 方法和认证头，不由 Gateway 代理。
- develop worktree 在有 tracked 与 untracked 修改时，Gateway 侧正常收集 diff、显式 apply 到主工作树并移除 worktree；Workbench 侧的 apply/discard 路径与 Gateway API 一致。空 diff 的 UI 可达性问题已在修复后消除。
- `macos/docs/gateway-setup.md` 中的 `./integrations/manager-gateway` 明确假定从 Manager 工作区根目录运行；该相对路径在 Manager 仓库中存在，但文档没有给出两个独立 clone 的根目录关系。真正会导致运行时路径歧义的是上面的相对 `CODEX_HOME` 示例。

## 最窄验证

使用 Node 22：

```bash
cd /home/melon/codex-accounts-manager-usage/integrations/manager-gateway
env PATH="/home/melon/.local/node-v22.23.2-linux-x64/bin:$PATH" \
  npm test -- --test-name-pattern='manager gateway HTTP API|GatewaySessionManager|WorktreeManager'
# 19 passed, 0 failed
```

```bash
cd /home/melon/Research-Workbench/macos
NODE22=/home/melon/.local/node-v22.23.2-linux-x64/bin/node
COREPACK=/home/melon/.local/node-v22.23.2-linux-x64/lib/node_modules/corepack/dist/corepack.js
"$NODE22" "$COREPACK" pnpm exec vitest run \
  src/test/assistantSession.test.ts \
  src/test/browser-workbench-repository.test.ts
# 11 passed, 0 failed
```

初审阶段未运行完整 Workbench e2e；审查本身没有改动生产代码或既有测试。修复后的完整复验结果记录如下。

## 修复后复验

修复后复验结果：

- Manager Gateway `npm test`：27 passed；`npm run package:check`：测试 27 passed，`npm pack --dry-run` 成功。
- Manager root control 定向测试：55 passed；`npm run verify`：0 errors（保留既有 66 条 lint warnings）。
- Research Workbench `macos`：Vitest 81 passed、`npm run check` 通过、TypeScript/build 通过。
- Research Workbench Playwright 全量：5 passed（含新增 assistant E2E 3 项）。由于 vserver 未安装 `pnpm`，本次先用 Node 22 手动启动同一 Vite dev server，再运行 Playwright；浏览器测试本身通过。
