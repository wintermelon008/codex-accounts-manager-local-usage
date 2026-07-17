# 实验性无感切号与五小时额度分档平衡

本功能在 Codex Accounts Manager 内集成一个很小的本地 CLI shim。它不启动常驻 HTTP 服务，也不为每个账号启动一套 Codex；官方 VS Code 扩展仍只运行一个 Codex app-server。

设置页将两套模式完全分开：**自动切号**是上游插件原有功能，继续使用它自己的阈值、候选选择和 reload 行为；本地新增的可配置额度分档、账号池、调度、无 reload 事务及普通会话/Goal 恢复全部属于**无感切号**。无感切号有独立总开关：关闭后手动切号和外部账号变化恢复 Manager 原有的账号写入与 reload 流程，但已安装 runtime 保留；重新开启无需再次安装 shim。无感分档无需开启官方自动切号或五小时配额控制；启用时它优先走独立的 fail-closed 路径，runtime 不可用便保持旧账号，不回退到写 `auth.json` 或 reload。

## 能做到什么

- 每张已保存账号卡片左下角都有独立的无感切号池开关，也可使用批量操作同时设置多个账号；池成员少于两个时只保存选择，不启动分档调度。
- 全局任意时刻只启用一个账号，不把账号分配到单独的 conversation。
- 当前账号的有效五小时剩余额度下降一个已配置档位后，只在池内存在实际额度严格更高的账号时切换；当前账号已是最高额度时继续消耗。支持 20%、25%、33% 和 50% 四种分档。
- 可选的 1% 紧急模式会在有效五小时额度临近耗尽时绕过普通基线和等待期，强制中断并自动续接到额度严格更高且高于 1% 的池中账号；若 turn 已先报告结构化 `usageLimitExceeded` 并结束，也会恢复近期受影响的 thread。
- 切换请求到达时，先给已经运行的 turn 一个可配置的自然完成等待期，默认 60 秒；屏障期间新 `turn/start` 会排队。
- 若活动 turn 所属 thread 有 `active` 持久 Goal，切换事务会先把 Goal 改为 `paused`。等待期后仍未结束时，正式 `turn/interrupt` 旧 turn；确认其完成后切号，再把 Goal 恢复为 `active`。
- 普通会话默认不被强制中断，而是延后本次切换并在下次配额刷新重试。也可显式选择“中断后手动继续”或实验性的“中断并在同一 thread 自动 Continue”。
- 只有旧 app-server 中的活动 turn 数为零后才会切换认证和提交当前账号，再放行排队的 turn。因此 thread/conversation 状态不会因为切号而重建。
- 安装 runtime 时需要一次初始 window reload；后续成功的热切换不需要 reload。
- 同一远程 extension host 的其他 VS Code 窗口检测到全局 `auth.json` 变化后，也会优先通过各自的 turn 屏障热切换。仅在实验功能未启用时使用原 reload 路径；若功能已启用但 runtime 尚未 ready，则安全失败并保持磁盘与运行中身份不变，不会降级成先写 `auth.json`。

这不是“多个账号在同一时刻分别运行不同对话”。当前 app-server 的认证是进程级状态，`turn/start` 没有逐 turn 账号字段，所以只能在所有在途 turn 的安全边界上切换全局账号。

## 为什么 runtime 强制使用 HTTP

仅调用 `account/login/start` 不足以保证已有 thread 的下一轮请求改用新账号。已验证的 Codex `0.144.2` 会为每个已加载 thread 缓存 Responses WebSocket；登录接口会更新共享认证状态，`account/read` 也会显示新账号，但旧 thread 仍可能复用由旧账号建立的 WebSocket。这会造成 Manager 显示切换成功、实际却继续扣旧账号额度。

runtime protocol v2 会为它启动的 app-server 选择一个与 OpenAI 内置配置等价、但声明 `supports_websockets=false` 的 provider。Responses 请求因此使用 HTTP streaming，并在每轮请求时重新读取当前认证。真实 Codex 二进制的本地确定性测试已经验证：同一个 thread 的第一轮携带账号 A，调用登录切换后，第二轮携带账号 B 的 access token 与 ChatGPT account ID。

代价是失去 Responses WebSocket 的跨 turn 复用，可能增加少量建连延迟和连接开销。它只影响通过已安装无感 runtime 启动的 app-server，不会启动常驻 HTTP 调度服务，也不会把 token 发给 Manager 之外的本地服务。

Dashboard 中关闭`无感切号（实验性）`会立即恢复 Manager 原有的账号写入、reload 提示和官方自动切号逻辑，但不会在运行中重启 app-server，因此底层 HTTP transport 会保留。若要连底层 transport 一并恢复为官方默认值，请运行 Remove Experimental Seamless Runtime，并按提示 reload 一次。

## 启用步骤

1. 导入至少两个属于你且允许使用的 ChatGPT/Codex 账号，并刷新全部配额。
2. 从命令面板运行 `Codex Accounts: Install Experimental Seamless Runtime`：
   - 普通本地窗口会自动配置启动路径，并提示 reload 一次。
   - Remote-SSH、WSL 和 Dev Container 中，manager 会根据当前远程用户生成准确的 `chatgpt.cliExecutable` JSON。点击 `Copy setting & open User Settings`，把已复制的内容粘贴或替换到打开的本地 User Settings JSON；不要写入 Remote Settings，也不要照抄其他用户机器上的绝对路径。保存后 reload 一次。
3. 打开账号 Dashboard，使用每张账号卡片左下角的开关，将至少两个账号加入无感切号池。也可勾选多个账号后使用“设为无感切号池”或“移出无感切号池”批量操作。
4. 在 Dashboard 设置中开启：
   - 配额自动刷新，建议 `1 ~ 5` 分钟；
   - `无感切号（实验性）`总开关；
   - 其子设置`额度分档无感平衡`，并选择 `1/5 (20%)`、`1/4 (25%)`、`1/3 (33%)` 或 `1/2 (50%)`；不要为此额外开启官方自动切号或五小时配额控制；
   - 可选开启`1% 紧急强制切号`。它会立即中断活动会话并自动 Continue，仅在当前与候选账号均有有效五小时窗口且你接受非幂等外部操作可能重复时使用；仅有周额度的账号即使界面显示小时 `0%` 也会安全跳过；
   - 将`无感切号等待时间`保持 60 秒或按实际负载调整；
   - 为普通会话选择无感切号策略；推荐默认的“延后切换”。若确实需要无人值守续接，可选择“中断并自动继续”，并接受非幂等外部操作可能重复的风险。
5. 官方`自动 reload window`只属于官方自动切号，对无感分档没有作用。无感 runtime 未 ready 时调度会安全跳过并保持旧账号；已进入热切换事务后的延后/失败同样保持旧账号。

对应的 VS Code 设置为：

```json
{
  "codexAccounts.hotSwitchEnabled": true,
  "codexAccounts.seamlessSwitchEnabled": true,
  "codexAccounts.hotSwitchGraceSeconds": 60,
  "codexAccounts.hotSwitchLongTurnPolicy": "defer",
  "codexAccounts.autoRefreshMinutes": 5,
  "codexAccounts.seamlessSwitchQuotaBandsEnabled": true,
  "codexAccounts.seamlessSwitchQuotaBandSize": 20,
  "codexAccounts.seamlessSwitchEmergencySwitchEnabled": false
}
```

`codexAccounts.balanceByQuotaBandsEnabled` 只作为旧本地构建的兼容读取键保留。首次在 Dashboard 修改开关后会写入新的 `seamlessSwitchQuotaBandsEnabled`；不要在新配置中继续使用旧键。

若要启用你当前测试的普通会话无人值守续接，把 `hotSwitchLongTurnPolicy` 改为 `"interruptAndContinue"`。它会在 60 秒后中断旧 turn，完成切号后在同一 thread 自动发送一次带恢复上下文的 `Continue`；这不是同一 turn 的精确恢复。

不要只手工修改 `codexAccounts.hotSwitchEnabled` 来安装或卸载 runtime；安装和移除都使用命令面板命令，以便管理 runtime，并生成或恢复当前环境对应的 `chatgpt.cliExecutable`。日常临时关闭无感行为只需关闭 Dashboard 的`无感切号（实验性）`总开关，无需 reload。发布说明不应提供 `/home/<固定用户>/...` 一类路径；Remote 用户始终使用 manager 当场复制的值。

## 分档与选号规则

五小时剩余额度可按以下四种粒度分档；仅当账号报告有效五小时窗口时，`0%` 才是可调度的档位 0。仅有周额度的账号可能显示小时 `0%`，但它表示不存在可比较的五小时窗口，不触发分档或 1% 紧急切号：

| 设置        | 档位边界（从高到低）                        |
| ----------- | ------------------------------------------- |
| `1/5 (20%)` | `81~100`、`61~80`、`41~60`、`21~40`、`1~20` |
| `1/4 (25%)` | `76~100`、`51~75`、`26~50`、`1~25`          |
| `1/3 (33%)` | `67~100`、`34~66`、`1~33`                   |
| `1/2 (50%)` | `51~100`、`1~50`                            |

`1/3 (33%)` 按精确三等分计算，而不是连续三个 33% 后额外留下 100% 档位。首次观察只记录基线，不立即切换；修改分档也会清除旧档位状态并重新建立基线。之后检测到当前账号下降到更低档位时，从无感切号池选择候选。当前账号和候选都必须具有有效五小时窗口；候选还必须：

- 具有有效的五小时窗口；
- 最近 15 分钟内成功刷新过配额；
- 没有配额错误；
- 当前档位不低于触发切换的账号，且实际剩余额度严格高于当前账号。

排序依次比较更高档位、更高剩余百分比、更早重置时间、最久未被调度，最后用账号 ID 保证结果稳定。如果跨档时没有合格候选，该跨档保持待处理，并在后续配额刷新时重试，而不是等到再下降一档。

`codexAccounts.seamlessSwitchEmergencySwitchEnabled` 默认关闭。开启后，只要有效五小时额度达到 `1%` 或更低，即使是首次观测也会触发紧急路径，并且候选额度必须高于 `1%` 且严格高于当前账号。紧急路径把等待期覆盖为 0，将普通会话策略覆盖为 `interruptAndContinue`：它先中断活动普通 turn/Goal turn，等待 app-server 确认所有旧 turn 已结束，再切换认证并在原 thread 自动续接。若 turn 在切号请求到达前已经通过终态 `error` 通知报告 `error.codexErrorInfo: usageLimitExceeded`、`turn/start` 以同一结构化错误的 JSON-RPC 响应被拒绝，或在兼容的失败 turn 中携带同一结构化错误，shim 会在两分钟的有界窗口内记住对应 thread；成功紧急切号后，普通 thread 获得一次恢复标记的 `Continue`，持久 Goal 则先暂停再恢复，已处于 `usageLimited` 的 Goal 会显式重新设为 `active`。任何更新的 `turn/start` 都会清除旧记录，避免重复续接；记录到期也会自动清理，因此不会成为持久停止记忆。若没有合格候选、当前账号仍是最高额度、runtime 未 ready 或事务失败，旧账号保持不变，记录保留到超时并可由后续刷新重试。runtime 状态还提供观察到的额度失败、普通恢复和 Goal 恢复计数，便于不暴露 thread 内容地现场核验。

紧急自动 Continue 仍是新 turn，不是原 turn 的 exactly-once 恢复。正在执行部署、消息发送、支付或其他非幂等外部写操作时可能产生重复副作用，因此该开关必须由用户显式启用。

## 并发屏障

shim 以真实 `turn.id` 跟踪 app-server 中的活动 turn：

1. 收到切号请求后进入 pending 状态。
2. 已发送的 `turn/start` 和已经开始的 turn 都计入屏障。
3. `turn/steer`、`turn/interrupt` 等属于当前 turn 的消息继续透传。
4. 新的 `turn/start`、`review/start` 和 `thread/compact/start` 暂存在内存队列。
5. 对活动 turn 的 thread 调用 `thread/goal/get`；发现 `active` Goal 时只把状态改为 `paused`，保留 objective、token budget 和累计用量。Goal mutation 请求也会在事务期间排队。
6. 等待 `codexAccounts.hotSwitchGraceSeconds`（默认 60 秒）：
   - 只有 Goal turn 仍活动时，调用 `turn/interrupt` 并等待 `turn/completed`；
   - 普通 turn 按 `codexAccounts.hotSwitchLongTurnPolicy` 选择延后、中断，或中断后自动续接；
   - 无法取得 `threadId`/`turnId` 的在途请求始终延后，绝不带着未知活动 turn 切认证。
7. 仅当活动 turn 数为零时调用实验性 `account/login/start`，随后用 `account/read` 校验账号身份。这里比较的是实际 access token 中的 runtime email，而不是稳定账号记录中的 ID-token email；两者可能是同一 user ID 的不同邮箱别名。
8. 身份校验成功后由 manager 提交目标账号及 `auth.json`，再恢复 Goal 为 `active`。选择 `interruptAndContinue` 时，为由本次切换中断且最终状态确认为 `interrupted` 的普通 thread 启动一个带内部恢复上下文的新 `turn/start`；1% 紧急路径还会恢复近期以结构化额度错误结束、且尚未开始更新工作的普通 thread。
9. 登录、身份校验或本地账号提交失败时，尝试同时回滚 app-server 与 manager 当前账号并恢复 Goal；在旧 turn 仍活动时不会把失败降级成“先写认证再 reload”。

在 60 秒等待期内，Goal pause 不会强制终止正在执行的命令或 tool call；当前 turn 仍按旧账号和原权限运行。超时后的 interrupt 会终止这一轮，Goal 的下一轮自动续跑发生在账号身份切换之后。由于 app-server 和 thread 没有重建，`cwd`、runtime workspace roots、sandbox policy、approval policy 与 named permission profile 保持原 thread 的 sticky 设置。一次性“仅批准本次操作”仍按 Codex 自身语义只对那次操作有效，不会被热切换扩展为持久权限。

现场验证还确认了一个进程边界：`turn/interrupt` 会结束 Codex turn，但不保证终止该 turn 已启动的所有本地子进程。无感恢复前应避免正在执行不可重复的部署、消息发送或外部写操作；扩展无法在多个并发 turn 之间安全判断任意 app-server 子进程的归属，因此不会擅自按进程树批量杀进程。

普通会话的自动 Continue 不是恢复同一个 turn，而是在同一 thread 中新建一轮。恢复上下文会要求先检查 thread 历史、当前工作区与已完成工具结果，只继续未完成部分；这能降低重复执行概率，但无法为任意 MCP、网络请求、消息发送或其他非幂等外部副作用提供 exactly-once 保证。因此它是显式 opt-in 的实验策略，不通过创建“临时 Goal”实现，也不会覆盖或留下持久 Goal。

每个 VS Code extension host 都有独立屏障。跨窗口切换依靠现有 `auth.json` watcher 传播目标账号，而不是分布式事务；窗口会在各自正在运行的 turn 完成后收敛，因此切换期间允许旧 turn 按原账号正常结束。watcher 收到 deferred 结果后会继续定时尝试，直到该窗口的 runtime 已是目标账号；失败结果不会无限重试。

同一 app-server 中的多个会话可能让 `turn/completed` 早于对应的 `turn/start` RPC 响应到达 shim。runtime 会保留有界的终态 turn ID 集合，避免迟到响应或通知把已完成 turn 重新计为活动；若 interrupt 明确返回“该 turn 已不活动”，则将其视为 app-server 的终态确认并继续屏障，而不会吞掉其他中断错误。

控制桥的请求上限为“配置等待期 + 2 分钟事务缓冲”，不再固定等待 30 分钟。管理端主动取消或连接关闭会恢复此前暂停的 Goal 后放行队列；已经开始执行的登录事务不会被中途打断。如果目标登录和旧账号回滚都失败，runtime 身份属于不确定状态，必须 reload 以重新建立可信状态。

## 安全与兼容性边界

- shim 与 manager 使用当前 extension-host PID 对应的本地 Unix socket；目录权限为 `0700`，socket 为 `0600`。
- shim 在收到成功的 `initialize` 响应或客户端 `initialized` 通知后即可进入 ready；状态接口同时报告两个握手信号，便于区分官方扩展版本差异。热切换已启用但 bridge 未 ready 时，Manager 必须失败关闭，不能回退为磁盘切号。
- runtime protocol v2 的状态接口必须同时报告 `httpTransportForced=true`；旧 shim 即使 socket 可连接也会要求一次 reload，避免认证状态已变化但旧 WebSocket 继续计费。诊断身份接口只返回 app-server 当前账号的非凭据字段与 Manager 本地账号 ID，不返回 access token。
- access token 只通过进程内存和本地 IPC 传递，不写入 shim 配置，也不输出到日志。runtime 配置文件只保存官方 Codex CLI 的绝对路径。
- token 临近过期时由 manager 使用原有 OAuth 刷新逻辑更新；app-server 的 refresh 回调必须匹配原 ChatGPT account ID，否则拒绝返回凭据。
- 同一 workspace ID 可能对应多个已导入用户。manager 在切换前校验 access token 的 user ID 与本地账号记录一致，再把 access token 的 runtime email 交给 app-server 身份校验；稳定账号记录邮箱与 runtime email 允许是同一 user ID 的不同别名。refresh 与失败回滚以 manager 本地账号 ID 和 workspace ID 为主；缺少本地身份且 workspace ID 不唯一时安全失败，不按数组顺序猜测账号。
- 该能力依赖 Codex app-server 的 experimental API。当前实现按本机 Codex `0.144.5` schema 和官方 VS Code 扩展 `26.707.91948` 验证；官方扩展升级后必须重新跑测试。协议在初始化前即不可用时可走原 reload 路径；事务已经开始后发生的不兼容会安全失败并保持/回滚旧账号。
- 持久 Goal 的暂停/恢复依赖同一 schema 中的 `thread/goal/get`、`thread/goal/set` 与 `active`/`paused` 状态；任何一步无法确认都会终止切换并尝试恢复原 Goal，而不是清除 Goal。
- 当前 runtime 安装路径支持 Linux 和 macOS，Windows 会明确拒绝启用。Windows 的无 shell CLI bootstrap 尚未实现和验证。
- 账号额度、产品规则和服务条款不会被此功能改变。只应调度你有权使用的账号。

## 禁用与回滚

只想临时恢复原有切号逻辑时，关闭 Dashboard 的`无感切号（实验性）`总开关即可；runtime 继续作为透明代理运行，下一次切号会走原有账号写入和 reload 提示。

若要完整卸载 runtime，从命令面板运行 `Codex Accounts: Remove Experimental Seamless Runtime`。普通本地窗口会自动恢复安装前的 `chatgpt.cliExecutable`；Remote 环境会复制恢复用 JSON 并打开本地 User Settings。保存后按提示 reload 一次，即可回到官方标准启动路径。

## 开发验证

不需要真实凭据的核心检查：

```bash
node --check runtime/codex-app-server-shim.cjs
npx vitest run test/hotSwitchBridge.test.ts test/hotSwitchRuntime.test.ts test/refreshCoordinator.test.ts test/quotaBandBalancing.test.ts
CODEX_APP_SERVER_BIN=/path/to/codex npm run verify:seamless-auth
npm run verify
npm run package
```

`test/hotSwitchBridge.test.ts` 使用假的 app-server 验证多个并发 turn、切换屏障、排队 turn、token refresh 回调、60 秒策略的缩短测试版本、普通 turn 延后/中断/同 thread 续接、当前协议终态 `error` 通知及兼容失败 turn 的额度耗尽恢复与防重复，以及持久 Goal 的暂停、interrupt、断连恢复、切号后自动续跑和 thread-sticky workspace 权限；测试 fixture 不包含真实账号数据。

`verify:seamless-auth` 使用两个合成的未签名 JWT 和仅监听 `127.0.0.1` 的临时 HTTP server，不读取任何已导入账号。它以与 runtime 相同的参数布局启动指定 Codex，先确认每次 `account/read` 都报告当前 access token 的 runtime email，再验证同一 thread 在 A→B 登录切换后的两个 Responses 请求分别携带对应的合成认证；验证结束会删除临时 `CODEX_HOME`。升级官方 Codex 后应重新运行此检查。
