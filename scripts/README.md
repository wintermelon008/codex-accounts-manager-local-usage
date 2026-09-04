# 路由切换脚本

[`codex-route.sh`](codex-route.sh) 用于在 VServer 上为 Codex CLI 或 manager
选择 OpenAI/ChatGPT 出口。它只设置子进程环境或输出当前 shell 的环境命令，不读取、保存或修改凭据。

## 路线

| 名称 | 实际来源 | manager |
| --- | --- | --- |
| `direct` | VServer 直连 | 支持，但当前 ChatGPT/API 直连不可达 |
| `local-forward` | VServer `127.0.0.1:17891`，经 SSH `RemoteForward` 到本机 `127.0.0.1:7890` | 支持 |
| `clash-http` | VServer 上 `madrid` 用户的 Clash Verge/Mihomo，HTTP `127.0.0.1:7897` | 支持 |
| `clash-socks` | 同一个 VServer Clash 的 SOCKS5 `127.0.0.1:7897` | 不支持 |

`7897` 不是 `melon` 本机的 SSH 转发：它属于 VServer 上另一个 Unix 用户的桌面 Clash
进程。使用前应得到该服务所有者或管理员授权；脚本不会把它写成持久默认值。`17891` 才是
当前 SSH 反向转发入口。

## 最短命令

```bash
# 当前 shell 切到 VServer Clash HTTP；对后续 Codex/manager 子进程生效
eval "$(./scripts/codex-route.sh env clash-http)"

# 只让一次 Codex CLI 使用 Clash HTTP
./scripts/codex-route.sh exec clash-http -- codex

# Codex 可用 SOCKS5；manager 不可用 SOCKS5
./scripts/codex-route.sh --target codex exec clash-socks -- codex

# 自动选择：both/manager 优先 Clash HTTP，再 SSH 转发，再直连
./scripts/codex-route.sh exec auto -- codex

# 查看当前环境和每条路线的 ChatGPT HTTPS 探测
./scripts/codex-route.sh status
./scripts/codex-route.sh check all
```

`env` 只输出 `export/unset`，因此适用于 Bash 和 Zsh 的 `eval`。普通执行脚本不能修改
调用它的父 shell；需要限定单次命令时优先使用 `exec`。

## manager 注意事项

manager 激活时从进程环境或 `CODEX_HOME/.env` 读取 `HTTP_PROXY`、`HTTPS_PROXY`、
`ALL_PROXY`、`NO_PROXY`，并且只接受 `http://` 或 `https://` proxy URL。当前已经运行的
VS Code Remote extension host/app-server 不会因为执行 `eval` 自动改变环境；要让 manager
使用新路线，应在启动 Remote 会话/extension host 前设置环境，然后 reload/restart。

manager 的 `http.proxy` 设置与 manager 自己读取的进程环境是两层配置，不能只改其中一层
就断言现有进程已经换路由。manager 的本地 adapter、Sub2API 或其它 Gateway 仍应保持
`NO_PROXY=127.0.0.1,localhost,::1`；脚本不会把本地 loopback 请求送进外部代理。
