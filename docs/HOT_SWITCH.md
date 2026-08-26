# 实验性无感切号、额度分档与统一账号切换阈值

本功能在 Codex Accounts Manager 内集成一个很小的本地 CLI shim。它不启动常驻 HTTP 服务，也不为每个账号启动一套 Codex；官方 VS Code 扩展仍只运行一个 Codex app-server。

设置页将两套模式完全分开：**自动切号**是上游插件原有功能，继续使用它自己的阈值、候选选择和 reload 行为；本地新增的可配置额度分档、账号池、调度、无 reload 事务及普通会话/Goal 恢复全部属于**无感切号**。无感切号有独立总开关：关闭后手动切号和外部账号变化恢复 Manager 原有的账号写入与 reload 流程，但已安装 runtime 保留；重新开启无需再次安装 shim。无感分档无需开启官方自动切号或五小时配额控制；启用时它优先走独立的 fail-closed 路径，runtime 不可用便保持旧账号，不回退到写 `auth.json` 或 reload。

## 能做到什么

- 额度仅由周窗口触发官方自动切号时，也优先选择仍有有效 5h 窗口的账号，再比较剩余额度；账号卡片的窗口 Token 归属优先按 `window_minutes` 识别 5h 窗口，不依赖 provider 的 `primary`/`secondary` slot 名称。

- 每张已保存账号卡片左下角都有独立的无感切号池开关，也可使用批量操作同时设置多个账号；池成员少于两个时只保存选择，不启动分档调度。
- 卡片左上角的选择框可批量隐藏或解除隐藏账号。隐藏成功后仅取消实际被隐藏账号的勾选；隐藏账号默认从面板列表中筛掉、以紫色标识，立即移出无感切号池，且不会成为自动或手动切换目标；解除隐藏会自动重新加入无感切号池。面板的眼睛按钮可随时显示隐藏卡片。
- Saved Accounts 右上角的“隐藏周额度 <3%”按钮只处理当前显示范围中周额度严格低于 `3%` 的未隐藏账号；无周额度窗口或已隐藏账号不会被处理。
- 同一区域的“解除隐藏周额度 >90%”按钮会检查所有隐藏账号，不受当前分组显示状态影响；只有周额度严格高于 `90%` 且存在周窗口的账号会被恢复。恢复在同一次写入中自动加入无感切号池并移出 `A/B/C` 分组，普通批量解除隐藏继续保留原分组。
- 同一批量选择可将账号放入 `A`、`B`、`C` 分组或移出分组。面板右上角的 `A/B/C` 按钮同时控制该分组卡片是否显示、该分组是否进入无感候选；未分组且未隐藏账号固定显示并始终进入无感候选。分组筛选不改池成员、不影响手动切号或官方自动切号；已激活的关闭分组账号仅在原有切换条件满足时才会转出，且目标只能来自当前显示范围。
- 已保存账号支持每页 `10`、`20`、`50` 张卡片分页，默认 `10`；隐藏、解除隐藏及分组显示变化会立即重新分页，页码越界时自动回到有效页。
- Dashboard 的“刷新当前页配额”只刷新当前显示页；单卡、明确选中的批量刷新和命令面板的显式全量刷新不受此页范围限制。
- 定时配额刷新只处理未隐藏且分组已启用的第 `1` 页（最多 `50` 个账号）；其余账号仅按需手动刷新。需要持续参与分钟级无感调度的账号应放在这一范围内。
- 全局任意时刻只启用一个账号，不把账号分配到单独的 conversation。
- 普通自动调度只依据最新有效额度窗口识别能力，不依据 Free、Plus 等套餐标签推断：同时有五小时和周窗口的是分档账号，明确没有五小时窗口但有周窗口的是储备账号，额度缺失、过期或报错时暂不参与自动选择。
- 经过 Free/K12 标签与实际窗口双重验证的 Free/K12 账号是唯一不参加普通 `20%/25%/33%/50%` 分档的账号；它仍与其他账号共用统一的账号切换阈值。低额度或耗尽时，所有候选先按真实额度窗口与额度排序；Free/K12 目标额外要求最近两分钟内成功刷新。
- 分档调度与低额度切号独立。分档调度默认关闭，设置页不提供入口；仅在 config 层开启后，非 Free 分档账号下降一个已配置档位才会优先切到五小时额度更高、周额度安全的池内账号。支持 20%、25%、33% 和 50% 分档，并使用可配置的“等待时间”。
- “低额度切号”可选“耗尽后切换”、`1%`、`3%`（默认）或 `5%`。非零时，任一有效五小时或周窗口达到阈值，或出现结构化 `usageLimitExceeded`，都会立即发起切号；目标相关窗口必须严格高于阈值。
- 关闭“低额度切号”后，低额度、结构化 `usageLimitExceeded` 和耗尽批次都不会启动新的自动切换；已开始的事务允许完成，分档切号不受影响。
- 选择“耗尽后切换”时，25% 分档的 `26% → 1%` 仍可跨档平衡，而 `24% → 1%` 会等待当前活跃会话批次全部以结构化额度耗尽终止，最长观察 6 小时。Free/K12 在低额度路径中可选择明确没有五小时窗口、但周额度有效的 `reserve`；这类 Free/K12 目标仍须最近两分钟内成功刷新，且不会为选择它而强制刷新。
- “切换策略”适用于所有已发起的无感切换：分档和手动无感切号先等到“切换策略”下方配置的等待时间结束；低额度和耗尽后切号从零等待期开始。屏障期间新的 `turn/start` 会排队。
- 若活动 turn 所属 thread 有 `active` 持久 Goal，切换事务会先把 Goal 改为 `paused`。等待期后仍未结束时，正式 `turn/interrupt` 旧 turn；确认其完成后切号，再把 Goal 恢复为 `active`。
- 普通会话默认不被强制中断，而是延后本次切换并在下次配额刷新重试。也可显式选择“中断后手动继续”或实验性的“中断并在同一 thread 自动 Continue”。
- 只有旧 app-server 中的活动 turn 数为零后才会切换认证和提交当前账号，再放行排队的 turn。因此 thread/conversation 状态不会因为切号而重建。
- 安装 runtime 时需要一次初始 window reload；后续成功的热切换不需要 reload。
- 同一远程 extension host 的其他 VS Code 窗口检测到全局 `auth.json` 变化后，也会优先通过各自的 turn 屏障热切换。仅在实验功能未启用时使用原 reload 路径；若功能已启用但 runtime 尚未 ready，则安全失败并保持磁盘与运行中身份不变，不会降级成先写 `auth.json`。
- 删除全部受管账号后第一次切到新导入账号时，也不要求先关闭无感开关：Manager 会从当前有效 `auth.json` 建立只驻留于内存的回滚快照，并通过 live app-server 校验旧身份；事务失败时恢复该身份。

这不是“多个账号在同一时刻分别运行不同对话”。当前 app-server 的认证是进程级状态，`turn/start` 没有逐 turn 账号字段，所以只能在所有在途 turn 的安全边界上切换全局账号。

## 模型负载过大时的自动恢复

当某个 thread 收到精确错误 `Selected model is at capacity. Please try a different model.`，或结构化错误标识为 `server_overloaded`（兼容 `codex_error_info` 与 `codexErrorInfo`）时，runtime 只为这个 thread 建立独立的内存计时器，每次随机等待 `5–8` 秒后发送一次带恢复上下文的 `Continue.`。它不改变模型、不主动切号，也不把其他 thread 放入同一队列；Continue 再次容量失败时重新随机等待 `5–8` 秒。正常完成、非容量错误、手动中断或同一 thread 开始新的 `turn/start` 会清除这条等待记录；runtime 退出时队列不持久化。

这条恢复优先级低于无感切号：无感 ChatGPT 账号切换事务开始时会领取仍处于等待状态的容量条目，取消其计时器，并由切号后的现有恢复事务发送一次 Continue。切号被延后、取消或失败时，条目恢复为原来的等待状态；切号后的 Continue 若再次容量失败，则重新建立新的随机 `5–8` 秒计时器。Gateway 路由切换不会领取 ChatGPT 容量队列。额度耗尽 `usageLimitExceeded` 仍走独立的额度恢复/切号流程，且优先于容量错误判断。

## 为什么 runtime 强制使用 HTTP

仅调用 `account/login/start` 不足以保证已有 thread 的下一轮请求改用新账号。已验证的 Codex `0.144.2` 会为每个已加载 thread 缓存 Responses WebSocket；登录接口会更新共享认证状态，`account/read` 也会显示新账号，但旧 thread 仍可能复用由旧账号建立的 WebSocket。这会造成 Manager 显示切换成功、实际却继续扣旧账号额度。

runtime protocol v12 会为它启动的 app-server 选择一个与 OpenAI 内置配置等价、但声明 `supports_websockets=false` 的 provider。Responses 请求因此使用 HTTP streaming，并在每轮请求时重新读取当前认证。真实 Codex 二进制的本地确定性测试已经验证：同一个 thread 的第一轮携带账号 A，调用登录切换后，第二轮携带账号 B 的 access token 与 ChatGPT account ID。v12 保留无旧 Manager 账号的内存回滚快照、只读账号用量归因和有界耗尽批次，并新增每笔热切换的临时 `operationId` 终态查询；控制 socket 超时或断开时，Manager 会在仍持有共享事务租约的情况下回查 shim，而不会立即启动第二笔切换。未托管旧账号的回滚快照只在结果不确定时保留最多十分钟，成功、确定失败或完成回滚后立即清除。关闭低额度切号不会让旧批次在重新开启后重放。可选 Gateway 的双路由仅在安装集成后、显式启用且语义确认额度耗尽时，才会原地回退到 ChatGPT Auth。

Codex 会把创建会话时的 provider ID 写入本地 thread 元数据，官方界面的 `thread/list` 默认又只查询当前 provider。无感 runtime 若不处理这层过滤，安装前的 `openai` 会话和安装后的 HTTP provider 会话就会像两套独立历史。shim 只把 `thread/list` 中显式的 `modelProviders: null` 改成协议定义的空数组（所有 provider），保留显式 provider 列表不变；它不修改 rollout、`session_index.jsonl` 或 SQLite。官方界面恢复旧 thread 时会传入当前无感 provider，因此后续 turn 仍使用 HTTP transport。

代价是失去 Responses WebSocket 的跨 turn 复用，可能增加少量建连延迟和连接开销。它只影响通过已安装无感 runtime 启动的 app-server，不会启动常驻 HTTP 调度服务，也不会把 token 发给 Manager 之外的本地服务。

Dashboard 中关闭`无感切号（实验性）`会立即恢复 Manager 原有的账号写入、reload 提示和官方自动切号逻辑，但不会在运行中重启 app-server，因此底层 HTTP transport 会保留。若要连底层 transport 一并恢复为官方默认值，请运行 Remove Experimental Seamless Runtime，并按提示 reload 一次。

## 与可选 Gateway 集成的关系

Gateway 是安装后才注册的可选传输，并以一个 `accountKind: "sub2api"` 的虚拟账号出现在已保存账号和手动切换列表。虚拟账号只持久化下游 `baseUrl`、`model`、`credentialRef` 描述；下游 API Key 仍只在集成自己的 SecretStorage 中，Manager 不读取或映射 Sub2API 上游账号。它标记为 `manualOnly`/`quotaMode: "none"`，不会进入自动切号、额度候选、额度刷新、token refresh、usage-limit recovery 或 Gateway fallback 候选。独立 Gateway 面板已移除，账号卡片接收集成提供的脱敏 Base URL、模型、密钥状态、保存/刷新/打开配置动作，以及 tracker 的真实 token 用量和按配置模型估算价格；不显示 OAuth 额度、订阅或 token 健康状态。安装集成后设置中才会出现“显示 Sub2API 账号卡片”开关。

核心运行时保留常驻 Gateway adapter，并通过 `runtime/gateway/switch` 在 ChatGPT Auth 与 Gateway 路由之间切换；该事务复用同一 turn barrier、Goal 暂停/恢复和 operation lease。账号卡片手动切换提交到这条事务，不绕过 barrier；设置中的“显示 Sub2API 账号卡片”开关只控制 Dashboard 卡片可见性，不切换路由。首次安装 runtime 仍需 reload 一次，runtime 已运行后两向手动切换均不 reload。路由字段与 OAuth `currentAccountId` 分离，auth watcher 不会在 Gateway 路由期间覆盖原 OAuth 状态；切回 ChatGPT Auth 不写入虚拟账号 token 或伪造 `auth.json`。只有集成配置显式启用 `autoFallbackToChatGpt` 时，已确认额度耗尽才会单向触发现有 Gateway → ChatGPT Auth 自动回退；普通调度不会反向切回 Gateway。活动 turn/stream 中途不能迁移，必须等安全边界或按既有策略中断后再切换。安装、停用、卸载与不迁移边界见 [独立 Sub2API Gateway 与 S+ 导入器](integrations/sub2api-gateway.md)。

## 启用步骤

1. 导入至少两个属于你且允许使用的 ChatGPT/Codex 账号，并刷新全部配额。
2. 从命令面板运行 `Codex Accounts: Install Experimental Seamless Runtime`：
   - 普通本地窗口会自动配置启动路径，并提示 reload 一次。
   - Remote-SSH、WSL 和 Dev Container 中，manager 会把远端官方 Codex CLI 重命名为同目录的可回滚备份，并把原路径替换为指向 runtime launcher 的符号链接；reload 一次后生效。它不会写入 `chatgpt.cliExecutable`。
   - `chatgpt.cliExecutable` 是官方扩展的 application 级开发设置，不能由 Remote Settings 覆盖，并会优先于远端 shim 链接。启用远端 runtime 前，必须从每台连接设备的本地 User Settings 和远端 Remote Settings 中删除该键；否则 manager 会拒绝安装，避免出现跨设备启动失败或假成功。
3. 打开账号 Dashboard，使用每张账号卡片左下角的开关，将至少两个账号加入无感切号池。也可勾选多个账号后使用“设为无感切号池”或“移出无感切号池”批量操作；同一选择框还可批量“隐藏账号”/“解除隐藏”以及设置 `A/B/C` 分组或移出分组。右上角 `A/B/C` 按钮是无感候选范围筛选；未分组且未隐藏账号不会被筛掉。隐藏会立即移出池并禁止切换到该账号，解除隐藏会重新加入池。
4. 在 Dashboard 设置中开启：
   - 配额自动刷新，启用非零账号切换阈值建议 `1` 分钟；它只刷新未隐藏、已启用分组的第 `1` 页（最多 `50` 个账号），因此需自动调度的账号应通过隐藏/分组整理到该范围；
   - `无感切号（实验性）`总开关；
   - 按需开启`低额度切号`，并选择“耗尽后切换”、`1%`、`3%` 或 `5%`，默认 `3%`；关闭时不会因低额度、结构化额度耗尽或耗尽批次切号；
   - 选择通用的`切换策略`；推荐默认的“延后切换”。设置页会在其下方提供“等待时间”，用于分档和手动无感切号；若确实需要无人值守续接，可选择“中断并自动继续”，并接受非幂等外部操作可能重复的风险。
   - 分档调度默认关闭且没有设置页入口；如需启用或调整分档方式，只能在 VS Code config 中设置 `codexAccounts.seamlessSwitchQuotaBandsEnabled` 和 `codexAccounts.seamlessSwitchQuotaBandSize`。不要为此额外开启官方自动切号或五小时配额控制；
5. 官方`自动 reload window`只属于官方自动切号，对无感分档没有作用。无感 runtime 未 ready 时调度会安全跳过并保持旧账号；已进入热切换事务后的延后/失败同样保持旧账号。

对应的 VS Code 设置为：

```json
{
  "codexAccounts.hotSwitchEnabled": true,
  "codexAccounts.seamlessSwitchEnabled": true,
  "codexAccounts.hotSwitchGraceSeconds": 60,
  "codexAccounts.hotSwitchLongTurnPolicy": "defer",
  "codexAccounts.autoRefreshMinutes": 1,
  "codexAccounts.seamlessSwitchQuotaBandsEnabled": true,
  "codexAccounts.seamlessSwitchLowQuotaEnabled": true,
  "codexAccounts.seamlessSwitchQuotaBandSize": 20,
  "codexAccounts.seamlessSwitchThreshold": 3
}
```

`codexAccounts.balanceByQuotaBandsEnabled` 只作为旧本地构建的兼容读取键保留。新的 `seamlessSwitchLowQuotaEnabled` 尚未保存时会继承旧的分档开关状态；保存后两个开关独立。不要在新配置中继续使用旧键。

若要启用你当前测试的普通会话无人值守续接，把 `hotSwitchLongTurnPolicy` 改为 `"interruptAndContinue"`。它会在 60 秒后中断旧 turn，完成切号后在同一 thread 自动发送一次带恢复上下文的 `Continue`；这不是同一 turn 的精确恢复。

不要只手工修改 `codexAccounts.hotSwitchEnabled` 来安装或卸载 runtime；安装和移除都使用命令面板命令，以便管理 runtime、备份与恢复官方 CLI。日常临时关闭无感行为只需关闭 Dashboard 的`无感切号（实验性）`总开关，无需 reload。发布说明不应要求 Remote 用户填写固定绝对路径，也不应要求保留 `chatgpt.cliExecutable`。

## 分档与选号规则

普通自动调度先根据最近 15 分钟内成功刷新的真实额度窗口分类；套餐名称不参与判断：

- `windowed`（分档账号）：同时报告有效五小时窗口和有效周窗口；
- `reserve`（储备账号）：明确没有五小时窗口，但报告有效周窗口；
- `unknown`：窗口缺失、过期或带错误，暂不参与自动选择，刷新恢复后再重新分类。

五小时剩余额度可按以下四种粒度分档；只有 `windowed` 账号参与档位计算：

| 设置        | 档位边界（从高到低）                        |
| ----------- | ------------------------------------------- |
| `1/5 (20%)` | `81~100`、`61~80`、`41~60`、`21~40`、`1~20` |
| `1/4 (25%)` | `76~100`、`51~75`、`26~50`、`1~25`          |
| `1/3 (33%)` | `67~100`、`34~66`、`1~33`                   |
| `1/2 (50%)` | `51~100`、`1~50`                            |

`1/3 (33%)` 按精确三等分计算，而不是连续三个 33% 后额外留下 100% 档位。首次观察只记录基线，不立即切换；修改分档也会清除旧档位状态并重新建立基线。之后检测到当前非 Free `windowed` 账号下降到更低档位时，从无感切号池选择候选。候选必须有新鲜、无错误的周窗口，且周额度高于当前低额度阈值（选择“耗尽后切换”时只要求大于 `0%`）；优先选择当前档位不低于触发账号且五小时额度严格更高的 `windowed`。当前账号仍是最优候选或没有合格候选时保持不变，待后续刷新重试。`windowed` 候选依次比较更高档位、更高五小时剩余百分比、更早重置时间、最久未被调度，最后用账号 ID 保证结果稳定。用户发起的手动切号仍不受能力排序或阈值影响，但隐藏账号必须先解除隐藏才可作为目标。

`codexAccounts.seamlessSwitchThreshold` 可设为 `0`（耗尽后切换）、`1`、`3` 或 `5`，默认 `3`。非零值统一低额度条件：有效五小时或周额度达到该值或更低时，即使是首次观测也开始切号事务；目标相关窗口必须严格高于该值。低额度/耗尽选择先在全部合格的 `windowed` 目标中按更高五小时额度、再按更高周额度排序；没有合格 `windowed` 时才选择 `reserve`，并按更高周额度排序。额度相同才按套餐偏好 `Free/K12 → Plus → Pro`、更早五小时重置（仅 `windowed`）、最久未使用和账号 ID 决定。`reserve` 的“没有五小时窗口”是有效能力，不等同于五小时额度为零。若源账号同时被验证为 Free/K12 和有效 `windowed`，候选中的 Free/K12 账号必须在最近两分钟内成功刷新；这同时适用于有五小时窗口和 `reserve` 的 Free/K12 目标，但不会触发强制刷新。非零事务使用零等待期，但**不会覆盖**普通会话策略。

阈值为 `0` 时并不是关闭调度。普通分档仍按原始分档下降工作，并且会携带近期恢复集合：如果额度刷新滞后、turn 已经因额度耗尽终止，随后发生的跨档切换仍会在目标账号续接它。只有同档内继续下降才进入耗尽批次规则。shim 在第一个结构化额度终止信号到来时快照所有可识别的活动 thread；只有快照中的每一个 thread 都以额度耗尽终态结束，才把批次标为可切换。任一 peer 正常完成、被手动中断、出现非额度错误或用户开始新工作都会取消该**调度批次**，但不会删除既有的近期恢复记录；同一批次的迟到终态也不能把已取消的批次重新缩小建立，下一次新工作才会开始新的观察范围。批次最多观察 6 小时；到期后即使仍有原始会话活动，也将发起切号事务并交给通用普通会话策略决定延后、中断或继续。

终态 `error` 通知中的 `error.codexErrorInfo: usageLimitExceeded`、`turn/start` 的同类 JSON-RPC 拒绝，以及兼容失败 turn 中的同类结构化错误，都会把对应 thread 写入一个有界的近期恢复集合。该集合的保留期为 6 小时。非零阈值监视器每两秒读取固定大小的 runtime 状态（不请求 thread ID、正文或历史），遇到新失败才读取一次当前账号并发起低额度选择；“耗尽后切换”监视器也每两秒轮询，但只在批次已就绪时发起选择。未能切换时约每十秒重试，状态 RPC 失败退避三十秒。成功切号后，普通 thread 获得一次恢复标记的 `Continue`，持久 Goal 则先暂停再恢复，已处于 `usageLimited` 的 Goal 会显式重新设为 `active`。任何更新的 `turn/start` 都会清除其旧记录，避免重复续接。runtime 状态只暴露有界计数、批次就绪标记和单调批次号，不暴露 thread 内容。

自动 Continue 始终是新 turn，不是原 turn 的 exactly-once 恢复。正在执行部署、消息发送、支付或其他非幂等外部写操作时可能产生重复副作用，因此只应在接受该风险时选择“中断并自动继续”。

## 并发屏障

shim 以真实 `turn.id` 跟踪 app-server 中的活动 turn：

1. 收到切号请求后进入 pending 状态。
2. 已发送的 `turn/start` 和已经开始的 turn 都计入屏障。
3. `turn/steer`、`turn/interrupt` 等属于当前 turn 的消息继续透传。
4. 新的 `turn/start`、`review/start` 和 `thread/compact/start` 暂存在内存队列。
5. 对活动 turn 的 thread 调用 `thread/goal/get`；发现 `active` Goal 时只把状态改为 `paused`，保留 objective、token budget 和累计用量。Goal mutation 请求也会在事务期间排队。
6. 到达本次切号的处理边界：
   - 分档与手动切号等待 `codexAccounts.hotSwitchGraceSeconds`（默认 60 秒）；低额度和耗尽后切号以零等待期开始；
   - 仍活动的 Goal turn 会暂停，并在需要处理时调用 `turn/interrupt` 后等待 `turn/completed`；
   - 普通 turn 一律按 `codexAccounts.hotSwitchLongTurnPolicy` 选择延后、中断，或中断后自动续接；
   - 无法取得 `threadId`/`turnId` 的在途请求始终延后，绝不带着未知活动 turn 切认证。
7. 仅当活动 turn 数为零时调用实验性 `account/login/start`，并等待 `account/login/completed(success=true)` 后再提交切换。若当前 Gateway provider 声明 `requiresOpenaiAuth=false`，`account/read` 返回 `account: null` 是协议语义，不再把它误判为账号不一致；在仍提供 ChatGPT 身份时才比较实际 access token 中的 runtime email，而不是稳定账号记录中的 ID-token email，两者可能是同一 user ID 的不同邮箱别名。
8. 身份校验成功后由 manager 提交目标账号及 `auth.json`，再恢复 Goal 为 `active`。选择 `interruptAndContinue` 时，为由本次切换中断且最终状态确认为 `interrupted` 的非子代理普通 thread 启动一个带内部恢复上下文的新 `turn/start`；任何带近期额度恢复标记的切换也会续接尚未开始新工作的非子代理普通 thread。multi-agent 子代理由其父代理负责后续调度，shim 不会向它们直接发送 `Continue`。
9. 登录、身份校验或本地账号提交失败时，尝试同时回滚 app-server 与 manager 当前账号并恢复 Goal；在旧 turn 仍活动时不会把失败降级成“先写认证再 reload”。如果旧身份不在 Manager 账号库中（例如曾删除全部账号），事务开始前会从有效 `auth.json` 读取仅驻留内存的回滚快照，并先用 live app-server 身份确认它确实对应当前账号；快照不会被自动导入或写入日志。

在分档或手动切号的 60 秒等待期内，Goal pause 不会强制终止正在执行的命令或 tool call；当前 turn 仍按旧账号和原权限运行。低额度或耗尽后切号会立即进入同一策略处理边界。需要 interrupt 时，它会终止这一轮，Goal 的下一轮自动续跑发生在账号身份切换之后。由于 app-server 和 thread 没有重建，`cwd`、runtime workspace roots、sandbox policy、approval policy 与 named permission profile 保持原 thread 的 sticky 设置。一次性“仅批准本次操作”仍按 Codex 自身语义只对那次操作有效，不会被热切换扩展为持久权限。

现场验证还确认了一个进程边界：`turn/interrupt` 会结束 Codex turn，但不保证终止该 turn 已启动的所有本地子进程。无感恢复前应避免正在执行不可重复的部署、消息发送或外部写操作；扩展无法在多个并发 turn 之间安全判断任意 app-server 子进程的归属，因此不会擅自按进程树批量杀进程。

普通会话的自动 Continue 不是恢复同一个 turn，而是在同一非子代理 thread 中新建一轮。恢复上下文会要求先检查 thread 历史、当前工作区与已完成工具结果，只继续未完成部分；这能降低重复执行概率，但无法为任意 MCP、网络请求、消息发送或其他非幂等外部副作用提供 exactly-once 保证。因此它是显式 opt-in 的实验策略，不通过创建“临时 Goal”实现，也不会覆盖或留下持久 Goal。multi-agent 子代理保留给父代理/会话编排控制：shim 只读其 thread 元数据后跳过直接 `turn/start`，避免 app-server 拒绝对子代理的直接输入。

每个 VS Code extension host 都有独立屏障。自动调度、手动选择、外部 `auth.json` 收敛和 Gateway → ChatGPT 回退在最终改变 app-server 身份前，都会进入同一条可续租的跨宿主 `runtime-switch` 事务；同一宿主的第二笔请求会被抑制。跨窗口仍依靠共享账号修订与 `auth.json` 变化传播目标账号，而不是把多个 app-server 伪装成分布式原子事务；文件 watcher 之外还有两秒 stat/revision 轮询兜底，降低 Remote-SSH、网络文件系统或多设备连接时漏事件的影响。窗口会在各自正在运行的 turn 完成后收敛，因此切换期间允许旧 turn 按原账号正常结束。收到 deferred 结果后会继续定时尝试，直到该窗口的 runtime 已是目标账号；确定失败不会无限重试。

同一 app-server 中的多个会话可能让 `turn/completed` 早于对应的 `turn/start` RPC 响应到达 shim，或让同一 thread 的活动 turn ID 在 shim 收到完整通知前被 app-server 替换。runtime 会保留有界的终态 turn ID 集合，避免迟到响应或通知把已完成 turn 重新计为活动；若 interrupt 明确返回“预期 turn A、当前为 turn B”，只会为该同一 thread 对账到 B 并重试一次中断，且仅在 B 确认 `interrupted` 后才自动 Continue。若 interrupt 明确返回“该 turn 已不活动”，则将其视为 app-server 的终态确认并继续屏障，而不会吞掉其他中断错误。

控制桥的请求上限为“配置等待期 + 2 分钟事务缓冲”，不再固定等待 30 分钟。管理端主动取消或连接关闭会恢复此前暂停的 Goal 后放行队列；已经开始执行的登录事务不会被中途打断。对带 `operationId` 的事务，socket 超时或断开后 Manager 最多再回查两分钟 shim 的 `pending`、`switching`、成功或失败终态，并持续持有共享租约；shim 重启导致终态丢失时会明确要求 reload，而不是猜测身份。如果目标登录和旧账号回滚都失败，runtime 身份属于不确定状态，必须 reload 以重新建立可信状态。

## 多宿主共享状态与本地用量

Mac、Windows 和 Remote-SSH 窗口可能同时读写同一个远端扩展存储目录。Manager 对账号索引、Aideck token 与配额镜像使用 UUID 临时文件和原子替换，并在短期共享租约下执行三方合并；一个宿主刚导入、删除或刷新账号时，另一个宿主的旧内存快照不会直接覆盖新状态。后台 token 刷新、配额扫描和调度各自使用可过期租约，最终 runtime 身份交接另用可续租的 `runtime-switch` 租约，宿主异常退出后其他实例可回收租约继续工作；手动刷新不依赖等待后台租约完成。

本地会话用量聚合也采用共享缓存，但不会把某个窗口启动时的旧副本永久留在内存。统计按 rollout 的累计 token 高水位取增量，忽略同一累计值的重复/过期上报；spawned subagent 中复制的父会话历史只建立基线，从子代理自己的 trigger-turn 边界后才计入新增。每次读取会采用 `calculatedAt` 严格更新的共享结果；到达 `nextRefreshAt` 时 Dashboard 主动更新，而不是必须关闭重开面板。扫描操作由独立可过期租约去重，避免多个设备重复遍历同一批本地会话。

账号卡片下方的当前额度窗口 Token 统计不另起扫描：同一轮既有会话扫描只读取原有 token 元数据，并把最多 2 MiB 的归因 journal 尾部索引到本地账号。journal 只记录不透明本地账号 ID、thread ID 与时间；账号窗口缓存仅保留该本地 ID、额度 reset 时间及汇总 token 数，文件权限为 `0600`。Manager 启动或 runtime 重启时若归因握手晚于当前 `turn/start`，会在身份确认后激活归因并为仍活动的 thread 补记；账号切换和 ChatGPT 路由重新激活后也会重新同步，失败会保留可读原因并每 5 秒重试。它不回填安装前、激活失败期间或未受管的历史；账号窗口独立保留最长 31 天的受管元数据，即使本机用量面板仅展示 14 天。卡片把同一额度周期中相差不超过一分钟的 `reset_at` 观测合并到当前五小时/周额度 reset 边界，因此切号后只累计对应账号；实际额度重置后旧统计立即归零并等待新受管 turn。runtime 若只返回一个 `primary` 窗口，会按实际 `window_minutes` 判定短期或长期，因此不把 Plus 等长周期额度错误归为五小时。没有逐 token IPC、额外网络请求或会话正文的第二次加载。

这些机制提供最终收敛，不把多个 app-server 伪装成单一原子事务：已经开始的 turn 仍按其原身份运行到安全边界，各宿主随后热切换到共享活动账号。现场核验应同时检查 Manager 当前账号、runtime 身份以及额度刷新时间，不能只根据某一台设备缓存的卡片顺序判断是否切换成功。

## 安全与兼容性边界

- shim 与 manager 使用当前 extension-host PID 对应的本地 Unix socket；目录权限为 `0700`，socket 为 `0600`。
- shim 在收到成功的 `initialize` 响应或客户端 `initialized` 通知后即可进入 ready；状态接口同时报告两个握手信号，便于区分官方扩展版本差异。热切换已启用但 bridge 未 ready 时，Manager 必须失败关闭，不能回退为磁盘切号。
- runtime protocol v12 的状态接口必须同时报告 `httpTransportForced=true`、`attributionActive` 和 `attributionFailureReason`；旧 shim 即使 socket 可连接也会要求一次 reload，避免认证状态已变化但旧 WebSocket 继续计费。`operationId` 仅是短期不透明标识，shim 最多保留 64 条、十分钟内的无凭据终态；诊断身份接口只返回 app-server 当前账号的非凭据字段与 Manager 本地账号 ID，不返回 access token。
- access token 只通过进程内存和本地 IPC 传递，不写入 shim 配置，也不输出到日志。runtime 配置文件只保存官方 Codex CLI 的绝对路径及受保护的归因 journal 目录；两者均不含账号身份或凭据。
- token 临近过期时由 manager 使用原有 OAuth 刷新逻辑更新；app-server 的 refresh 回调必须匹配原 ChatGPT account ID，否则拒绝返回凭据。
- 同一 workspace ID 可能对应多个已导入用户。manager 在切换前校验 access token 的 user ID 与本地账号记录一致，再把 access token 的 runtime email 交给 app-server 身份校验；稳定账号记录邮箱与 runtime email 允许是同一 user ID 的不同别名。refresh 与失败回滚以 manager 本地账号 ID 和 workspace ID 为主；缺少本地身份且 workspace ID 不唯一时安全失败，不按数组顺序猜测账号。
- 该能力依赖 Codex app-server 的 experimental API。当前实现按本机 Codex `0.144.5` schema 和官方 VS Code 扩展 `26.707.91948` 验证；官方扩展升级后必须重新跑测试。协议在初始化前即不可用时可走原 reload 路径；事务已经开始后发生的不兼容会安全失败并保持/回滚旧账号。
- 持久 Goal 的暂停/恢复依赖同一 schema 中的 `thread/goal/get`、`thread/goal/set` 与 `active`/`paused` 状态；任何一步无法确认都会终止切换并尝试恢复原 Goal，而不是清除 Goal。
- 当前 runtime 安装路径支持 Linux 和 macOS，Windows 会明确拒绝启用。Windows 的无 shell CLI bootstrap 尚未实现和验证。
- 账号额度、产品规则和服务条款不会被此功能改变。只应调度你有权使用的账号。

## 禁用与回滚

只想临时恢复原有切号逻辑时，关闭 Dashboard 的`无感切号（实验性）`总开关即可；runtime 继续作为透明代理运行，下一次切号会走原有账号写入和 reload 提示。

若要完整卸载 runtime，从命令面板运行 `Codex Accounts: Remove Experimental Seamless Runtime`。普通本地窗口会自动恢复安装前的 `chatgpt.cliExecutable`；Remote 环境只会在当前 CLI 链接仍指向 manager launcher 时恢复同目录备份的官方二进制，绝不覆盖其他工具建立的链接。按提示 reload 一次，即可回到官方标准启动路径。官方 Codex 扩展升级后会使用新安装目录；若无感切号仍启用，manager 会为新目录重新准备 runtime 并再次请求一次 reload。完整卸载也会恢复官方“当前 provider”历史过滤；无感 provider 下的会话仍保存在本地，可通过重新安装 runtime 或 `codex resume --all --include-non-interactive` 访问，本功能不会在卸载时批量改写历史元数据。

## 开发验证

不需要真实凭据的核心检查：

```bash
node --check runtime/codex-app-server-shim.cjs
npx vitest run test/hotSwitchBridge.test.ts test/hotSwitchRuntime.test.ts test/refreshCoordinator.test.ts test/quotaBandBalancing.test.ts
CODEX_APP_SERVER_BIN=/path/to/codex npm run verify:seamless-auth
npm run verify
npm run package
```

`test/hotSwitchBridge.test.ts` 使用假的 app-server 验证跨 provider 历史合并且不覆盖显式 provider 过滤、多个并发 turn、切换屏障、排队 turn、token refresh 回调、60 秒策略的缩短测试版本、普通 turn 延后/中断/同 thread 续接、当前协议终态 `error` 通知及兼容失败 turn 的额度耗尽恢复与防重复、模型容量错误的独立延迟恢复/重复失败重排队/切号抢占，以及持久 Goal 的暂停、interrupt、断连恢复、切号后自动续跑和 thread-sticky workspace 权限；测试 fixture 不包含真实账号数据。

`verify:seamless-auth` 使用两个合成的未签名 JWT 和仅监听 `127.0.0.1` 的临时 HTTP server，不读取任何已导入账号。它以与 runtime 相同的参数布局启动指定 Codex，先确认每次 `account/read` 都报告当前 access token 的 runtime email，再验证同一 thread 在 A→B 登录切换后的两个 Responses 请求分别携带对应的合成认证；验证结束会删除临时 `CODEX_HOME`。升级官方 Codex 后应重新运行此检查。
