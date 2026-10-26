# 组件交付与迁移

本仓库的 Manager 与可选组件按不同边界交付。Mailbox 已作为默认关闭的内置模块随 Manager VSIX 提供；其他可选组件仍保持独立交付。任何组件都不会自动复制私有环境文件或已有服务配置。

| 组件 | 产物 | 启用 | 停用 / 卸载 |
| --- | --- | --- | --- |
| 核心 Manager | 根目录生成的 Manager VSIX | 在 VS Code 安装后直接导入或 OAuth 添加账号；本地收件箱和外部控制接口按需启用 | 关闭各项可选设置或移除无感 runtime；在扩展视图卸载核心 VSIX |
| Manager headless runtime | 根目录编译出的 `out/runtime/managerDaemon.js` + systemd 用户服务模板 | 与 Manager 共用 private state，长期执行 token 续期、开启后的 Mailbox 自动续期、额度刷新和本地导入；默认不接管 Codex app-server | 停止 daemon 服务即可；不会删除账号、凭据或 VS Code 扩展 |
| 飞书 Manager 操纵助手 | `feishu-assistant` tarball | 使用全新的飞书 App 长连接；管理员一对一私聊查询账号、今日用量、触发额度刷新和查看导入状态；Manager 回环控制接口默认开启 | 停止机器人进程或服务、关闭 `codexAccounts.externalControlEnabled`，再卸载其 Node 包；不会删除 Manager、账号或队列数据 |
| Sub2API Gateway | 独立 Gateway VSIX | 安装后默认隐藏已保存账号中的 Sub2API 卡片；在设置中开启后配置、保存密钥并选择 Gateway | 先在账号卡片切回 ChatGPT Auth，再卸载 Gateway VSIX |
| Mailbox | Manager VSIX 内置 `mailbox` 模块 | 在 Dashboard 设置中开启“邮箱管理”总开关后，使用邮箱面板、注册助手、验证码监听、人工续期和后台自动续期 | 关闭“邮箱管理”总开关；不会删除邮箱凭据、邮件记录、注册历史或配置 |
| Manager Gateway | `manager-gateway` Node companion | Manager extension 在线时提供 Workbench task/session、并行 exec 和额度批次恢复；不持有 Workbench SQLite | 先停止浏览器客户端和 Gateway，再停止/卸载 companion；不会删除账号或 Workbench 数据库 |

从源码构建全部产物：

```bash
npm run package
npm --prefix integrations/feishu-assistant run package
npm --prefix integrations/sub2api-gateway run package
npm --prefix integrations/manager-gateway run package
```

VSIX 通过 VS Code 的 **Extensions: Install from VSIX…** 安装。Node tarball 可按目标设备的 Node 包管理策略安装；安装后仍必须由用户提供私有环境配置并显式启动进程，没有自动服务注册。

## 逐步迁移

1. 保持旧机器人、Gateway 和监控服务不变。
2. 在目标设备单独安装一个新组件，并仅用占位配置验证启动边界。
3. 由用户输入该设备的私有凭据，使用受控 Gateway 或 Manager 操作验证结果。
4. 确认新路径稳定后，再由用户显式停用旧路径。

组件不会自动扫描、复制、迁移或删除已有账号、凭据、服务定义、队列内容或设备信息。未安装任一可选组件时，核心 Manager 的账号管理、配额和无感切号仍按原有工作流运行。
