# Codex Accounts Sub2API Gateway

这是 `Codex Accounts Manager` 的独立可选 VS Code 扩展。它提供一个本地回环 Gateway 卡片，不把 Sub2API 伪装为 OAuth 账号，也不加入 Manager 的普通账号池或无感切号来源。

未安装本包时，Manager 不读取本包的配置或 SecretStorage，也不会启动 Gateway、观察库存或处理 Sub2API 导入任务。

## 安装与启用

1. 先安装并启用兼容版本的 Codex Accounts Manager。
2. 安装本扩展的 VSIX；它会在启动后通过 Manager 的公开集成 API 注册自己。
3. 在 Manager Dashboard 的 `Sub2API Gateway` 卡片选择“打开配置”。首次会在**本扩展自己的** VS Code 全局存储中创建模板。
4. 在配置中填入目标 Sub2API 下游地址、模型和逻辑密钥引用；再用卡片“保存下游密钥”。此处必须填可调用 `/v1` 的普通 API Key，不是管理端登录令牌；可粘贴带 `Bearer ` 前缀的值，扩展会安全归一化。密钥仅存入本扩展的 VS Code SecretStorage。
5. 选择“使用 Sub2API”。首次启用无感运行时可能需要重新加载 VS Code 窗口一次。

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
  "autoFallbackToChatGpt": false
}
```

`inventoryObserver` 是可选块。它必须使用与下游 API Key 不同的 `credentialRef`，且只会向 Sub2API 管理端发出 `GET` 请求，聚合可读窗口而不保留账号 ID、名称或原始响应。

### 配置错误隔离

- 下游 Gateway 的必需配置无效时，只有这张可选卡片不可用；核心 Manager 的账号管理、配额和无感切号不受影响。
- `inventoryObserver` 是独立的可选配置。即使它的地址、分组或密钥引用格式错误，下游 Gateway 配置仍会保留并可继续保存下游密钥、刷新和启用；卡片只会在“只读库存观察”处显示配置警告并停用该观察器。
- “刷新”和“打开配置”在配置错误时仍可用，便于修正文件后重新读取，而不会要求卸载或重置其他功能。

## 安全与回退

- 下游 Key 和观察密钥只保存在本扩展的 SecretStorage；Manager 公共 API、Dashboard 和全局状态都不会得到它们。
- 回环适配器仅由 Manager 的通用 Gateway 运行时持有运行中密钥，并且只绑定本地回环接口。
- 自动回退默认关闭。只有显式设置 `autoFallbackToChatGpt: true`、且 Gateway 返回受限的额度耗尽语义时，才会请求 Manager 安全切换到合格的 ChatGPT Auth 账号。
- 回退失败时保持 Gateway 路由并使用有界退避重试；不会伪造成功、不会自动重放已经失败的请求，也不会自动从 ChatGPT Auth 切回 Gateway。
- “使用 ChatGPT Auth”只撤销本包对 Gateway 的选择，不删除配置或已保存密钥。

本包不迁移旧的 Manager 配置、旧机器人服务、现有密钥或账号数据。需要逐步迁移时，请保留旧部署，验证本包后再由用户显式切换。

## 打包与验证

```bash
npm --prefix integrations/sub2api-gateway test
npm --prefix integrations/sub2api-gateway run package
```

`package` 生成 VSIX 到包内 `dist/`，并在打包前执行可移植性审计。请不要把私有配置文件、账号 JSON 或生成的 VSIX 当作凭据存储位置。
