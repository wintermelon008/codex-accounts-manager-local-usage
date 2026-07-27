# Feishu Private Import

独立的飞书开发者平台事件回调机器人，只处理管理员在一对一私聊中的账号导入。

- `m+ <会话>`：识别 Codex、CPA、Cockpit/Cookpit、Manager 或 Sub2API 会话，转换为 Manager Shared JSON 后写入受限本地队列。
- `s+ <会话>`：将同一组受支持格式转换为标准 `sub2api-data`，写入独立的 S+ 本地出站队列；它不会自行调用任何 Sub2API 管理接口。
- 群聊、文档评论、非文本消息和未授权发送者均不会进入凭据识别器。

本包不读取或修改 Manager、旧机器人、监控项目、账号索引或已有凭据。

## 配置

仅通过目标设备的私有环境注入配置：

```dotenv
FEISHU_APP_ID=<developer-platform-app-id>
FEISHU_APP_SECRET=<developer-platform-app-secret>
FEISHU_VERIFICATION_TOKEN=<event-subscription-verification-token>
FEISHU_ADMIN_OPEN_IDS=<comma-separated-administrator-open-ids>

# 任选：默认使用可移植的标准状态目录发现。
MANAGER_IMPORT_QUEUE_DIR=<absolute-private-manager-inbox-directory>
SUB2API_IMPORT_QUEUE_DIR=<absolute-private-sub2api-outbox-directory>
SESSION_INGRESS_STATE_DIR=<absolute-private-state-directory>

# 任选：默认只绑定本地回环地址和 3000 端口。
FEISHU_LISTEN_HOST=<target-listen-host>
FEISHU_LISTEN_PORT=<target-listen-port>
FEISHU_ENDPOINT_PATH=/feishu/events
```

飞书开发者平台需将事件订阅 URL 指向 `FEISHU_ENDPOINT_PATH`，启用应用机器人，并订阅 `im.message.receive_v1`。此版本要求事件回调不使用飞书加密载荷；回调验证仍会校验 `FEISHU_VERIFICATION_TOKEN`。为发送私聊回执，应用还需要相应的消息读取和发送权限。

Manager 端仍需由用户显式启用本地导入收件箱。若目标 Manager 使用自定义收件箱目录，机器人必须通过 `MANAGER_IMPORT_QUEUE_DIR` 指向相同的目标目录。机器人与 Manager 必须运行在同一目标设备或一个由用户明确配置的受限共享目录上。

## 运行与验证

```bash
npm --prefix integrations/feishu-private-import test
npm --prefix integrations/feishu-private-import run package:check
npm --prefix integrations/feishu-private-import run package
node integrations/feishu-private-import/src/cli.mjs
```

`package` 会在本包自己的 `dist/` 中生成可安装 tarball；它不包含私有环境文件、凭据、账号或现有服务配置。可使用 `templates/feishu-private-import.service.template` 作为用户级服务模板。模板只包含 `{{PRIVATE_ENV_FILE}}`、`{{NODE_BIN}}` 与 `{{PACKAGE_ROOT}}` 占位符，必须在目标设备上由用户填入；不会复制或推断任何现有服务配置。
