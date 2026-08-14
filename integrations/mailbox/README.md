# Codex Accounts Mailbox

这是一个可选的 VS Code 扩展，为 Codex Accounts Manager 提供通用 Mailbox 查询、验证码人工监听和人工凭据续期入口。当前内置 `8t92`、`boya` 与 `cdns` 三个 provider，provider 名称同时作为来源标识。

它是独立组件：邮箱池元数据和凭据只由本扩展管理，凭据进入本扩展自己的 VS Code `SecretStorage`；Manager 核心账号库、Sub2API 配置和其他 provider 不会被读取。Manager 只通过已有的 Dashboard integration API 显示一个轻量入口卡片，邮箱列表和当前选中邮箱详情由本扩展自己的 Webview 面板渲染。

## 生命周期

- 扩展激活和 Manager 启动只读取本地邮箱池元数据，不访问任何 provider，也不启动 timer。
- 点击“打开 Mailbox”后，用户在导入表单中选择 provider，再粘贴该 provider 的输入格式。凭据不进入 Dashboard、日志或 Manager 公共 API。
- “查询邮件”是一次人工查询；“接收验证码”才启动最小轮询会话，默认 120 秒超时、每 5 秒查询一次，可手动停止。
- 已安装新版 Manager 时，未匹配账号池邮箱的条目会显示“Codex 导入”；点击后直接打开 OAuth 浏览器流程，不弹出 Manager 添加账号窗口，并在授权邮箱不一致时拒绝写入。
- OAuth 导入与邮箱查询共用“停止”按钮；停止会取消 Manager 侧的本地 OAuth 回调等待，并清理 Mailbox 的导入状态，不会遮挡邮箱验证码面板。
- 每个邮箱拥有独立的操作会话和取消控制，多个邮箱可以并行；某个邮箱失败不会阻塞其他邮箱。
- 邮箱池默认按显示名称升序排列，支持名称升/降序、最近查询、已出码优先、按来源筛选，以及“仅未接入 Codex”筛选；后者依据当前 Manager 已接入账号目录判断。
- 邮箱列表支持勾选、全选当前筛选结果、批量查询、批量验证码监听、批量停止和批量删除；批量操作仍按邮箱独立记录成功/失败。
- provider 可以声明只提供最近一封邮件，或提供有限的最近邮件列表；UI 会按声明显示能力，不假设所有来源都有完整历史。
- provider 可以声明人工续期能力。只有返回明确的新凭据时才回写该邮箱；未变化和失败都会保留原凭据。

## 内置 boya 来源

`boya` 对接 `http://freemail.boya.one/api/user/codes`，每行导入格式为：

```text
邮箱----private token
```

例如：

```text
user@example.com----private_token
```

它只查询最近一封邮件，不支持人工续期。查询响应中的验证码和邮件摘要会转换为 Mailbox 统一格式；邮箱或 private token 错误会显示固定的错误码和安全原因，不把第三方原始响应透传到其他服务。

## 内置 cdns 来源

`cdns` 对接 `https://ai.cdns.ccwu.cc/mail-receive/` 使用的公开接口。每行导入格式为：

```text
邮箱----密码----接码令牌----public_ref
```

查询时先通过 CDNS 的账号来源解析接口取得 `source_upstream_key`，再查询最近一封邮件；该来源声明 `history: "latest"`、最多一封邮件且不支持人工续期。返回的验证码、主题和提示会转换为 Mailbox 统一格式；来源未匹配、凭据错误和上游异常只显示固定安全错误，不透传第三方原始响应。

卸载本扩展不会删除 Manager 账号。当前版本使用全新的 `Mailbox` 扩展身份和存储命名空间，不从旧的 provider 专用扩展迁移数据；若需要清理旧扩展凭据，应在卸载前通过 VS Code 的扩展存储清理能力处理。本扩展没有自动续期或后台网络任务。

## 安装

在本目录执行：

```bash
npm test
npm run package
```

然后在 VS Code 使用 **Extensions: Install from VSIX…** 安装 `dist/codex-accounts-mailbox.vsix`。如果 Manager 未安装或 API 版本不兼容，该可选扩展会提示错误；Manager 核心本身不依赖它，未安装本扩展不影响核心账号、额度、Sub2API 或无感切号功能。

测试使用 mock HTTP 响应，不会在打包或测试中使用真实邮箱凭据。运行时 provider 只会在用户主动查询或监听时访问对应第三方接口。
