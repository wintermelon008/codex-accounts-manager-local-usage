# Codex Accounts Sub2API Importer

这是 S+ 私聊导入的独立、可选队列消费者。飞书私聊机器人只会生成受限本地队列中的标准 `sub2api-data` 任务；只有安装并显式配置本包后，任务才会被提交到 Sub2API 自己的账号 JSON 导入 API，并完成受控的导入后账号配置。

它不依赖 Manager 源码、不修改 Sub2API 服务文件、数据库或反向代理，也不复制任何旧服务配置。

## 私有配置

仅在目标设备的私有环境文件中设置：

```dotenv
SUB2API_ADMIN_BASE_URL=https://gateway.example.invalid
SUB2API_ADMIN_TOKEN=<private-admin-token>

# 可选但建议配置：当 access token 过期时自动刷新。轮换后的 refresh token
# 仅写入本包的 owner-only 私有状态文件，不会写回仓库或队列。
SUB2API_ADMIN_REFRESH_TOKEN=<private-admin-refresh-token>
SUB2API_ADMIN_SESSION_STATE_FILE=<absolute-private-session-state-file>

# S+ 新建账号的显式默认策略；以下正是默认值，可按目标 Sub2API 调整。
SUB2API_IMPORT_PROXY_NAME=default
SUB2API_IMPORT_GROUP_NAME=test
SUB2API_IMPORT_CONCURRENCY=2

# 可选：必须与飞书私聊机器人使用同一个受限 S+ 出站队列。
SUB2API_IMPORT_QUEUE_DIR=<absolute-private-sub2api-outbox-directory>
SESSION_INGRESS_STATE_DIR=<absolute-private-state-directory>
SUB2API_IMPORT_POLL_SECONDS=5
```

`SUB2API_ADMIN_TOKEN` 与可选的 `SUB2API_ADMIN_REFRESH_TOKEN` 只存在于此进程的私有环境；不会写入 Manager、Gateway VSIX、任务结果、日志或仓库文件。若 access token 因 `TOKEN_EXPIRED` 被拒绝，导入器只会用 refresh token 刷新一次并重试原请求；若服务器轮换 refresh token，新值会写入 owner-only 私有状态文件，以便服务重启后继续使用。未配置 refresh token 时保持原有的失败关闭行为。若未指定 `SUB2API_IMPORT_QUEUE_DIR`，本包会使用与飞书机器人相同的可移植标准状态目录发现规则。

从旧的 M+/S+ 工作器迁移时，可用本包的迁移脚本从**旧账户导入工作器自己的私有环境文件**提取仅需的 Sub2API 管理端地址、令牌，以及已有的 S+ 默认策略；若旧环境已有 refresh token 也会一并迁移。脚本不会复制飞书、店铺、Manager 或其他无关变量，并写入一个全新的、权限为 `0600` 的导入器环境文件：

```bash
node scripts/migrate-legacy-env.cjs \
  --source <legacy-private-import-env> \
  --destination <new-private-importer-env>
```

脚本不会复制飞书、店铺、Manager 或其他无关变量，也拒绝覆盖已有目标文件。可用 `templates/codex-accounts-sub2api-importer.service.template` 启动常驻消费者；模板仅保留路径占位符，不包含设备信息或凭据。

## 行为与安全边界

- 只接受 `sub2api-import/v1` 队列任务以及标准 `sub2api-data` / `sub2api-bundle` 负载。
- 先验证存在唯一的激活 `SUB2API_IMPORT_PROXY_NAME` 代理，以及与账号平台匹配的唯一激活 `SUB2API_IMPORT_GROUP_NAME` 分组；不满足时不会提交导入。
- 通过 Sub2API 的标准 `POST /api/v1/admin/accounts/data` 接口提交 `{ data, skip_default_group_bind: true }`。成功后只会识别本次新建且能唯一匹配源身份的账号；服务端补充的身份字段不会破坏匹配。导入器绑定目标代理和分组、设置 `SUB2API_IMPORT_CONCURRENCY`，并把该分组当前可选模型写入精确映射；随后逐个回读验证。这使新账号支持该目标分组的全部当前模型，而不会依赖服务端的隐式默认值。
- 队列、处理中文件和结果目录均要求私有常规文件与目录；符号链接、异常所有者和过大的输入会失败关闭。
- 成功后会删除已处理的原始任务，仅保留不含令牌的结果摘要（包括 `account_configured` 数量）。若远端已确认导入、但后置配置无法唯一确认，任务会以 `postImportConfigurationFailed` 标记为失败且不会自动重试或重新导入；用户应先检查远端账号，避免重复提交。
- 远端响应正文、账号、代理、令牌和管理端错误文本均不会写入结果或日志。

## 运行与验证

```bash
npm --prefix integrations/sub2api-importer test
npm --prefix integrations/sub2api-importer run package
node integrations/sub2api-importer/src/cli.cjs --once
node integrations/sub2api-importer/src/cli.cjs
```

`package` 会在本包自己的 `dist/` 中生成可安装 tarball；它不包含私有环境文件、管理令牌、账号或队列内容。使用 `--once` 可安全执行一次扫描，适合作为手动验证或受调度器管理的任务。常驻模式按 `SUB2API_IMPORT_POLL_SECONDS` 轮询。无论哪种模式，都不会自动迁移旧机器人、旧服务或历史账号数据。
