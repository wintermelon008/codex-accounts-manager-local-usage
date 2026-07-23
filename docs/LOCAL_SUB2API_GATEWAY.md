# 本地 Sub2API Gateway

本地构建可选地把一个 Sub2API 下游 API 显示为 Dashboard 中的一张独立 Gateway 卡片。它不是 OAuth 账号，也不会伪造成多个 ChatGPT 账号：一个 Gateway 对应一个下游 API，由 Sub2API 在内部调度其上游库存。

该功能仅适用于此本地 fork，默认关闭。关闭后，扩展不会读取 Gateway 配置或 SecretStorage、启动适配器、轮询 runtime，也不会访问 Sub2API。

## 启用与下游配置

在运行 Manager 的 VS Code 扩展宿主（例如 Linux Remote-SSH 宿主）的用户设置中加入：

```json
{
  "codexAccounts.sub2apiGatewayEnabled": true,
  "codexAccounts.sub2apiGatewayConfigFile": "sub2api-gateway.json"
}
```

第二项始终相对于扩展自己的 VS Code global storage，不能使用绝对路径，也不能离开该目录。首次启用后，扩展才会创建模板；可从 Dashboard 的 **Sub2API 网关 → 打开配置** 直接打开它。

默认模板如下。按实际暴露模型修改 `model`：

```json
{
  "schema": "codex-accounts-sub2api-gateway/v1",
  "displayName": "Sub2API Gateway",
  "sub2api": {
    "baseUrl": "http://127.0.0.1:65432/v1",
    "model": "gpt-5.5",
    "credentialRef": "primary"
  },
  "autoFallbackToChatGpt": false
}
```

`baseUrl` 必须是以 `/v1` 结尾的 HTTP(S) URL。卡片中的 **保存下游 API Key** 将 Key 放入 VS Code SecretStorage；配置文件不得出现 `apiKey`、`token`、`authorization`、`adminApiKey` 等明文凭据，解析器会拒绝它们。

## 运行边界

```text
Codex app-server
       │ Bearer <每进程随机本地令牌>
       ▼
127.0.0.1 临时 Gateway adapter
       │ Bearer <SecretStorage 中的下游 API Key>
       ▼
Sub2API /v1（例如 Linux 127.0.0.1:65432）
       ▼
Sub2API 内部上游账号调度
```

- 适配器只监听 `127.0.0.1`，只允许模型与 Responses 请求；下游 Key 不会写进 `auth.json`、shim 配置、Dashboard 状态、日志或仓库文件。
- 启用 Gateway 时，shim 仅在其启动的 Codex app-server 子进程中把 `127.0.0.1`、`localhost` 与 `::1` 加入 `NO_PROXY`/`no_proxy`。这保证每次随机回环 adapter 端口不会被服务器已有的 HTTP(S)/ALL 代理截走；外部请求仍沿用你原有的代理设置，系统环境不会被修改。
- 默认情况下，Gateway 和 ChatGPT Auth 仍通过显式选择加 window reload 切换。仅当配置中的 `autoFallbackToChatGpt` 明确设为 `true` 时，已确认的 Sub2API 上游额度耗尽才会触发单向、无 reload 的 Gateway → ChatGPT Auth 回退；它绝不会自动从 ChatGPT Auth 切回 Gateway，也不会让 Gateway 加入普通 OAuth 调度池。Gateway 复用 HTTP runtime 的本地 provider identity，使这个传输切换不再把本地 thread history 按 provider 拆成两组；这不表示两种上游服务共享远端上下文或额度。
- 为兼容最早本地 Gateway 版本创建的旧 thread，runtime 仅内部注册一次旧 provider ID 的别名，并将它指向当前选中的 ChatGPT Auth 或 Gateway 传输；新 thread 仍只使用当前 HTTP provider identity。
- OAuth 账号、`auth.json`、普通账号的五小时/周额度刷新、无感切号池及其 token 归因保持原有逻辑。Gateway 不进入这些调度器，也不会向其写入数据。

## 可选：额度耗尽后无 reload 回退至 ChatGPT Auth

这是一项默认关闭的单向保护。需要时把配置改为：

```json
"autoFallbackToChatGpt": true
```

启用前应先安装一次 Experimental Seamless Runtime、重载窗口，并准备至少一个可用的 ChatGPT Auth 候选。候选沿用现有无感切号池和分组可见性：必须未隐藏、在池中、最近 15 分钟成功刷新过有效额度，且周额度严格高于当前“账号切换阈值”（阈值关闭时只要求大于 `0%`）；有有效五小时窗口的候选优先，再按五小时/周剩余额度排序，最后才考虑储备账号。Gateway 只读取这一安全线，不会修改普通 ChatGPT 调度设置。

真正交接前，Manager 会对当前最优候选强制刷新额度并重新排序；若刷新后另一候选成为最优，也会先刷新它。刷新失败、失去资格或没有可用凭据的账号只会从**本次**回退事务排除，不会把旧快照当作可用额度。回退因无候选、运行时不可用、身份校验失败或安全边界延后而未完成时，会以 `5 → 10 → 20 → 40 → 60` 秒封顶的指数退避重试；Gateway 卡片会显示下一次重试和次数。新的、递增的耗尽事件会重置该退避。

adapter 只在实际 `/v1/responses` 返回 `429`、`502` 或 `503` 且受限 JSON 错误体中出现额度耗尽语义（例如 `quota_exhausted`、`usage_limit_exceeded`、`no_available_account` 或 `insufficient_balance`）时才触发。普通 5xx、网络错误、超时、模型错误和未识别响应都只保留原有诊断，**不会**误切到 ChatGPT。

确认耗尽后，adapter 会停止继续向 Sub2API 发新请求，Manager 在同一 app-server 的安全边界登录并验证所选 ChatGPT Auth 账号，然后把同一个本地 HTTP provider 路由到 ChatGPT；本地 thread history 不需要重建，也不需要 reload。若目标账号、身份校验或本地账号提交失败，事务会恢复切换前的 ChatGPT 身份和 Sub2API 路由，保持失败关闭。

已收到耗尽响应的那一轮不会被自动重放：请求正文不会被 adapter 缓存或重试，以免重复非幂等工具操作。切换成功后，在同一 thread 重试或继续下一轮即可使用 ChatGPT Auth。恢复 Sub2API 时，在 Gateway 卡片再次选择 Gateway；已安装且连接正常时可原地恢复其上游路由，无需再重载窗口。

## 卡片数据语义

### 真实上游额度可读时

下游 API Key 不能可靠读取 Sub2API 的上游账号库存或 5 小时/周额度。若需要这部分信息，可在同一配置文件中显式加入可选的只读观察器：

```json
{
  "inventoryObserver": {
    "adminBaseUrl": "http://127.0.0.1:65432",
    "group": "test",
    "credentialRef": "observer",
    "refreshSeconds": 300
  }
}
```

`adminBaseUrl` 是服务根地址，不能带 `/v1`；`credentialRef` 必须与下游 Key 不同。点击 **保存观察密钥** 后，独立管理观察密钥同样只存于 SecretStorage。观察器只发出只读 `GET`：解析目标分组、列出 OpenAI 上游账号、读取每个可调度账号的额度窗口；不会写入 Sub2API，也不会保留账号 ID、账号名或原始额度 payload。

卡片将当前成功读取的窗口聚合为：

- **5 小时上游池**：所有可读 primary window 的剩余 account-window 单位 / 容量单位及百分比；
- **每周上游池**：所有可读 secondary window 的同类聚合；
- 分母会随分组中可调度上游账号增减自动改变。读不到的账号不会被假设为 `0%`，而会在“已读取/可调度账号数”中体现。

管理观察密钥通常权限很高；没有明确配置此块或没有保存该独立密钥时，扩展不会访问任何 Sub2API 管理端点。

### 无法读取上游额度时的诚实回退

若没有观察器、观察器无权限，或某个窗口不存在，卡片不会伪造 5 小时/周百分比。相应位置自动改为：

- **近 5 小时 Gateway Token**；
- **近 7 天 Gateway Token**；
- **今日 Gateway Token**（扩展宿主本地时区的 `00:00` 起）。

这些数字来自本地回环适配器对成功完成的 Responses `usage` 汇总的被动观察。仅保存输入、输出、缓存、reasoning 与 total token 的小型五分钟聚合桶；不保存提示词、输出文本、响应 ID、账号标识或凭据。它们表示实际观察到的消耗进度，不是上游剩余额度、账单或百分比；首次启用前的历史流量不回填。

卡片会每 15 秒读取本地 runtime 的固定大小状态来合并新 token，并在本地午夜清空“今日”桶。该状态与普通 ChatGPT 卡片的 session 扫描和 account-window 统计使用完全不同的存储键与数据路径。

### 连接与失败诊断

**测试并刷新** 使用下游 Key 检查 `/v1/models`。实际 Responses 流量的最近失败会标识来源：

- `Sub2API 上游 HTTP 502`：请求已到达 Sub2API，502 由上游链路返回；
- `本地适配器 HTTP 502`：本地回环适配器无法连接配置的 Sub2API 端点。

这两种情况不会暴露请求正文或密钥。`/api/v1/usage` 一类 Web 管理页面路由不被当作下游 API 的稳定额度契约；Gateway 的无观察器回退只依赖实际 `/v1/responses` 返回的 usage。

重载时，adapter 会先启动，随后 Manager 才通过本地控制 socket 从 SecretStorage 注入下游 Key。首个带有效本地令牌的请求最多等待 15 秒完成这次内存交接，而不是因为启动竞态立即失败；Key 不会写进配置、环境文件或日志。若交接超时，adapter 会返回本地 `503` 并记录 `CREDENTIAL_TIMEOUT`，此时应检查 Manager 扩展是否已完成启动。

当实际请求失败后必须先切回 ChatGPT Auth 才能继续对话时，本地 adapter 会在退出前同步保存一条固定大小的最近失败诊断；切回后 Dashboard 仍会显示它。记录只包含失败时间、来源、HTTP 状态、Node transport code（如 `ECONNRESET`）及脱敏的请求形态（方法、允许的路径、正文长度或 `chunked` 标记）。它不包含请求正文、Key、Authorization、完整 URL、响应文本或上游账号信息，并以 owner-only 权限保存在扩展自身的 runtime 目录。

同一事件还会写入 Codex app-server 日志。可搜索 `Sub2API Gateway adapter ready`、`loopback proxy bypass configured`、`credential configured`、`request is waiting for credential`、`forwarding started`、`request canceled by local client` 或 `forwarding failed:`；日志只带上述白名单字段，不会输出任何凭据或请求文本。

## 回退

1. 默认模式下，在 Gateway 卡片选择 **切回 ChatGPT Auth**，并按提示重载 VS Code 窗口。
2. 若已启用自动回退且当前显示“ChatGPT Auth fallback is active”，可保留该安全回退状态，或在 Gateway 卡片再次选择 Gateway 以恢复 Sub2API 路由。
3. 可选地将 `codexAccounts.sub2apiGatewayEnabled` 改回 `false`。

此操作不会删除 SecretStorage 中的 Key，也不会改动 Sub2API 服务、Linux 代理脚本或 Chisel 仓库。
