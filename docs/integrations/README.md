# 独立组件交付与迁移

本仓库的核心 Manager 与三项可选组件分别交付。核心 VSIX 有意不包含可选组件源码、私有环境文件或已有服务配置；请从同一已审阅源码副本或发布附件取得对应产物。

| 组件 | 产物 | 启用 | 停用 / 卸载 |
| --- | --- | --- | --- |
| 核心 Manager | 根目录生成的 Manager VSIX | 在 VS Code 安装后直接导入或 OAuth 添加账号；M+ 需要显式开启本地收件箱设置 | 关闭各项可选设置或移除无感 runtime；在扩展视图卸载核心 VSIX |
| 飞书私聊 M+/S+ 机器人 | `feishu-private-import` tarball | 由用户提供私有飞书应用配置后启动；只接受管理员一对一文本 | 停止机器人进程或服务，再卸载其 Node 包；不会删除 Manager、Gateway 或远端服务数据 |
| Sub2API Gateway | 独立 Gateway VSIX | 安装后从已保存账号中的 Sub2API 卡片配置、保存密钥并选择 Gateway；设置中会出现动态卡片显示开关 | 先在账号卡片切回 ChatGPT Auth，再卸载 Gateway VSIX |
| S+ 导入器 | `sub2api-importer` tarball | 用户提供私有管理端配置后启动队列消费者；新账号按独立包策略配置代理、分组、并发与模型映射 | 停止消费者，再卸载其 Node 包；未消费任务不会被 Manager 自动处理 |

从源码构建全部产物：

```bash
npm run package
npm --prefix integrations/feishu-private-import run package
npm --prefix integrations/sub2api-gateway run package
npm --prefix integrations/sub2api-importer run package
```

VSIX 通过 VS Code 的 **Extensions: Install from VSIX…** 安装。Node tarball 可按目标设备的 Node 包管理策略安装；安装后仍必须由用户提供私有环境配置并显式启动进程，没有自动服务注册。

## 逐步迁移

1. 保持旧机器人、Gateway 和监控服务不变。
2. 在目标设备单独安装一个新组件，并仅用占位配置验证启动边界。
3. 由用户输入该设备的私有凭据，使用受控 M+、S+ 或 Gateway 操作验证结果。
4. 确认新路径稳定后，再由用户显式停用旧路径。

组件不会自动扫描、复制、迁移或删除已有账号、凭据、服务定义、队列内容或设备信息。未安装任一可选组件时，核心 Manager 的账号管理、配额和无感切号仍按原有工作流运行。

## 已有监控操纵助手的迁移

若已有飞书开发者应用通过长连接桥接“监控操纵助手”，不要再为同一个 App 同时启动 `feishu-private-import` HTTP 机器人；同一入站事件只能由一个服务负责，双路径会带来重复导入风险。

正确切换方式是保留现有 App、私聊命令和群聊店铺查询，只让该桥接的私聊 M+/S+ 处理器调用本仓库的 `session-ingress` 协议：M+ 写 Manager 收件箱，S+ 写独立出站队列；再单独运行 `sub2api-importer`。桥接进程不应持有 Sub2API 管理令牌，旧导入 worker 保留到受控验证完成后再停用。
