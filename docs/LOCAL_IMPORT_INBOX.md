# 本地文本导入收件箱

扩展可消费一个由本机飞书命令机器人写入的私有本地收件箱。该机制用于把原始 session/token JSON 转换为多账号 Shared JSON 后自动导入；它不是网络 API，也不允许外部进程直接写账号索引或 VS Code SecretStorage。

该能力默认关闭。只有在需要接收本机机器人任务的 VS Code 用户设置中显式加入下面一项并重载窗口后，扩展才会创建目录、轮询或导入文件：

```json
"codexAccounts.localImportInboxEnabled": true
```

因此同一版 Manager 部署到其他服务器时无需额外配置；默认不会因主机名、IP、队列路径或机器人不存在而影响任何账号管理、额度查询或切号功能。

## 数据流

```text
飞书管理员文本 → 命令机器人 → ~/.local/state/codex-account-import/inbox
                                      ↓
                         Codex Accounts Manager Extension Host
                                      ↓
              SecretStorage 导入 → 额度刷新/401 测活 → 合格账号进入无感池
```

默认收件箱为 `~/.local/state/codex-account-import/inbox`；如果两个进程都设置了绝对路径的 `XDG_STATE_HOME`，则使用 `$XDG_STATE_HOME/codex-account-import/inbox`。需要使用非默认目录时，为命令机器人和启动 VS Code 的环境设置相同的、绝对路径的 `CODEX_IMPORT_QUEUE_DIR`。

命令机器人以原子 rename 写入 `codex-account-import/v1` 任务，目录权限为 `0700`、任务文件权限为 `0600`。扩展完成或拒绝任务后，会删除含凭据的任务文件，并在同级 `results/` 写入仅含计数的脱敏结果。结果不包含邮箱、账号 ID、token 或原始 JSON。

## 导入规则

- 收件箱仅接受最多 50 个 Shared JSON 账号记录的任务。
- 每个记录仍由现有 `AccountsRepository` 校验并写入 VS Code SecretStorage；扩展外的脚本不能替代这一步。
- 每个成功导入的账号会强制刷新额度。401、令牌失效、网络/服务异常或缺少新鲜可用额度窗口时，账号会被显式移出无感切号池。
- 只有刷新成功且符合现有 `getBalanceQuotaCapability` 判定的账号才会启用 `balancePoolEnabled`。
- 扩展按 3 秒轮询收件箱，并通过现有跨宿主租约避免重复处理；超过 10 分钟未完成的任务会安全回队重试。重复任务仅会覆盖同一账号的受控记录，不会直接写 `auth.json`。

## 网络边界

飞书命令机器人只访问飞书和本地文件系统。额度刷新、refresh token 续期和 401 判定仅发生在扩展宿主，复用扩展已有的 `chatgpt.com` 与必要的 `auth.openai.com` 请求路径；不访问第三方格式转换网站。

将凭据粘贴到飞书仍意味着凭据会由飞书承载和保留。请仅在私聊中使用，并限制 `FEISHU_ADMIN_OPEN_IDS` 到受信任管理员。
