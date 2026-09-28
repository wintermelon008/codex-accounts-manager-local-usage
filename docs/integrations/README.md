# 独立组件交付与迁移

本仓库的核心 Manager 与多项可选组件分别交付。核心 VSIX 有意不包含可选组件源码、私有环境文件或已有服务配置；请从同一已审阅源码副本或发布附件取得对应产物。

| 组件 | 产物 | 启用 | 停用 / 卸载 |
| --- | --- | --- | --- |
| 核心 Manager | 根目录生成的 Manager VSIX | 在 VS Code 安装后直接导入或 OAuth 添加账号；本地收件箱和外部控制接口按需启用 | 关闭各项可选设置或移除无感 runtime；在扩展视图卸载核心 VSIX |
| 飞书 Manager 操纵助手 | `feishu-assistant` tarball | 使用全新的飞书 App 长连接；管理员一对一私聊查询账号、今日用量、触发额度刷新和查看导入状态；Manager 回环控制接口默认开启 | 停止机器人进程或服务、关闭 `codexAccounts.externalControlEnabled`，再卸载其 Node 包；不会删除 Manager、账号或队列数据 |
| Sub2API Gateway | 独立 Gateway VSIX | 安装后默认隐藏已保存账号中的 Sub2API 卡片；在设置中开启后配置、保存密钥并选择 Gateway | 先在账号卡片切回 ChatGPT Auth，再卸载 Gateway VSIX |
| Mailbox | `integrations/mailbox` 独立 VSIX | 用户在导入时选择邮箱 provider 后，从 Mailbox 面板手动查询、启动验证码监听或人工续期 | 先停止邮箱操作，再卸载可选 VSIX；不影响 Manager 账号和 Sub2API |
| Manager Gateway | `manager-gateway` Node companion | Manager extension 在线时提供 Workbench task/session、并行 exec 和额度批次恢复；不持有 Workbench SQLite | 先停止浏览器客户端和 Gateway，再停止/卸载 companion；不会删除账号或 Workbench 数据库 |

从源码构建全部产物：

```bash
npm run package
npm --prefix integrations/feishu-assistant run package
npm --prefix integrations/sub2api-gateway run package
npm --prefix integrations/mailbox run package
npm --prefix integrations/manager-gateway run package
```

VSIX 通过 VS Code 的 **Extensions: Install from VSIX…** 安装。Node tarball 可按目标设备的 Node 包管理策略安装；安装后仍必须由用户提供私有环境配置并显式启动进程，没有自动服务注册。

## 逐步迁移

1. 保持旧机器人、Gateway 和监控服务不变。
2. 在目标设备单独安装一个新组件，并仅用占位配置验证启动边界。
3. 由用户输入该设备的私有凭据，使用受控 Gateway 或 Manager 操作验证结果。
4. 确认新路径稳定后，再由用户显式停用旧路径。

组件不会自动扫描、复制、迁移或删除已有账号、凭据、服务定义、队列内容或设备信息。未安装任一可选组件时，核心 Manager 的账号管理、配额和无感切号仍按原有工作流运行。
