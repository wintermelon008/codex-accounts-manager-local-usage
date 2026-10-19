# Manager headless runtime

Manager 的 headless runtime 与 VS Code 扩展共用同一个账号索引、凭据文件、Mailbox 私有状态和 Control API。它负责长期运行的 token 续期、Mailbox 自动续期、额度刷新和本地导入收件箱；它不会启动或接管 Codex app-server，也不会实现无感切号。

## 构建与启动

先在仓库根目录编译：

```bash
npm run compile
```

运行时必须使用 Node 20+，推荐使用与当前 VServer Gateway 相同的 Node 22：

```bash
export CODEX_ACCOUNTS_PRIVATE_DIR=/absolute/path/to/private
export CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN=<private-token>
export CODEX_HOME=/absolute/path/to/codex-home
export NODE_BIN=/absolute/path/to/node-22/bin/node
"$NODE_BIN" out/runtime/managerDaemon.js
```

也可以把 token 放在：

```text
$CODEX_ACCOUNTS_PRIVATE_DIR/manager-control.env
```

默认监听 `127.0.0.1:43117`。如果当前 VS Code Manager 已经占用该端口，daemon 会安全启动失败，不会杀掉或覆盖现有进程。迁移时可以先设置 `MANAGER_DAEMON_PORT` 使用临时端口进行验证。

可选配置：

```text
MANAGER_DAEMON_QUOTA_REFRESH_MINUTES=15
MANAGER_DAEMON_TOKEN_REFRESH_INTERVAL_SECONDS=300
MANAGER_DAEMON_MAILBOX_SCAN_INTERVAL_SECONDS=60
MANAGER_DAEMON_DEBUG_NETWORK=0
```

## systemd 用户服务

使用 [`manager-daemon.service.template`](../integrations/manager-runtime/templates/manager-daemon.service.template)，填写：

- `PRIVATE_ENV_FILE`：只包含私有 token/环境变量的文件；
- `PRIVATE_ROOT`：与 VS Code Manager 相同的绝对 private 目录；
- `PACKAGE_ROOT`：仓库根目录；
- `NODE_BIN`：Node 20/22 的绝对路径。

服务应以 `melon` 用户运行。不要让 daemon 和现有 Extension Host 同时绑定同一个 43117 端口；切换前先用临时端口验证 Control API、额度刷新和 Mailbox 状态。

## 与现有 Manager 的关系

VS Code Manager 的 UI、手动操作和现有热切换 runtime 不变。daemon 在线时可以成为后台调度 owner；daemon 不在线时，现有扩展仍可独立运行。两者使用现有跨宿主账号租约，不建立第二个账号库。daemon 提供的是持久化 `auth.json` 切换（没有活跃 VS Code/Codex turn 可协调），因此不会冒充无感切号。

当前 daemon 不提供活跃 Codex runtime 的无感换号；Control API 的账号查询、持久化账号切换、额度刷新、导入收件箱和 proxy 查询保持兼容，runtime/provider-config 与 live account switching 仍由现有 Manager/Gateway 路径提供。
