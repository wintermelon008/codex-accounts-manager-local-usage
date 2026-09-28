# 本地文本导入收件箱

扩展可消费一个由受信任的本地集成或 Manager Control API 写入的私有本地收件箱。该机制用于把规范化的 OAuth Shared JSON 任务自动导入；它不是网络 API，也不允许外部进程直接写账号索引或 VS Code SecretStorage。

该能力默认关闭。只有在需要接收本机机器人任务的 VS Code 用户设置中显式加入下面一项并重载窗口后，扩展才会创建目录、轮询或导入文件：

```json
"codexAccounts.localImportInboxEnabled": true
```

因此同一版 Manager 部署到其他服务器时无需额外配置；默认不会因主机名、IP、队列路径或机器人不存在而影响任何账号管理、额度查询或切号功能。

## 数据流

```text
本地集成 / Manager Control API → 受限本地收件箱
                                      ↓
                         Codex Accounts Manager Extension Host
                                      ↓
              SecretStorage 导入 → 额度刷新/401 测活 → 合格账号进入无感池
```

设置 `CODEX_ACCOUNTS_PRIVATE_DIR` 后，默认收件箱位于该目录下的 `import-inbox/`。Manager Control API 的 `POST /api/manager/imports` 会把经过规范化的任务写入该目录；Manager 和受信任的本地集成共享同一个私有根目录时即可使用同一收件箱。

任务生产者以原子 rename 写入 `codex-account-import/v1` 任务，目录权限为 `0700`、任务文件权限为 `0600`。扩展完成或拒绝任务后，会删除含凭据的任务文件，并在同级 `results/` 写入仅含计数的脱敏结果。结果不包含邮箱、账号 ID、token 或原始 JSON。

## 导入规则

- 收件箱仅接受最多 50 个 Shared JSON 账号记录的任务。
- 每个记录仍由现有 `AccountsRepository` 校验并写入 VS Code SecretStorage；扩展外的脚本不能替代这一步。
- 每个成功导入的账号会先以 `balancePoolEnabled=false` 隔离并同步落盘，再请求远端资料或刷新额度；这同样适用于覆盖已在池中的账号，因此旧凭据不会在验证窗口内继续成为无感候选。401、令牌失效、网络/服务异常或缺少新鲜可用额度窗口时，账号保持在池外。
- 只有刷新成功且符合现有 `getBalanceQuotaCapability` 判定的账号才会启用 `balancePoolEnabled`。
- 扩展按 3 秒轮询收件箱，并通过现有跨宿主租约避免重复处理；超过 10 分钟未完成的任务会安全回队重试。重复任务仅会覆盖同一账号的受控记录，不会直接写 `auth.json`。

## 网络边界

本地集成只应访问受限本地文件系统或其自身的输入来源。额度刷新、refresh token 续期和 401 判定仅发生在扩展宿主，复用扩展已有的 `chatgpt.com` 与必要的 `auth.openai.com` 请求路径。
