# Manager 账号共享

账号共享由 Manager 的共享 Relay 负责跨网络转发。两台 Manager 只需要访问同一个 Relay；它们不建立应用层的点对点连接，也不要求公网 IP。Relay 只转发公开目录、请求状态和端到端密文包。

Docker、Linux 裸机、Windows 和 macOS 使用同一套 Relay HTTP API、加密 envelope 和租约状态机。部署方式只决定 Gateway 如何监听端口、如何自启动以及状态目录如何持久化；Manager 客户端不应根据设备类型切换共享逻辑。

## Relay 配置

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
