# 独立 Sub2API Gateway

`integrations/sub2api-gateway` 是可独立安装的可选组件：

- **Gateway VSIX** 将一个 Sub2API 下游 API 注册为 Manager 已保存账号中的 `Sub2API Gateway` 虚拟账号。配置、密钥、刷新和打开配置动作都在该账号卡片内；它也可以出现在手动切换列表，但不是 OAuth 账号，也不会加入任何自动账号池或候选来源。

核心 Manager 不包含该组件的配置、SecretStorage 或观察器逻辑。不安装它时，Manager 仍可正常管理 OAuth 账号、配额和无感切号，也不会读取其密钥或启动 Gateway。

核心 Manager VSIX 有意不包含该包的源码。请从同一已审阅源码副本或发布附件取得相应 VSIX；不要在已安装的核心 VSIX 目录中寻找或写入集成配置。

## Gateway VSIX

先安装兼容版本的 Manager，再构建和安装独立 VSIX：

```bash
npm --prefix integrations/sub2api-gateway run package
```

在 VS Code 中使用 **Extensions: Install from VSIX…** 选择该包 `dist/` 中生成的 VSIX。安装后，重载窗口；Gateway 会通过 Manager 的版本化公开 API 注册虚拟账号卡片和一个动态设置项。Manager 未检测到该扩展时不会显示这个设置项。

安装并重载后，Sub2API Gateway 账号卡片默认不显示；如需使用，在 Manager 设置中打开“显示 Sub2API 账号卡片”，再在该账号卡片中依次执行：

1. 选择“打开配置”，在本扩展自己的 VS Code 全局存储中创建示例配置。
2. 将占位的下游地址、模型和逻辑密钥引用替换为目标设备自己的值。
3. 选择“保存下游密钥”；填入可调用 `/v1` 的普通 API Key，而不是 Sub2API 管理端登录令牌。若复制的是完整 `Bearer <key>` 请求头，扩展会去除前缀；密钥只存入此可选扩展的 SecretStorage。
4. 选择“使用 Sub2API”。首次安装 runtime 仍按提示重载窗口一次；runtime 已运行后，ChatGPT Auth ↔ Sub2API 的手动切换均不需要 reload。

账号卡片会按本扩展 tracker 的真实完成 token 显示 5 小时、7 天和今日用量，并根据配置模型按内置标准 API 单价估算价格；没有观察到 token 时显示“尚未观察到”，不会用 `0` 或 `unlimited` 伪造余额。卡片内的“保存下游密钥”“刷新”“打开配置”动作仍由 Gateway 扩展执行，Manager 只渲染脱敏结果。设置中的“显示 Sub2API 账号卡片”开关默认关闭，只控制该虚拟账号卡片是否出现在 Dashboard，不会启用、停用或切换 Gateway 路由；路由仍通过账号卡片或手动切换列表操作。

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

## 逐步迁移

该组件不会迁移或读取旧的 Manager Gateway 配置、现有 SecretStorage、账号数据或本机路径。现有部署可继续运行，直到用户在目标设备上手动完成以下步骤：

1. 安装 Gateway VSIX 并仅使用占位配置验证其启动边界。
2. 由用户显式输入新的目标设备配置和凭据。
3. 用受控请求验证 Gateway 卡片和 provider 路由。
4. 确认新路径可用后，再由用户停用旧服务。

在任何一步停止，核心 Manager 和旧服务都会保持各自原有状态。
