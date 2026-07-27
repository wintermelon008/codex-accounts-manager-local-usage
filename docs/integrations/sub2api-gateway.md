# 独立 Sub2API Gateway 与 S+ 导入器

`integrations/sub2api-gateway` 和 `integrations/sub2api-importer` 是两个可分别安装的可选组件：

- **Gateway VSIX** 将一个 Sub2API 下游 API 作为 Manager Dashboard 的动态集成卡片注册。它不是 OAuth 账号，也不会加入普通账号池或无感切号的候选来源。
- **S+ 导入器** 是私有队列消费者。它只在已显式配置后，才将飞书私聊机器人的标准 `sub2api-data` 任务提交给 Sub2API 管理端。

核心 Manager 不包含这两个组件的配置、SecretStorage、观察器或导入逻辑。不安装它们时，Manager 仍可正常管理 OAuth 账号、配额和无感切号，也不会创建其队列、读取其密钥或启动 Gateway。

核心 Manager VSIX 有意不包含这两个包的源码。请从同一已审阅源码副本或发布附件取得相应 VSIX / tarball；不要在已安装的核心 VSIX 目录中寻找或写入集成配置。

## Gateway VSIX

先安装兼容版本的 Manager，再构建和安装独立 VSIX：

```bash
npm --prefix integrations/sub2api-gateway run package
```

在 VS Code 中使用 **Extensions: Install from VSIX…** 选择该包 `dist/` 中生成的 VSIX。安装后，重载窗口；Gateway 会通过 Manager 的版本化公开 API 注册一张 Dashboard 卡片。

在卡片中依次执行：

1. 选择“打开配置”，在本扩展自己的 VS Code 全局存储中创建示例配置。
2. 将占位的下游地址、模型和逻辑密钥引用替换为目标设备自己的值。
3. 选择“保存下游密钥”；填入可调用 `/v1` 的普通 API Key，而不是 Sub2API 管理端登录令牌。若复制的是完整 `Bearer <key>` 请求头，扩展会去除前缀；密钥只存入此可选扩展的 SecretStorage。
4. 选择“使用 Sub2API”。首次启用或停用本地回环传输时，按提示重载窗口一次。

可选的 `inventoryObserver` 使用与下游 Key 不同的只读管理密钥。它只会发出允许的 `GET` 请求，并只保留聚合后的可读额度窗口；不会保留上游账号 ID、名称、原始响应或管理端错误正文。

Gateway 配置错误采用隔离处理：下游必需字段无效时仅禁用这张可选 Gateway 卡片，不影响核心 Manager；`inventoryObserver` 字段无效时只停用观察器，下游 Gateway 仍可保存密钥、刷新并启用。配置错误时“刷新”和“打开配置”仍可使用。

自动回退默认关闭。只有在配置中显式设置 `autoFallbackToChatGpt: true`，且本地 Gateway 已确认额度耗尽时，才会安全地选择一个已验证的 ChatGPT Auth 账号。没有合格目标、刷新失败或运行时交接失败时会保持失败关闭；不会伪造成功、自动重放失败请求，或从 ChatGPT Auth 自动切回 Gateway。

要停用 Gateway，请在卡片中选择“使用 ChatGPT Auth”。要卸载它，先完成该切换，再从 VS Code 扩展视图卸载 Gateway VSIX。卸载不会自动删除旧配置、远端服务、账号或已保存的密钥；如需清理，应由用户在目标设备上明确执行。

## S+ 私有导入器

S+ 由 [飞书私聊导入机器人](feishu-private-import.md) 写入本地受限队列。机器人本身不持有 Sub2API 管理凭据，也不会调用管理端接口。安装并显式配置 `integrations/sub2api-importer` 后，才会消费该队列。

两个 Node 包也可独立生成 tarball：

```bash
npm --prefix integrations/feishu-private-import run package
npm --prefix integrations/sub2api-importer run package
```

每个 tarball 仅包含自己的运行代码、模板和文档；不会包含私有环境文件、队列任务、账号、管理令牌或现有服务配置。

在目标设备的私有环境中提供管理端地址和令牌，并按需要指定与机器人相同的受限出站队列：

```dotenv
SUB2API_ADMIN_BASE_URL=https://gateway.example.invalid
SUB2API_ADMIN_TOKEN=<private-admin-token>
SUB2API_IMPORT_QUEUE_DIR=<private-s-plus-outbox>
SUB2API_IMPORT_POLL_SECONDS=5
```

先进行一次安全的单次验证：

```bash
npm --prefix integrations/sub2api-importer test
node integrations/sub2api-importer/src/cli.cjs --once
```

常驻模式使用同一命令但不带 `--once`。成功任务只保留不含凭据的结果摘要；失败任务会标记为 `.failed`，不会自动重试。用户在检查私有队列和远端状态后，可明确决定如何处理失败任务。

若替换旧的 M+/S+ 工作器，可使用导入器包内的 `scripts/migrate-legacy-env.cjs` 从旧工作器的私有环境生成一份仅含 Sub2API 管理端信息的新环境文件。该脚本不会复制飞书、店铺或 Manager 配置，且拒绝覆盖已有文件。随后用包内 `templates/codex-accounts-sub2api-importer.service.template` 以独立用户服务运行消费者。

停止导入器进程即可禁用 S+ 消费；未消费的私有队列任务不会被 Manager 或 Gateway 自动处理。卸载导入器不会修改 Sub2API 服务、数据库、反向代理、旧机器人或历史账号数据。

## 逐步迁移

这些组件不会迁移或读取旧的 Manager Gateway 配置、旧机器人服务定义、现有 SecretStorage、账号数据或本机路径。现有部署可继续运行，直到用户在目标设备上手动完成以下步骤：

1. 安装新组件并仅使用占位配置验证其启动边界。
2. 由用户显式输入新的目标设备配置和凭据。
3. 用受控测试消息验证 M+ 或 S+，以及必要时的 Gateway 卡片。
4. 确认新路径可用后，再由用户停用旧服务。

在任何一步停止，核心 Manager 和旧服务都会保持各自原有状态。
