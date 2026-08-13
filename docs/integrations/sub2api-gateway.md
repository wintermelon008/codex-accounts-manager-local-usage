# 独立 Sub2API Gateway 与 S+ 导入器

`integrations/sub2api-gateway` 和 `integrations/sub2api-importer` 是两个可分别安装的可选组件：

- **Gateway VSIX** 将一个 Sub2API 下游 API 注册为 Manager 已保存账号中的 `Sub2API Gateway` 虚拟账号。配置、密钥、刷新和打开配置动作都在该账号卡片内；它也可以出现在手动切换列表，但不是 OAuth 账号，也不会加入任何自动账号池或候选来源。
- **S+ 导入器** 是私有队列消费者。它只在已显式配置后，才将飞书私聊机器人的标准 `sub2api-data` 任务提交给 Sub2API 管理端。

核心 Manager 不包含这两个组件的配置、SecretStorage、观察器或导入逻辑。不安装它们时，Manager 仍可正常管理 OAuth 账号、配额和无感切号，也不会创建其队列、读取其密钥或启动 Gateway。

核心 Manager VSIX 有意不包含这两个包的源码。请从同一已审阅源码副本或发布附件取得相应 VSIX / tarball；不要在已安装的核心 VSIX 目录中寻找或写入集成配置。

## Gateway VSIX

先安装兼容版本的 Manager，再构建和安装独立 VSIX：

```bash
npm --prefix integrations/sub2api-gateway run package
```

在 VS Code 中使用 **Extensions: Install from VSIX…** 选择该包 `dist/` 中生成的 VSIX。安装后，重载窗口；Gateway 会通过 Manager 的版本化公开 API 注册虚拟账号卡片和一个动态设置项。Manager 未检测到该扩展时不会显示这个设置项。

在 `Sub2API Gateway` 账号卡片中依次执行：

1. 选择“打开配置”，在本扩展自己的 VS Code 全局存储中创建示例配置。
2. 将占位的下游地址、模型和逻辑密钥引用替换为目标设备自己的值。
3. 选择“保存下游密钥”；填入可调用 `/v1` 的普通 API Key，而不是 Sub2API 管理端登录令牌。若复制的是完整 `Bearer <key>` 请求头，扩展会去除前缀；密钥只存入此可选扩展的 SecretStorage。
4. 选择“使用 Sub2API”。首次安装 runtime 仍按提示重载窗口一次；runtime 已运行后，ChatGPT Auth ↔ Sub2API 的手动切换均不需要 reload。

账号卡片会按本扩展 tracker 的真实完成 token 显示 5 小时、7 天和今日用量，并根据配置模型按内置标准 API 单价估算价格；没有观察到 token 时显示“尚未观察到”，不会用 `0` 或 `unlimited` 伪造余额。卡片内的“保存下游密钥”“刷新”“打开配置”动作仍由 Gateway 扩展执行，Manager 只渲染脱敏结果。设置中的“显示 Sub2API 账号卡片”开关只控制该虚拟账号卡片是否出现在 Dashboard，不会启用、停用或切换 Gateway 路由；路由仍通过账号卡片或手动切换列表操作。

虚拟账号只在 Manager 索引中保存下游入口描述（Base URL、模型、`credentialRef`）以及 `accountKind: "sub2api"`、`manualOnly: true` 能力标记。下游 API Key 继续只存放在本扩展 SecretStorage；Manager 不读取、映射或展示 Sub2API 上游账号，不向 `auth.json` 写入虚拟 OAuth token。虚拟账号卡片显示 `Gateway · 手动`，隐藏额度窗口、订阅、quota error、token 健康和重新授权操作。

### 多配置选择

同一张账号卡片支持多个 Sub2API 下游配置。保留当前本地配置的顶层 `sub2api`，并在顶层增加 `profiles` 数组；每个 profile 需要唯一 `id`、`displayName` 和独立的 `sub2api` 块：

```json
{
  "schema": "codex-accounts-sub2api-gateway/v1",
  "displayName": "Local Gateway",
  "sub2api": {
    "baseUrl": "http://127.0.0.1:8317/v1",
    "model": "gpt-5",
    "credentialRef": "local"
  },
  "profiles": [
    {
      "id": "external",
      "displayName": "External Gateway",
      "sub2api": {
        "baseUrl": "https://gateway.example.invalid/v1",
        "model": "gpt-5",
        "credentialRef": "external"
      }
    }
  ]
}
```

在卡片中选择“选择配置”后，再使用“保存下游密钥”为当前 profile 保存密钥；密钥仍只进入本扩展 SecretStorage。所选 profile 会持久化。活动配置的地址、模型、显示名或自动回退设置发生变化时需要重新加载窗口；这些字段都相同而只更换密钥引用时可直接生效。

可选的 `inventoryObserver` 使用与下游 Key 不同的只读管理密钥。它只会发出允许的 `GET` 请求，并只保留集成内部的聚合结果；这些上游库存不会注册到 Manager、不会进入账号卡片或切换候选，也不会保留上游账号 ID、名称、原始响应或管理端错误正文。

Gateway 配置错误采用隔离处理：下游必需字段无效时仅禁用虚拟账号卡片，不影响核心 Manager；`inventoryObserver` 字段无效时只停用集成内部观察器，不在卡片展示上游库存，下游 Gateway 仍可保存密钥、刷新并启用。配置错误时“刷新”和“打开配置”仍可使用。

自动回退默认关闭。只有在配置中显式设置 `autoFallbackToChatGpt: true`，且本地 Gateway 已确认额度耗尽时，才会安全地选择一个已验证的 ChatGPT Auth 账号。没有合格目标、刷新失败或运行时交接失败时会保持失败关闭；不会伪造成功、自动重放失败请求，或从 ChatGPT Auth 自动切回 Gateway。

要停用 Gateway，请在卡片中选择“使用 ChatGPT Auth”。该操作只在安全 turn/stream barrier 上切换 provider 路由，保留原 OAuth `currentAccountId` 和凭据；活动 stream 不能中途迁移，失败时恢复原路由。要卸载它，先完成该切换，再从 VS Code 扩展视图卸载 Gateway VSIX。卸载不会自动删除旧配置、远端服务、账号或已保存的密钥；如需清理，应由用户在目标设备上明确执行。

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
