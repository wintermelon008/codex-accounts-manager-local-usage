# Codex Accounts Manager · Local Build

[English](README.en.md) · 简体中文

面向 VS Code 的多 Codex 账号管理扩展：导入或 OAuth 添加账号、查看配额、切换当前 `auth.json`，并提供本机用量、实验性无感切号和可选的本地集成。

> 这是基于上游 `v0.1.16` 的本地 fork。本文说明的是带 `-local` 版本号的本仓库构建；VS Code Marketplace 上的上游扩展不承诺包含下列本地功能。

## 三分钟开始

1. 安装本仓库提供或自行构建的 `-local` `.vsix`。
2. 从命令面板运行 `Codex Accounts: Add Account via OAuth`，或 `Codex Accounts: Import Current auth.json`。
3. 运行 `Codex Accounts: Show Quota Summary`，在 Dashboard 中刷新配额、切换账号和管理备份。

首次启动时，如本机已有 Codex `auth.json`，扩展会提供绑定并刷新配额的入口。账号记录和凭据保留在当前本机/远端扩展宿主；切换会更新该宿主当前生效的 Codex `auth.json`。

## 功能与前置条件

下表只适用于本仓库打包的本地版本。

| 类别       | 功能                                                                       | 需要做什么                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 直接可用   | 多账号 OAuth/导入、配额卡片、手动启动额度倒计时、切换、详情、备份/恢复、状态栏、跨窗口同步 | 安装后导入账号即可使用；倒计时启动按钮仅在服务端报告的额度窗口尚未启动时显示（例如 5 小时、7 天或 30 天窗口）。                                                                  |
| 直接可用   | 本机 Codex token 用量、Free/Plus/Pro 多选筛选                              | 读取已缓存的本机元数据；首次使用或需要最新值时点击“刷新用量”，不读取会话正文。                                                                    |
| 设置后启用 | 官方自动切号、低额度提醒、配额定时刷新、Codex App 重启                     | 在 Dashboard 设置中显式打开相应开关；默认不会自动切号。                                                                                          |
| 一次性安装 | 实验性无感切号与额度分档                                                   | Linux/macOS 运行安装命令、按提示 reload 一次、准备至少两个新鲜账号并在 Dashboard 配置账号池。Windows 目前不支持。                                |
| 可选包     | 飞书私聊 M+/S+ 导入                                                        | 单独安装受限的飞书私聊机器人；M+ 仍需显式打开 Manager 本地收件箱，S+ 仅在另行启动导入器后消费。                                                   |
| 可选包     | Sub2API Gateway                                                            | 单独安装 Gateway VSIX，再由其 Dashboard 卡片配置和保存密钥。核心 Manager 没有该供应商的设置、配置或 SecretStorage 访问。                        |

## 无感切号（实验性）

它与上游“自动切号”分开：无感模式在同一个 Codex app-server 的安全边界上更新认证，成功后不需要 reload，现有 thread/history 保持可见。

1. 导入并刷新至少两个有权限使用的账号。
2. 运行 `Codex Accounts: Install Experimental Seamless Runtime`，然后 reload 一次。
3. 在账号卡片中加入无感池；按需使用隐藏、`A/B/C` 分组和套餐筛选整理可见范围。
4. 在 Dashboard 打开“无感切号（实验性）”，按需分别启用“分档切号”和“低额度切号”；建议配合 `1` 分钟配额刷新。
5. “分档切号”下选择分档方式和等待时间；“低额度切号”下选择“耗尽后切换”、`1%`、`3%`（默认）或 `5%`；再选择通用的“切换策略”。

关闭“低额度切号”后，低额度、结构化 `usageLimitExceeded` 和耗尽批次都不会发起新的自动切换，分档切号保持独立。选择“耗尽后切换”时，同一档位会等待当前活跃会话全部实际因额度耗尽终止，最长 6 小时。自动继续仍可能重复非幂等外部操作。完整规则见 [无感切号说明](docs/HOT_SWITCH.md)。

## 可选本地集成

- [飞书私聊 M+/S+ 导入包](docs/integrations/feishu-private-import.md)：仅接收管理员一对一文本消息；M+ 写入 Manager 的显式本地收件箱，S+ 只写入独立私有队列。
- [独立 Sub2API Gateway 与 S+ 导入器](docs/integrations/sub2api-gateway.md)：Gateway VSIX、管理端导入器和核心 Manager 可独立安装/停用；不伪造 OAuth 账号，也不加入普通账号池。

## 安装与更新

### 使用本地版本

从本仓库获得 `codex-accounts-manager-<version>-local.<build>.vsix`，然后在目标 VS Code 窗口执行 **Extensions: Install from VSIX…**，或运行：

```bash
code --install-extension codex-accounts-manager-<version>-local.<build>.vsix
```

本地能力依赖这份 VSIX；如果刻意安装 Marketplace 更新，需重新安装经审阅的本地 VSIX。详细的更新边界与定制校验见 [本地定制说明](docs/LOCAL_CUSTOMIZATION.md)。

### 从源码构建

```bash
git clone https://github.com/wintermelon008/codex-accounts-manager-local-usage.git
cd codex-accounts-manager-local-usage
npm ci
npm run package
```

`npm run package` 会先执行本地定制完整性校验，再生成 `.vsix`。详细文档会一并打进该 VSIX，安装后 README 中的相对链接仍可用。

可选包不包含在核心 VSIX 中。分别进入 `integrations/feishu-private-import`、`integrations/sub2api-gateway` 或 `integrations/sub2api-importer` 按各自 README 构建和配置；它们不会自动复制旧服务、凭据、账号或设备路径。

### 使用上游 Marketplace 版本

如只需要上游核心账号管理功能，可在扩展市场搜索发布者 `wannanbigpig` 的 **Codex Accounts Manager**。它与本 fork 独立发布；不要假设其包含本机用量、飞书收件箱、Sub2API Gateway 或本地无感切号增强。

## 文档索引

- [无感切号、额度分档与阈值](docs/HOT_SWITCH.md)
- [独立 Sub2API Gateway、S+ 导入器与迁移](docs/integrations/sub2api-gateway.md)
- [飞书私聊 M+/S+ 导入机器人](docs/integrations/feishu-private-import.md)
- [核心与可选组件的独立交付、停用和迁移](docs/integrations/README.md)
- [核心本地文本导入收件箱](docs/LOCAL_IMPORT_INBOX.md)
- [本地定制、更新与构建安全](docs/LOCAL_CUSTOMIZATION.md)
- [变更日志](docs/CHANGELOG.md)

常用命令：`Add Account via OAuth`、`Import Current auth.json`、`Show Quota Summary`、`Refresh All Quotas`、`Install/Remove Experimental Seamless Runtime`。其余操作可从 Dashboard 或命令面板进入。

## 反馈与许可

- 本 fork：<https://github.com/wintermelon008/codex-accounts-manager-local-usage>
- 上游项目：<https://github.com/wannanbigpig/codex-tools>
- 许可证：[MIT](LICENSE)
