# Mailbox 可选集成

`integrations/mailbox` 是 Manager 的独立可选 VSIX。它定义通用 Mailbox/provider 边界，当前内置 `8t92`、`boya` 和 `cdns` provider，后续第三方只需要实现同一 provider 合约。

## 边界

该组件拥有自己的邮箱池、元数据、详情缓存和 VS Code SecretStorage 命名空间。Manager 仅通过现有 `registerDashboardIntegration` API 渲染一个轻量入口卡片，并可选提供脱敏的账号邮箱目录与无界面 OAuth 导入能力；Mailbox 不读取 Manager 账号 token、不读取 Sub2API SecretStorage，也不把邮件正文或邮箱凭据带入核心公共 API。邮箱列表和当前选中邮箱详情由扩展自有 Webview Panel 提供。

因此新设备可以只安装 Manager；未安装 Mailbox VSIX 时，核心账号管理、额度刷新、Sub2API 和无感切号路径不应该因为邮箱组件缺失而改变。

## 负载和操作

扩展激活时只加载本地池元数据，不访问任何 provider，也不启动 timer。用户打开 Mailbox 面板后仍不会联网；点击“查询邮件”或“人工续期”后才发起一次操作；点击“接收验证码”后才创建最小轮询会话，默认每 5 秒查询、120 秒停止。每个邮箱独立发请求、独立失败，列表显示完整邮箱地址，详情只在手动选中后加载到面板。

provider 合约至少包含：

- `id`、显示名称和能力声明；
- `parseImport`，负责自己的导入格式并返回邮箱地址及 provider 凭据；
- `query`，返回统一邮件、验证码和状态模型；
- 可选的 `renew`，只由人工动作调用。

能力声明支持 `history: "latest" | "recent"` 和 `manualRenewal`。因此只能看到最近一封邮件的 provider 不需要伪装成完整邮箱服务。

当 Manager 暴露可选 OAuth 能力时，未与账号池邮箱地址匹配的邮箱会显示“Codex 导入”。点击后 Mailbox 只传递邮箱地址作为匹配条件和剪贴板便利文本，Manager 直接复用 OAuth 授权流程并打开系统浏览器，不打开 Dashboard 添加账号弹窗；授权邮箱不匹配时不会写入账号池。未安装或未更新 Manager 时，该按钮自动隐藏，邮箱查询功能仍可独立使用。

OAuth 导入会带一个仅用于取消控制的不透明操作 ID。用户按下当前邮箱的“停止”按钮时，Mailbox 调用 Manager 的可选取消能力，终止本地回调等待并立即释放界面状态；查询、验证码监听和续期仍可独立运行。旧版 Manager 未提供取消能力时不会暴露该取消入口，Mailbox 查询功能仍保持可用。

续期结果中只有明确的新凭据才会写入该 provider 的 SecretStorage；旧凭据可用但没有变化、失败、取消或响应异常都会保留原凭据。续期仍是人工动作，不做后台自动续期。

邮箱池面板默认按显示名称升序显示，支持名称升/降序、最近查询、已出码优先、按来源筛选和“仅未接入 Codex”筛选。“仅未接入 Codex”依据当前 Manager 返回的已接入账号邮箱目录判断；当 Manager 不提供该目录时，筛选项会禁用。用户可以勾选邮箱并全选当前筛选结果，然后批量查询、批量监听、批量停止或批量删除；Coordinator 继续为每个邮箱维护独立操作和结果。

## boya 接入

`boya` 使用 `http://freemail.boya.one/api/user/codes` 查询验证码。导入时每行填写 `邮箱----private token`，例如 `user@example.com----private_token`。该来源声明 `history: "latest"`、最多一封邮件且不支持续期；返回的 `code` 和 `message` 会转换成统一 Mailbox 消息模型。

Boya 的 private token 只作为 provider 凭据存入 Mailbox 私有 `SecretStorage`，不会进入邮箱池公共元数据、Manager API 或错误提示。面板可以显示固定错误码和安全原因（例如 `invalid_credentials`），但不透传第三方原始响应，避免其携带敏感内容。

## cdns 接入

`cdns` 使用 `https://ai.cdns.ccwu.cc/mail-receive/` 对应的公开接口。导入时每行填写四段格式：

```text
邮箱----密码----接码令牌----public_ref
```

查询按 CDNS 前端相同的两步协议执行：先 POST `/api/card-withdraw/public-proxy/account-sources/resolve`，用邮箱和 `public_ref` 解析来源；成功后再 POST `/api/card-withdraw/public-proxy/mail/receive`，提交邮箱、密码、接码令牌、`public_ref` 和解析得到的 `source_upstream_key`。该来源声明 `history: "latest"`、最多一封邮件且不支持续期；响应中的 `code`、`subject`、`message` 和 `received_at` 会转换为统一 Mailbox 消息模型。

CDNS 的密码、接码令牌和 `public_ref` 只存入 Mailbox 私有 `SecretStorage`，不会进入邮箱池公共元数据、Manager API 或测试文件。来源未匹配、凭据错误和上游异常会转换为固定安全错误，并对异常回显的凭据做脱敏。

## 构建和验证

```bash
npm --prefix integrations/mailbox test
npm --prefix integrations/mailbox run package:check
npm --prefix integrations/mailbox run package
```

当前测试使用占位行和 mock HTTP 响应；没有使用真实邮箱、private token 或 refresh token。运行时仅在用户手动执行查询/监听时请求 provider。
