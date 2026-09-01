# Codex Accounts Sub2API Gateway

这是 `Codex Accounts Manager` 的独立可选 VS Code 扩展。它把下游入口注册为已保存账号中的 `Sub2API Gateway` 虚拟账号，允许手动切换但不把 Sub2API 伪装为 OAuth 账号，也不加入 Manager 的任何自动账号池或候选来源。旧的独立 Gateway 面板不再注册。

未安装本包时，Manager 不读取本包的配置或 SecretStorage，也不会启动 Gateway、观察库存或处理 Sub2API 导入任务。

## 安装与启用

1. 先安装并启用兼容版本的 Codex Accounts Manager。
2. 安装本扩展的 VSIX；它会在启动后通过 Manager 的公开集成 API 注册自己。
3. 在 Manager Dashboard 的 `Sub2API Gateway` 账号卡片选择“打开配置”。首次会在**本扩展自己的** VS Code 全局存储中创建模板。
4. 在配置中填入目标 Sub2API 下游地址、模型和逻辑密钥引用；再用卡片“保存下游密钥”。此处必须填可调用 `/v1` 的普通 API Key，不是管理端登录令牌；可粘贴带 `Bearer ` 前缀的值，扩展会安全归一化。密钥仅存入本扩展的 VS Code SecretStorage。
5. 选择“使用 Sub2API”。首次安装 runtime 可能需要重新加载 VS Code 窗口一次；之后 ChatGPT Auth ↔ Sub2API 手动切换不需要 reload。

账号卡片内还提供“保存下游密钥”和“刷新”按钮，并显示 Base URL、模型、密钥状态，以及 tracker 观察到的今日/7 天 token 用量和按配置模型估算的标准 API 价格。价格是估算值，不代表 Sub2API 账单；未观察到 token 时不会填入伪造额度。安装并注册本扩展后，Manager 设置中会出现“显示 Sub2API 账号卡片”开关，默认关闭；它只控制卡片可见性，不会直接切换路由；未安装时该设置项不存在。

虚拟账号仅保存 Base URL、模型和 `credentialRef` 描述，并标记为 `manualOnly`/`quotaMode: "none"`。Manager 不读取 Sub2API 上游账号、不保存下游 API Key，也不为虚拟账号创建 OAuth token 或写入 `auth.json`。账号卡片只显示 `Gateway · 手动`，不显示额度、订阅、quota error 或 token 健康操作。

示例配置只使用占位地址：

```json
{
  "schema": "codex-accounts-sub2api-gateway/v1",
  "displayName": "Sub2API Gateway",
  "sub2api": {
    "baseUrl": "https://gateway.example.invalid/v1",
    "model": "gpt-5",
    "credentialRef": "primary"
  },
  "autoFallbackToChatGpt": false,
  "profiles": []
}
```

要在同一张账号卡片中选择多个下游配置，保留现有顶层配置作为本地配置，在 `profiles` 中追加外部配置。每项都需要唯一的 `id`、显示名、`/v1` 地址、模型和自己的 `credentialRef`：

```json
{
  "id": "external",
  "displayName": "External Gateway",
  "sub2api": {
    "baseUrl": "https://external.example.invalid/v1",
    "model": "gpt-5",
    "credentialRef": "external"
  }
}
```

保存配置文件后，在账号卡片选择“选择配置”，再为当前配置选择“保存下游密钥”。所选配置会持久化；如果切换后的地址、模型、显示名或自动回退设置不同，runtime 会提示重新加载窗口后生效。

`inventoryObserver` 是可选块。它必须使用与下游 API Key 不同的 `credentialRef`，且只会向 Sub2API 管理端发出 `GET` 请求；聚合结果只由本扩展内部使用，不会注册为 Manager 账号、不会显示上游账号或参与切换。

### 配置错误隔离

- 下游 Gateway 的必需配置无效时，只有这张可选卡片不可用；核心 Manager 的账号管理、配额和无感切号不受影响。
- `inventoryObserver` 是独立的可选配置。即使它的地址、分组或密钥引用格式错误，下游 Gateway 配置仍会保留并可继续保存下游密钥、刷新和启用；观察器只在本扩展内部停用，账号卡片不会展示上游库存或账号详情。
- “刷新”和“打开配置”在配置错误时仍可用，便于修正文件后重新读取，而不会要求卸载或重置其他功能。

## 安全与回退

- 下游 Key 和观察密钥只保存在本扩展的 SecretStorage；Manager 公共 API、Dashboard 和全局状态都不会得到它们。
- 回环适配器仅由 Manager 的通用 Gateway 运行时持有运行中密钥，并且只绑定本地回环接口。
- 自动回退默认关闭。只有显式设置 `autoFallbackToChatGpt: true`、且 Gateway 返回受限的额度耗尽语义时，才会请求 Manager 安全切换到合格的 ChatGPT Auth 账号。
- 回退失败时保持 Gateway 路由并使用有界退避重试；不会伪造成功、不会自动重放已经失败的请求，也不会自动从 ChatGPT Auth 切回 Gateway。
- “使用 ChatGPT Auth”复用 runtime 的 turn/stream barrier 切换 provider 路由，保留 OAuth 当前账号；活动 stream 不能中途迁移，切换失败会恢复原路由，也不删除配置或已保存密钥。

本包不迁移旧的 Manager 配置、旧机器人服务、现有密钥或账号数据。需要逐步迁移时，请保留旧部署，验证本包后再由用户显式切换。

## 打包与验证

```bash
npm --prefix integrations/sub2api-gateway test
npm --prefix integrations/sub2api-gateway run package
```

`package` 生成 VSIX 到包内 `dist/`，并在打包前执行可移植性审计。请不要把私有配置文件、账号 JSON 或生成的 VSIX 当作凭据存储位置。
