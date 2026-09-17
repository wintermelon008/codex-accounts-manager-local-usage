# Manager 账号共享

账号共享由 Manager 的共享 Relay 负责跨网络转发。两台 Manager 只需要访问同一个 Relay；它们不建立应用层的点对点连接，也不要求公网 IP。Relay 只转发公开目录、请求状态和端到端密文包。

Docker、Linux 裸机、Windows 和 macOS 使用同一套 Relay HTTP API、加密 envelope 和租约状态机。部署方式只决定 Gateway 如何监听端口、如何自启动以及状态目录如何持久化；Manager 客户端不应根据设备类型切换共享逻辑。

## Relay 配置

在运行 `manager-gateway` 的服务上设置：

```dotenv
MANAGER_GATEWAY_HOST=0.0.0.0
MANAGER_GATEWAY_PORT=43118
MANAGER_GATEWAY_TOKEN=<gateway-token>
MANAGER_GATEWAY_SHARING_BOOTSTRAP_TOKEN=<private-enrollment-token>
MANAGER_GATEWAY_SHARING_STATE_DIR=<persistent-private-state-directory>
```

非回环监听仍必须使用 HTTPS 或私有网络，并设置 `MANAGER_GATEWAY_TOKEN`。共享 Relay 的状态目录应只允许运行 Gateway 的用户读写。

`MANAGER_GATEWAY_PORT` 是服务内部端口；对外暴露的端口可以不同，但所有设备最终只配置同一个完整 URL。在每个 Manager 中配置：

```json
{
  "codexAccounts.sharingRelayUrl": "https://your-relay.example.com"
}
```

如果设备还配置了 HTTP(S) 代理，Relay URL 的主机名/IP 必须加入该扩展宿主的 `NO_PROXY`/`no_proxy`；Tailscale 地址不应绕到公网代理。例如当前 Vserver Relay 使用 `100.114.125.9`，两端的 `NO_PROXY` 都包含该地址。

首次注册时，扩展宿主需要设置：

```dotenv
CODEX_ACCOUNTS_SHARING_RELAY_BOOTSTRAP_TOKEN=<private-enrollment-token>
```

注册成功后，Manager 会把本机独立的身份、密钥、mailbox token 和好友/租约状态保存到扩展宿主的私有 `sharing-local-state-v1.json`。不再把这些共享身份放在可能被多个 Remote-SSH 窗口复用的 VS Code 全局 SecretStorage/globalState 中。首次迁移会生成新的共享 ID，需要重新添加好友；不会读取或重发旧 OAuth token。

Docker 必须为每个 Manager 实例使用独立且持久的扩展状态卷。不要把两个设备的 VS Code 扩展状态目录挂载到同一个卷；复制整个卷会复制共享身份，从而使两个设备显示相同 ID。

## 好友端配置（Ubuntu / Windows）

本节是给好友本人或负责部署的 AI/管理员使用的标准流程。好友端只需要安装核心 Manager VSIX；账号共享协议由 Manager 扩展实现，不需要额外安装 `manager-gateway`。`manager-gateway` 只需要部署在提供共享 Relay 的那台机器上。

### 1. 先让好友设备能访问 Relay

当前这套部署的 Relay 通过 Tailscale 提供，示例地址为：

```text
http://100.114.125.9:43120
```

实际配置应使用 Relay 所在设备当前的 Tailscale IP、MagicDNS 名称或管理员提供的 HTTPS 域名。Tailscale IP 可能变化，不要把历史 IP 当作永久配置。

好友的 Ubuntu 和 Windows 设备都必须满足以下条件：

1. 加入 owner 的 Tailnet，或通过 Tailscale 的设备共享功能获得对 Relay 主机的访问权限；只注册一个完全独立、没有访问 owner Tailnet 的 Tailscale 账号是不够的。
2. Tailnet ACL 允许好友设备访问 Relay 主机的 TCP `43120` 端口。
3. 在 Manager 所在的实际扩展宿主中确认 Relay 健康检查成功。

Ubuntu 示例：

```bash
# 按 Tailscale 官方方式安装后执行登录；安装过程通常需要本机管理员权限
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ping vserver
curl --max-time 5 http://100.114.125.9:43120/healthz
```

Windows 安装 Tailscale 官方客户端并使用 owner 的邀请/设备共享完成登录，然后在 PowerShell 中测试：

```powershell
tailscale ping vserver
curl.exe --max-time 5 http://100.114.125.9:43120/healthz
```

成功时健康检查应返回 HTTP 200。若好友不能加入 owner 的 Tailnet，应改为给 Relay 配置公开 HTTPS 域名和反向代理；不要把未经 HTTPS/认证保护的 Gateway 端口直接暴露到公网。

### 2. 安装最新核心 Manager

向好友提供同一份已审阅的 `0.1.19-dev` VSIX，例如：

```text
codex-accounts-manager-0.1.19-dev.vsix
```

Ubuntu：

```bash
code --install-extension codex-accounts-manager-0.1.19-dev.vsix --force
```

Windows PowerShell：

```powershell
code --install-extension .\codex-accounts-manager-0.1.19-dev.vsix --force
```

也可以在 VS Code 中执行 **Extensions: Install from VSIX…**。安装后必须 reload；如果使用 Remote-SSH，VSIX 必须安装在真正运行 Manager、Codex `auth.json` 和扩展状态的远端扩展宿主，而不是只安装在本地窗口。

不要用 Marketplace 上游版本替代本地 VSIX，也不要把 owner 的整个 VS Code 用户目录或 Manager 扩展状态目录复制给好友。

### 3. 配置 Relay URL 和首次注册令牌

在好友端 VS Code `settings.json` 中配置与 owner 完全相同的 Relay URL：

```json
{
  "codexAccounts.sharingRelayUrl": "http://100.114.125.9:43120"
}
```

首次注册需要临时提供 Relay bootstrap token。令牌不要写入 `settings.json`、VSIX、仓库或共享账号凭据中；它只用于首次向 Relay 注册该设备的公钥身份。

Ubuntu/Remote-SSH 推荐写入好友自己的用户级环境文件：

```bash
mkdir -p ~/.config/codex-accounts-manager
chmod 700 ~/.config/codex-accounts-manager
cat > ~/.config/codex-accounts-manager/manager-control.env <<'EOF'
CODEX_ACCOUNTS_SHARING_RELAY_BOOTSTRAP_TOKEN=<owner-提供的首次注册令牌>
# 只有好友机器存在 HTTP(S) 代理时才必须填写；无代理可省略
NO_PROXY=100.114.125.9,localhost,127.0.0.1
EOF
chmod 600 ~/.config/codex-accounts-manager/manager-control.env
```

Windows 可以在启动 VS Code 前用 PowerShell 临时注入：

```powershell
$env:CODEX_ACCOUNTS_SHARING_RELAY_BOOTSTRAP_TOKEN = "<owner-提供的首次注册令牌>"
$env:NO_PROXY = "100.114.125.9,localhost,127.0.0.1"
code
```

也可以把这两个变量配置为好友本人 Windows 用户的环境变量，然后完全退出并重新启动 VS Code。已经打开的 VS Code 窗口不会自动获得后来新增的环境变量。若好友不使用代理，`NO_PROXY` 不是必填；如果使用代理，Relay 的 Tailscale IP/主机名必须加入 `NO_PROXY`，否则请求可能被错误地送进公网代理。

首次注册成功后，Manager 会在好友自己的扩展状态目录保存独立的共享 ID、密钥和 Relay mailbox token。此后不需要持续保留 bootstrap token，但不要删除或复制 `sharing-local-state-v1.json`；重新生成 ID 或丢失该文件会导致好友关系需要重新建立。

### 4. 建立好友关系并完成第一次共享

1. 好友 reload 后打开 **账号共享**，复制好友设备自己的共享 ID。
2. owner 在共享弹窗中搜索并添加该 ID。
3. 好友在自己的 Manager 中接受好友请求。
4. owner 给好友添加备注，例如 `Alice-Ubuntu` 或 `Alice-Windows`，然后先共享一个测试账号，期限选 `10 分钟`。
5. 接收端 Manager 在线时会自动解密并导入已保存账号池，不需要二次确认。
6. 归还时翻转借入账号卡片，在左下角点击归还；借端会等待 owner 写回最新凭据并自动确认，确认后自动移除本地账号。

如果同一个好友同时使用 Ubuntu 和 Windows，两台设备必须分别注册、分别生成 ID、分别添加好友。两台设备显示相同 ID 通常意味着复制了同一个 `sharing-local-state-v1.json`；不要这样修复，应在没有活动租约时为其中一台重新生成 ID 并重新建立好友关系。

## 好友端故障排查

| 现象 | 优先检查 | 处理方式 |
| --- | --- | --- |
| `healthz` 超时或连接拒绝 | Tailscale 登录、ACL、Relay 主机端口 `43120`、Relay 服务 | 先执行 `tailscale ping vserver`，再执行 `curl .../healthz`；确认好友访问的是当前 Tailscale 地址 |
| `sharing relay enrollment token is invalid` | bootstrap token 没有传给实际 Extension Host，或 VS Code 未重启 | 关闭并重新启动 VS Code；Ubuntu/Remote-SSH 检查 `manager-control.env`，Windows 检查启动 VS Code 的 PowerShell 环境；不要把 token 放进 settings.json |
| `Sharing Relay request timed out` | Tailscale 路径抖动、代理接管、ACL 未放行 | 将 Relay 主机加入 `NO_PROXY`，确认 `43120` 可达；两台 Manager 必须使用同一个 Relay URL |
| 能看到好友但收不到共享 | 好友请求是否已接受、接收端 Manager 是否在线、双方是否使用同一 Relay | 在双方共享弹窗中手动执行一次同步，并确认好友关系为已接受；共享包会在接收端下一次轮询处理 |
| 共享导入提示本地已有账号 | 邮箱或 `accountId` 与好友端已有记录冲突 | Manager 默认拒绝覆盖，先确认好友端是否已有该账号，不要直接删除未备份的本地账号 |
| 归还后账号暂时仍在 | owner 尚未写回最新凭据或网络暂时中断 | 保持 Manager 在线等待自动确认；不要重复共享，也不要手动删除借入账号 |
| 额度耗尽后没有切号 | 先区分 quota batch 与模型容量恢复 | 查看 runtime 状态中的 `usageLimitExhaustionReady`、`pendingSwitch`、`switching`；若日志持续出现 `model-capacity` recovery，说明是模型容量自动 Continue，不是额度耗尽批次，见下方诊断说明 |

### 额度耗尽/后台活动 turn 的诊断边界

`runtime/status` 中的 `activeTurns` 是当前 shim 实际持有的活动 turn 数，不是共享 Relay 的账号数，也不是 VS Code 卡片数。旧的 `/tmp/codex-accounts-manager-*/<extensionHostPid>.sock` 文件可能残留，但只有被当前 shim 进程监听的 socket 才代表运行实例；可用 `ss -xlpn` 检查 socket 的进程归属。

真正的额度耗尽批次应同时满足：

- `usageLimitExhaustionReady: true`；
- `pendingSwitch` 或 `switching` 在切号事务期间短暂变为 `true`；
- 日志出现 `scope=current-exhaustion-batch` 和 `kind=usage-limit-switch`。

如果看到的是 `kind=model-capacity`，这是“Selected model is at capacity”后的容量恢复路径，会按 thread 自动发送 `Continue`，可能在界面看起来像不可见后台会话；它不证明 quota switch 失败。若 `usageLimitExhaustionReady=false`、`batchId=0`、`pendingSwitch=false`，则当前没有卡住的额度耗尽切号批次。不要仅凭 `activeTurns > 0` 终止 runtime；先确认对应 thread 是否正在正常产出或应由用户显式停止。

## 统一的部署适配

下面三种方式对客户端完全等价，差别只在端口映射和进程托管：

| 部署 | Relay 进程 | 对外地址示例 | 必须持久化 |
| --- | --- | --- | --- |
| Linux 裸机 | `node src/cli.mjs` 或 systemd/用户服务 | `http://100.x.y.z:43120` 或 HTTPS | `MANAGER_GATEWAY_STATE_DIR`、扩展状态目录 |
| Docker | 同一个 `manager-gateway` Node 进程，发布 `43120:43118` | `http://<tailscale-name>:43120` | Gateway state volume、每个 Manager 的扩展状态卷 |
| Windows/macOS | 同一个 Node 进程，由 Task Scheduler、launchd 或用户启动项托管 | HTTPS 或 Tailscale 可达地址 | Gateway state directory、扩展状态目录 |

Docker 只需要把容器内 Gateway 端口映射到宿主机，并让 Tailscale 运行在宿主机或同一容器网络命名空间；不要为 Docker 客户端另写共享协议：

```yaml
services:
  manager-gateway:
    build: ./integrations/manager-gateway
    environment:
      MANAGER_GATEWAY_HOST: 0.0.0.0
      MANAGER_GATEWAY_PORT: 43118
      MANAGER_GATEWAY_STATE_DIR: /var/lib/manager-gateway
      MANAGER_GATEWAY_TOKEN: ${MANAGER_GATEWAY_TOKEN}
      MANAGER_GATEWAY_SHARING_BOOTSTRAP_TOKEN: ${MANAGER_GATEWAY_SHARING_BOOTSTRAP_TOKEN}
      MANAGER_GATEWAY_SHARING_STATE_DIR: /var/lib/manager-gateway/sharing
    ports:
      - "43120:43118"
    volumes:
      - manager-gateway-state:/var/lib/manager-gateway

volumes:
  manager-gateway-state:
```

生产环境应在 Tailscale ACL、HTTPS 或反向代理层限制访问；非回环 Gateway 必须设置 `MANAGER_GATEWAY_TOKEN`。如果只把 `/v1/sharing/*` 放到专用反向代理，也必须保留 mailbox token 认证和 Relay 状态目录权限。

## 使用流程

1. 顶部的“账号共享”按钮打开共享弹窗，显示本机唯一用户 ID，也可以复制 ID；弹窗还支持立即同步、Relay 配置和好友备注。
2. 搜索并添加对方 ID；对方必须在自己的 Manager 中接受好友请求。
3. 选中账号后点击“共享账号”，或翻转账号卡片后点击左下角快捷共享。
4. owner 选择共享对象和归还期限。共享账号立即移出 owner 的无感池并隐藏，显示为靛青色“已共享”。
5. 共享创建后进入 1 分钟握手期；接收方 Manager 自动解密并导入到已保存账号池后才确认，不弹第二次确认。
6. 1 分钟内没有确认时，Relay 撤销待处理共享，owner 账号恢复共享前的隐藏/无感状态；接收端在撤销竞态中导入的账号也会回滚。
7. 期限到达、共享账号配额耗尽或接收方主动归还时，接收方 Manager 会删除本地共享账号并回报归还状态；借入账号卡片背面可单独提前归还。

共享筛选使用青绿色表示“借入”、靛青色表示“已共享”；选择“已共享”筛选时会自动显示被共享后隐藏的账号。

知道用户 ID 不会获得账号列表、凭据、切号或修改权限。Relay 只保存公开用户资料、请求状态和端到端加密的共享包；OAuth token 不在 Relay 中解密。

当前版本没有实现 provider 级强制撤销。owner 侧可以看到期限和归还状态，但不能仅靠本地刷新保证对方手里的旧 OAuth 凭据立即失效；租约到期只能保证 Manager 本地状态按约清理，不能替代 OpenAI provider 的 token revoke。
