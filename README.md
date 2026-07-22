# Codex Accounts Manager

[English](README.en.md) · 简体中文

VS Code 扩展，用于管理多个 Codex 账号、查看配额总览，并快速切换当前生效的全局 `auth.json`。

![Version](https://img.shields.io/badge/version-0.1.16-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.96.0-007acc)
![License](https://img.shields.io/github/license/wannanbigpig/codex-tools)
![Stars](https://img.shields.io/github/stars/wannanbigpig/codex-tools?style=flat)
![Last Commit](https://img.shields.io/github/last-commit/wannanbigpig/codex-tools)

---

用于在 VS Code 中统一管理 Codex 多账号、查看配额、切换当前账号，并通过状态栏快速监控使用情况。

**功能：** 配额总览面板、多账号管理、OAuth 添加账号、首次本地账号自动检测与绑定、导入当前 `auth.json` 后立即刷新、跨窗口账号同步、共享 JSON 恢复/导出、Codex App 联动与可选重启、自动切号、后台 token 自动刷新、详情面板、多语言界面及本扩展语言覆盖设置。

**语言：** 默认跟随 VS Code 语言设置，当前主要支持简体中文、English，并提供其他语言的本地化支持。

**扩展能力：** 如果你需要更完整的会话管理、CLI 启动、多实例调度等 AI 开发工作台能力，可以安装 uTools 插件 **AiDeck**。AiDeck 项目地址：[https://github.com/wannanbigpig/aideck](https://github.com/wannanbigpig/aideck)。

---

## 界面预览

| 配额总览                                                                                                                                   | 详情面板                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/dashboard.png" alt="Codex Tools 配额总览" width="420" /> | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/detail.png" alt="Codex Tools 详情面板" width="420" />   |
| 设置面板                                                                                                                                   | 状态栏                                                                                                                                    |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/setting.png" alt="Codex Tools 设置面板" width="260" />   | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/status_bar.png" alt="Codex Tools 状态栏" width="220" /> |

---

## 功能概览

### 配额总览面板

提供一个 Webview 仪表盘，用来集中查看和管理所有 Codex 账号：

- 当前账号摘要：显示当前账号、当前团队与快捷操作
- 配额仪表：展示 5 小时、每周、代码审查配额
- 已保存账号列表：集中查看所有已保存账号
- 快捷操作：添加账号、导入当前账号、刷新当前显示页的账号配额（每页最多 50 个）
- 支持从卡片进入账号详情、切换账号、刷新、重新授权、重连会话、编辑标签、分享/导入恢复

### 多账号管理

- 通过 OAuth 添加新账号
- 无已绑定账号时自动检测本机已有的 Codex `auth.json`
- 检测到本地账号后可一键绑定到扩展
- 导入当前本机正在使用的 Codex `auth.json`
- 导入或绑定后立即刷新最新配额
- 本地保存多个账号
- 一键切换当前生效账号
- 删除不再使用的账号
- 从备份恢复全部账号
- 从 `auth.json` 恢复账号记录
- 从共享 JSON 恢复/导入账号并保留覆盖提示

### 跨窗口同步

- 文件监听提供低延迟更新，并以每 2 秒一次的轻量 `stat` revision 轮询兜底，因此服务器 inotify 额度不足时仍能发现账号索引、`auth.json` 与 token mirror 的外部变化
- 多个 Mac/Windows Remote VS Code extension host 共享账号数据时，索引写入在短租约内基于最新磁盘快照合并，token/quota mirror 使用原子写入，避免一个宿主覆盖另一个宿主刚写入的字段
- 定时配额刷新和 token sweep 使用共享短租约避免重复请求；手动刷新仍可随时执行
- 其他窗口切换账号后，各自独立的 Codex app-server 会在本窗口 turn 的安全边界上收敛；无感切号关闭时仍使用原有 reload 提示

### Codex App 联动

- 切换账号后可检测本机是否安装 Codex App
- 默认在 App 运行时尝试重启并应用新账号状态；未运行则跳过，不会强行拉起
- 支持“自动重启”与“手动确认重启”两种策略
- 允许配置自定义 Codex App 路径
- 当前已兼容 macOS、Windows、Linux 的常见安装路径与进程检测

### 与 AiDeck 搭配使用

本扩展专注于 VS Code 内的 Codex 多账号管理、配额查看与快速切换。如果你需要更完整的会话管理、会话恢复、Codex 等 CLI 启动与多实例调度能力，可以安装 uTools 插件 **AiDeck**。

AiDeck 提供面向 Antigravity、Codex 等环境的统一调度层，适合需要在多个账号、多个实例和不同 AI 开发入口之间切换的场景。

项目地址：[https://github.com/wannanbigpig/aideck](https://github.com/wannanbigpig/aideck)

### 自动切号与低配额提醒

- `5 小时配额控制` 默认关闭；关闭时配额仍正常展示，但不会触发自动切号或低配额提醒
- 只有接口返回有效配额窗口时才会参与自动化判断，避免缺失窗口被误判为 `0%`
- `刷新后`按配置自动切换到可用备用账号
- 可分别设置 5 小时与每周阈值（0~20%，默认 20%）
- 可设置临时锁定时长，避免刚触发后被频繁切号
- 配置低配额告警，触发后显示本地化提示

### 实验性无感切号与分档平衡

- 官方`自动切号`保持原有阈值、选号和 reload 行为；本地新增的额度分档、账号池、无 reload 执行及会话恢复全部位于独立的`无感切号（实验性）`
- `无感切号`具有独立总开关；关闭后手动切号和外部账号变化恢复原有写入账号并按需 reload 的流程，不卸载 runtime，再次开启无需重新配置 shim
- 无感分档不依赖官方`自动切号`或`5 小时配额控制`；启用后会优先使用自己的安全调度路径，runtime 不可用时不会回退为磁盘切号
- 每张账号卡片左下角都可独立控制是否加入无感切号池，也可用批量操作设置多个账号。普通调度只依据最近 15 分钟内成功刷新的实际窗口分类：同时有有效五小时和长期窗口的是 `windowed`；API 明确没有五小时窗口但有有效长期窗口的是 `reserve`；窗口缺失、配额失败或过期的是 `unknown`。不会根据 Free、Plus 等套餐名称猜测普通额度能力
- 勾选卡片左上角可批量隐藏/解除隐藏账号；隐藏成功后会自动取消相应卡片的勾选。隐藏账号默认不显示、以紫色标识，立即移出无感切号池，并被排除在所有自动和手动切换候选之外。解除隐藏时会自动重新加入无感切号池；面板右上角的眼睛按钮可显示隐藏账号
- Saved Accounts 右上角提供“隐藏周额度 <3%”按钮：只隐藏当前显示范围内、已识别周额度且严格低于 `3%` 的未隐藏账号，不会处理没有周额度窗口的账号
- 同一区域的“解除隐藏周额度 >90%”按钮会检查全部隐藏账号（不受当前分组显示限制），仅恢复已识别周额度且严格高于 `90%` 的账号；恢复时自动加入无感切号池并移出所有 `A/B/C` 分组，普通批量解除隐藏仍保留原分组
- 可将账号批量放入 `A`、`B`、`C` 分组，账号卡片会显示分组标签；面板账号列表右上角的 `A/B/C` 按钮控制对应分组是否显示。未分组且未隐藏账号始终显示且始终保留在无感候选范围内；关闭某分组会同时排除该分组账号的无感分档、Free 1% 和储备候选，但不影响手动切号或原官方自动切号。当前激活账号属于关闭分组时不会被立即强制切走，而是在原有触发条件满足后只切往当前显示范围的候选
- 已保存账号按每页最多 `50` 张卡片分页；隐藏、解除隐藏及分组显示变化会立即重新分页，页码越界时自动回到有效页。
- Dashboard 的“刷新当前页配额”只刷新这一页的当前显示账号；卡片刷新、明确选择的批量刷新和命令面板的显式全量刷新保持按明确目标执行。
- 定时配额刷新同样只处理未隐藏且分组已启用的第 `1` 页（最多 `50` 个账号）；其余账号不会被后台轮询，可按需手动刷新。
- 已验证为 Free 且拥有有效五小时窗口的账号不参与普通 `20%/25%/33%/50%` 分档，也不会在 `1%/2%/3%` 储备阈值提前切走；开启 Free 1% 耗尽保护后才会在 1% 或 runtime 的额度耗尽信号时切换
- `windowed` 账号继续使用 20%、25%、33% 或 50% 分档平衡。新增储备阈值可选 `1%`、`2%`、`3%`（默认 `3%`）：只要池中仍有五小时额度高于阈值的安全 `windowed` 就优先使用它；全部触达阈值后才切到长期额度最高的 `reserve`
- 当前为 `reserve` 时，其长期额度高于储备阈值便保持使用；触达阈值后先切回已恢复的 `windowed`，没有时再选择长期额度最高的其他 `reserve`。这套候选规则只影响自动调度；未隐藏账号仍可手动切换
- 可选开启 `1% 耗尽保护（Free 优先）`：当前有效五小时或长期额度降到 1% 或更低时绕过普通等待期，立即中断活动 turn 并自动 `Continue`。若当前账号是同时具有实际有效窗口的 Free 账号且五小时耗尽，优先选池中五小时额度最高、周额度高于储备阈值的 Free 账号；没有合格 Free 时才回到原有混合安全选号（windowed/reserve）。Free 专用候选必须在最近两分钟内刷新；普通调度仍使用 15 分钟窗口。runtime 也会用固定大小状态识别近期结构化 `usageLimitExceeded`（包括 `turn/start` 的结构化 RPC 拒绝），无需加载会话正文或历史，默认关闭
- 当前账号下降一档后，默认等待 60 秒让正在运行的 Codex turn 自然完成，再在同一个 app-server 中热切换账号
- 活动持久 Goal 会先暂停；等待期后仍未结束则中断旧 turn，切号成功后自动恢复；同一 thread 的工作区、sandbox 与 approval 设置保持不变
- 普通会话可选择延后切换、中断后手动继续，或实验性的中断后同 thread 自动 `Continue`；自动续接无法为非幂等外部操作提供 exactly-once 保证
- multi-agent 子代理不由 shim 直接 `Continue`，切换后仍由其父代理和会话编排决定是否重新调度
- 普通会话策略和等待时间始终显示；热切换已启用但 runtime 未 ready 时安全失败，不会出现只改磁盘账号、运行中 app-server 未切换的假成功
- 屏障期间新的 turn 会排队，原 conversation/thread 保持不变；后续成功切换不需要 reload window
- 多个会话共享同一 app-server 时，runtime 会容忍 `turn/completed` 与 `turn/start` 响应乱序，并对已经结束的 turn 做安全对账；其他窗口的切换若被 defer，会在安全边界后自动重试收敛
- runtime 会禁用 Responses WebSocket 复用，确保已有 thread 的下一轮真正使用新账号；代价是可能增加少量 HTTP 建连开销。关闭无感总开关只恢复原切号逻辑，完整恢复官方 transport 需移除 runtime 并 reload
- runtime 会把官方界面显式限定为“当前 provider”的历史查询扩展为所有 provider，因此安装无感 runtime 前后的本地会话会出现在同一历史列表；它只调整 `thread/list` 请求过滤，不改写会话文件或状态数据库
- 删除全部受管账号后首次切换到新导入账号时，Manager 会从当前有效 `auth.json` 建立只驻留于内存的回滚快照，并用 live app-server 身份校验；切换失败会恢复旧身份，无需先关闭无感切号
- 本地用量按每个 rollout 的累计高水位计算，忽略重复/过期 `token_count`，并把 spawned subagent 复制的父会话历史仅作为初始基线；聚合缓存会采用其他宿主写入的更新 `calculatedAt`，Dashboard 在 `nextRefreshAt` 主动刷新，缓存仍只保存统计值，不保存会话正文、账号标识、凭据或会话路径
- 已安装的无感 runtime 会在受管 turn 开始时批量写入极小的本地归因记录；它只含不透明的本地账号 ID、thread ID 与时间，不含提示词、会话正文、邮箱、远端账号 ID 或凭据。账号卡片会复用原有的 15 分钟会话扫描，把既有 `token_count` 元数据聚合到当前五小时（无五小时窗口时为长期/周）额度窗口；若 runtime 只返回一个 `primary` 窗口，则按实际 `window_minutes` 判断其属于短期还是长期，不会把 Plus 等长周期额度误当成五小时窗口。没有逐 token IPC、额外网络请求或第二次正文扫描。统计只从首次受管 turn 起生效，不回填历史；额度 reset 时间变化后旧桶立即不再匹配，卡片显示 0 并等待新受管 turn。
- 该功能仍是进程级单账号，不支持给同时运行的不同 turn 分配不同账号
- 首次安装 runtime 需要运行 `Codex Accounts: Install Experimental Seamless Runtime` 并 reload 一次；Remote-SSH/WSL/Dev Container 会在远端官方 Codex CLI 旁保存可回滚备份并建立 shim 链接，不再修改本机 VS Code 的 `chatgpt.cliExecutable`
- 详细启用步骤、分档规则、兼容范围与回滚方式见 [docs/HOT_SWITCH.md](docs/HOT_SWITCH.md)

#### 如何启用与配置

1. 导入至少两个你有权使用的 Codex 账号，并执行一次“刷新全部配额”。
2. 从命令面板运行 `Codex Accounts: Install Experimental Seamless Runtime`。首次安装后按提示 reload 一次；之后的成功切号不再需要 reload。
3. 在 Remote-SSH、WSL 或 Dev Container 中，不要设置 `chatgpt.cliExecutable`。它是官方扩展的 application 级开发设置，会跨窗口/设备覆盖并可能让另一台机器无法启动 Codex。安装命令会仅在远端扩展安装目录中备份官方 CLI 并建立可回滚 shim 链接；如曾手工添加该设置，请从每台本地 VS Code 的 User Settings 和 Remote Settings 中删除后再安装。
4. 在账号 Dashboard 使用每张卡片左下角的开关，将至少两个账号加入无感切号池；也可勾选多个账号后使用批量按钮，并可批量放入 `A/B/C` 分组或移出分组。右上角的分组按钮决定哪些分组显示并参与无感候选；未分组且未隐藏账号固定保留。账号必须有新鲜、有效的周窗口；同时有五小时窗口的账号会被归为分档账号，明确没有五小时窗口的账号会被归为储备账号，数据缺失、过期或报错的账号暂不参与自动选择。
5. 打开 Dashboard 设置，启用“无感切号（实验性）”和“额度分档无感平衡”，选择所需分档（默认 `1/5 (20%)`）与储备切换阈值（`1%`、`2%` 或 `3%`，默认 `3%`），并把配额自动刷新设为 `1` 分钟。该定时任务只刷新当前隐藏/分组范围的第 `1` 页，需自动轮换的账号应放入这一页。
6. 设置等待时间和普通会话策略：推荐先使用 `defer`；需要在 Free 五小时额度耗尽时强制保护可另行启用“1% 耗尽保护（Free 优先）”，但必须接受自动续接可能重复非幂等工具操作的风险。

对应的用户行为配置示例：

```json
{
  "codexAccounts.seamlessSwitchEnabled": true,
  "codexAccounts.seamlessSwitchQuotaBandsEnabled": true,
  "codexAccounts.seamlessSwitchQuotaBandSize": 20,
  "codexAccounts.seamlessSwitchReserveThreshold": 3,
  "codexAccounts.seamlessSwitchEmergencySwitchEnabled": false,
  "codexAccounts.autoRefreshMinutes": 1,
  "codexAccounts.hotSwitchGraceSeconds": 60,
  "codexAccounts.hotSwitchLongTurnPolicy": "defer"
}
```

`codexAccounts.hotSwitchEnabled` 与 runtime shim 由安装/移除命令管理；本地窗口仍会管理 `chatgpt.cliExecutable`，Remote-SSH/WSL/Dev Container 则管理远端官方 CLI 的可回滚 shim 链接。不要只手工修改技术开关来安装，也不要保留跨设备的 `chatgpt.cliExecutable` 路径。无感分档不要求同时开启官方“自动切号”或“5 小时配额控制”。

#### 启用后的效果

- 空闲时手动切号会在同一个 Codex app-server 中更新认证，现有 conversation/thread 保持不变，不弹出 reload 提示。
- 运行中的 turn 会先获得配置的自然完成时间；`defer` 会安全延后本次普通会话切换，`interruptAndContinue` 会中断旧 turn，并在切号后为同一 thread 自动发送一次带恢复上下文的 `Continue`。
- multi-agent 子代理不会收到 shim 注入的 `Continue`，避免越过 Codex 的父代理编排；其后续执行由父代理决定。
- 活动 Goal 会先暂停；超过等待时间后可中断旧 turn，切号成功后自动恢复原 Goal、workspace、sandbox 和 approval 状态。
- 自动刷新发现当前分档账号的有效五小时剩余额度下降一个已配置档位时，会优先选择五小时额度严格更高且周额度高于储备阈值的分档账号；全部可用分档账号都降到阈值后，才切到周额度最高的储备账号。当前账号仍是最优候选时保持继续消耗，修改档位会先建立新基线，不会立即误切。
- 当前账号是储备账号时，只要其周额度仍高于储备阈值就保持使用；降到阈值后会先尝试已经恢复到阈值以上的分档账号，否则选择周额度最高的其他储备账号。手动切号不受上述自动排序限制。
- 启用 `1% 耗尽保护（Free 优先）` 后，首次观测到有效五小时或周额度为 1% 也会触发；活动 turn 会先中断，刚刚因额度耗尽而结束的普通会话会在切号后收到一次带恢复上下文的 `Continue`，持久 Goal 则通过暂停/恢复继续；已经处于 `usageLimited` 的 Goal 会被显式重新激活。若当前实际有效五小时窗口的 Free 账号耗尽，先在最近两分钟内刷新的 Free 池成员中选择五小时额度最高、周额度高于储备阈值的账号；没有合格 Free 时才使用原有混合安全排序。终态通知与 `turn/start` 的结构化额度拒绝都会被固定大小 runtime 状态识别；近期失败记录只保留两分钟，并在同一 thread 开始新工作时清除，不会成为持久停止状态。无合格候选、当前账号仍为最高额度或 runtime 失败时保持旧账号并在后续刷新重试。
- runtime 会强制下一轮使用新的 HTTP 认证，避免旧 thread 继续复用旧账号 WebSocket。身份校验、runtime 或回滚失败时会 fail closed，保持或恢复旧账号，不把仅写入磁盘误报为成功。
- Codex 历史列表会同时包含安装 runtime 前以 `openai` 记录的会话和安装后以无感 HTTP provider 记录的会话；打开旧会话时仍按当前无感 provider 恢复，不需要迁移本地历史。
- Dashboard 和状态栏会显示新的活动账号；底层仍是全局单账号，不是每个 conversation 独立绑定账号。
- 关闭“无感切号（实验性）”会恢复原有写入账号与 reload 流程但保留 runtime；若要恢复官方默认 transport，运行 `Codex Accounts: Remove Experimental Seamless Runtime` 并按提示 reload 一次。

### 后台令牌刷新与网络调试

- 支持后台自动刷新已保存账号的 token（默认开启）
- 可查看上次检测、上次刷新、下次检测时间
- 可选开启 `Codex Accounts Network` 调试日志

### 配额查看

每个账号支持查看：

- 5 小时配额百分比
- 每周配额百分比
- 代码审查配额百分比
- 剩余重置时间
- 最近刷新时间

### 状态栏监控

- 在状态栏显示当前账号配额摘要
- 支持从总览面板将指定账号加入状态栏摘要（可选固定显示）
- 点击状态栏可直接打开完整配额面板

### 多语言界面

- 自动跟随 VS Code 当前语言环境
- 当前主要支持简体中文、English，并提供其他语言的本地化支持
- 配额总览面板、提示文案和交互文本会随语言切换
- 也可以在扩展设置中单独指定本扩展使用简体中文、English 或其他受支持语言，不影响 VS Code 其他界面

### 详情面板

支持打开单个账号详情页，查看更多原始信息，包括：

- 账号邮箱
- 团队 / 组织信息
- 用户 ID / 账号 ID
- 配额原始返回数据

### 更新公告

- Dashboard 在消息中心和弹窗中展示更新公告，支持单条标记已读 / 全部已读。
- 更新公告建议按 `releaseVersion` 声明当前版本，并且使用**每个版本独立的 `id`**，避免旧版本已读状态影响新版本显示。
- `announcements.json` 以“当前版本的更新公告”为准，历史版本内容统一在 [docs/CHANGELOG.md](docs/CHANGELOG.md) 追加记录，历史文档不删除。

---

## 设置项

可在总览面板右上角设置按钮中直接调整，也可以通过 VS Code Settings 搜索 `codexAccounts` 修改。

- `语言`
  - `自动（跟随 VS Code）`，或手动指定简体中文、English 及其他受支持语言
  - 仅影响本扩展的总览面板和提示文案
- `Codex App 重启策略`
  - 可开启或关闭该联动
  - 开启后可选择：
  - `自动重启`：切换账号时如果 Codex App 正在运行则直接重启
  - `手动确认重启`：切换后每次手动确认是否立即重启
- `配额自动刷新`
- 可关闭，或设置为 `1 ~ 60` 整数分钟
  - 默认关闭
  - 关闭后不再定时刷新；开启后仅刷新未隐藏、已启用分组的第 `1` 页（最多 `50` 个账号）
  - 其他账号保留单卡、批量选择和命令面板手动刷新，不会被后台轮询
- 当前已支持 `1~60` 分钟的任意整数取值
- `自动切号`
  - 默认关闭
  - 开启后可分别设置 `5 小时` / `每周` 配额阈值
  - 刷新后如果当前激活账号触达阈值，会尝试自动切换到其他可用账号
  - 5 小时阈值仅在 `5 小时配额控制` 开启时生效；每周阈值独立生效
- `无感切号（实验性）`
  - 总开关关闭时恢复原本的账号切换/reload 逻辑，但保留已安装 runtime
  - 可开启独立的`额度分档无感平衡`，并选择 20%、25%、33% 或 50% 分档，无需开启官方自动切号或五小时配额控制
  - 可设置 `1%`、`2%` 或 `3%` 的储备切换阈值；分档账号优先轮换，全部降到阈值后才使用周额度最高的储备账号
  - 分档/储备身份只按最新有效额度窗口判断，不按 Free、Plus 等套餐标签猜测；只有可选的 Free 1% 耗尽保护会同时验证 Free 标签和实际窗口；缺失、报错或过期数据不会参与自动选号
  - 可选开启`1% 耗尽保护（Free 优先）`，Free 五小时额度耗尽时优先使用五小时额度最高的安全 Free 池账号；没有时按原有混合逻辑切换并自动 Continue，已经因额度耗尽停止的近期会话也会在成功切号后恢复
  - 每张账号卡片左下角可独立开关池成员；也可批量选择账号后设置或移出无感切号池
  - 可勾选卡片左上角批量隐藏/解除隐藏账号；隐藏会自动移出无感池且不参与任何切换，解除隐藏会自动重新加入无感池，眼睛按钮可临时显示隐藏卡片
  - 可设置安全等待时间和普通会话恢复策略；Free 耗尽保护建议配合 `1` 分钟的配额自动刷新
- `Codex App 启动路径`
  - 可选自定义桌面端路径
  - 留空时使用自动检测
- `仪表盘主题`
  - `auto`（跟随 VS Code）
  - `light`
  - `dark`
- `仪表盘显示`
  - 可选择是否显示 `Code Review` 配额
- `超额预警`
  - 可开启或关闭低配额提醒
  - 默认关闭
  - 开启后可设置 `5% - 90%` 阈值
  - 刷新配额后，如果当前激活账号低于阈值，会弹出中英文预警提示
  - `5 小时配额控制` 关闭时，仅检查每周配额
- `后台令牌刷新`
  - 可开启或关闭保存账号的后台 token 检测与更新
- `配额颜色阈值`
  - 可分别调整绿色与黄色阈值（配套 UI 提示颜色规则）
- `恢复数据操作`
  - 可在界面触发恢复备份 / 恢复 `auth.json` / 恢复共享 JSON

---

## 使用方式

1. 安装扩展
2. 首次启动时，如果本机已有本地 Codex `auth.json`，扩展会提示是否立即绑定并刷新配额
3. 也可以运行 `Codex Accounts: Add Account via OAuth` 添加账号
4. 或运行 `Codex Accounts: Import Current auth.json` 导入当前账号
5. 运行 `Codex Accounts: Show Quota Summary` 打开总览面板
6. 在面板中可进行：刷新配额、切换账号、导入导出、批量重刷、状态栏管理等操作
7. 打开详情页查看账号原始信息并执行会话/凭证修复

### 如何迁移账号到另一台电脑

1. 在账号管理界面勾选需要迁移的账号
2. 点击 `导出选中账号 JSON`
3. 在新电脑安装扩展
4. 点击 `从 Shared JSON 恢复`，或在添加账号窗口中导入 JSON
5. 完成账号恢复

---

## 命令列表

在 VS Code 命令面板中可使用以下命令：

- `Codex Accounts: Add Account via OAuth`
- `Codex Accounts: Install Experimental Seamless Runtime`
- `Codex Accounts: Remove Experimental Seamless Runtime`
- `Codex Accounts: Import Current auth.json`
- `Codex Accounts: Reauthorize Account`
- `Codex Accounts: Switch Account`
- `Codex Accounts: Refresh Quota`
- `Codex Accounts: Refresh All Quotas`
- `Codex Accounts: Restore Accounts from Backup`
- `Codex Accounts: Restore Accounts from auth.json`
- `Codex Accounts: Restore Accounts from Shared JSON`
- `Codex Accounts: Remove Account`
- `Codex Accounts: Toggle StatusBar Account`
- `Codex Accounts: Open Details`
- `Codex Accounts: Open Codex Home`
- `Codex Accounts: Show Quota Summary`

---

## 安装

现在可以直接通过 VS Code 扩展市场安装，也保留 `.vsix` 和源码运行方式。

### 方式一：从扩展市场安装

1. 打开 VS Code 扩展面板
2. 搜索 `Codex Accounts Manager`
3. 找到发布者 `wannanbigpig` 的扩展并点击安装

也可以直接打开市场页面：

[Codex Accounts Manager - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=wannanbigpig.codex-accounts-manager)

### 方式二：从 VSIX 安装

1. 下载发布产物 `.vsix`
2. 在 VS Code 中打开命令面板
3. 执行 `Extensions: Install from VSIX...`
4. 选择下载好的 `.vsix` 文件完成安装

也可以使用命令行安装：

```bash
code --install-extension codex-accounts-manager-x.y.z.vsix
```

### 方式三：从源码运行

```bash
git clone https://github.com/wannanbigpig/codex-tools.git
cd codex-tools
npm install
npm run compile
```

在 VS Code 中按 `F5` 启动 Extension Development Host。

---

## 打包 VSIX

```bash
npx @vscode/vsce package
```

---

## 说明

- 账号数据保存在本地
- 切换账号会更新当前机器全局生效的 Codex `auth.json`
- 导入当前账号或首次绑定本地账号后，会立即刷新最新配额
- 如果其他窗口切换了账号，当前窗口会自动检测并提示同步
- 如果 Codex App 正在运行，切换账号后会尝试自动重启；未运行则跳过
- 配额显示依赖当前账号会话返回的数据

---

## 支持

- ⭐ [GitHub Star](https://github.com/wannanbigpig/codex-tools)
- 💬 [反馈问题](https://github.com/wannanbigpig/codex-tools/issues)

---

## 💝 赞助项目

感谢你使用 `Codex Accounts Manager`。

如果这个项目对你有帮助，欢迎赞助项目的持续开发和维护。

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-支持作者-orange?style=for-the-badge&logo=buy-me-a-coffee)](https://github.com/wannanbigpig/codex-tools/blob/master/docs/DONATE.md)

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
