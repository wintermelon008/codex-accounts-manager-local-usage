# Codex Accounts Mailbox

这是一个可选的 VS Code 扩展，为 Codex Accounts Manager 提供通用 Mailbox 查询、验证码人工监听和人工凭据续期入口。8t92 只是当前内置的一个 provider，不是 Mailbox 功能的名称或边界。

它是独立组件：邮箱池元数据和凭据只由本扩展管理，凭据进入本扩展自己的 VS Code `SecretStorage`；Manager 核心账号库、Sub2API 配置和其他 provider 不会被读取。Manager 只通过已有的 Dashboard integration API 显示一个轻量入口卡片，邮箱列表和当前选中邮箱详情由本扩展自己的 Webview 面板渲染。

## 生命周期

- 扩展激活和 Manager 启动只读取本地邮箱池元数据，不访问任何 provider，也不启动 timer。
- 点击“打开 Mailbox”后，用户在导入表单中选择 provider，再粘贴该 provider 的输入格式。凭据不进入 Dashboard、日志或 Manager 公共 API。
- “查询邮件”是一次人工查询；“接收验证码”才启动最小轮询会话，默认 120 秒超时、每 5 秒查询一次，可手动停止。
- 已安装新版 Manager 时，未匹配账号池邮箱的条目会显示“Codex 导入”；点击后直接打开 OAuth 浏览器流程，不弹出 Manager 添加账号窗口，并在授权邮箱不一致时拒绝写入。
- OAuth 导入与邮箱查询共用“停止”按钮；停止会取消 Manager 侧的本地 OAuth 回调等待，并清理 Mailbox 的导入状态，不会遮挡邮箱验证码面板。
- 每个邮箱拥有独立的操作会话和取消控制，多个邮箱可以并行；某个邮箱失败不会阻塞其他邮箱。
- provider 可以声明只提供最近一封邮件，或提供有限的最近邮件列表；UI 会按声明显示能力，不假设所有来源都有完整历史。
- provider 可以声明人工续期能力。只有返回明确的新凭据时才回写该邮箱；未变化和失败都会保留原凭据。

卸载本扩展不会删除 Manager 账号。当前版本使用全新的 `Mailbox` 扩展身份和存储命名空间，不从旧的 provider 专用扩展迁移数据；若需要清理旧扩展凭据，应在卸载前通过 VS Code 的扩展存储清理能力处理。本扩展没有自动续期或后台网络任务。

## 安装

在本目录执行：

```bash
npm test
npm run package
```

然后在 VS Code 使用 **Extensions: Install from VSIX…** 安装 `dist/codex-accounts-mailbox.vsix`。如果 Manager 未安装或 API 版本不兼容，该可选扩展会提示错误；Manager 核心本身不依赖它，未安装本扩展不影响核心账号、额度、Sub2API 或无感切号功能。

当前内置 provider 使用占位数据和 mock 测试验证协议，没有在打包或测试中使用真实邮箱凭据，也没有宣称真实第三方账号验证成功。
