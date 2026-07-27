# 飞书私聊导入机器人

`integrations/feishu-private-import` 是独立 Node 包，用于飞书开发者平台应用机器人的私聊 M+/S+ 导入。它不属于 Manager 本体；不安装或不运行该包时，Manager 不会通过它接收任何消息。

## 安全边界

- 仅处理 `im.message.receive_v1` 的一对一私聊（`p2p`）文本消息。
- 先检查会话类型和 `FEISHU_ADMIN_OPEN_IDS`，再识别任何会话字段；群聊、文档评论、其他事件和未授权发送者不会进入解析器。
- M+ 写入 Manager 的受限本地收件箱；令牌只会留在任务文件中供 Manager 导入，回复中只有数量与任务编号。
- S+ 只写出标准 `sub2api-data` 本地任务，直到另一个已安装且显式配置的 Sub2API 导入器消费它；机器人本身不持有或调用 Sub2API 管理凭据。
- 输入可为完整 JSON、代码围栏、嵌入式 JSON 或不完整键值文本。恢复逻辑只识别已知 OAuth 字段，绝不执行文本中的表达式。

## 目标设备配置

使用包内 README 的私有环境变量模板。先用 `npm --prefix integrations/feishu-private-import run package` 生成独立可安装 tarball；不要把环境文件、应用密钥、管理员 Open ID、账号数据或绝对设备路径提交到仓库、打包文件或聊天记录。

默认状态目录由目标设备的标准运行时目录解析；若 Manager 或 Sub2API 导入器使用了不同目标，分别显式设置 `MANAGER_IMPORT_QUEUE_DIR` 与 `SUB2API_IMPORT_QUEUE_DIR`。这不是自动迁移：现有机器人、监控服务与凭据保持不变，直到用户手动切换。

## 飞书开发者平台

配置一个应用机器人并订阅消息接收事件，将回调 URL 指向该机器人在目标设备上提供的 HTTPS 入口。回调验证使用私有的 `FEISHU_VERIFICATION_TOKEN`。本版不接受加密回调载荷，因此应在开发者平台中关闭该项；TLS 终止可由目标设备现有的安全反向代理负责。

机器人仅提供 M+/S+ 与 M+ 状态查询，不承担商品监测群命令、旧 webhook 流程或 Codex 操纵功能。

若目标已有同一 App 的飞书长连接桥接（例如监控操纵助手），不要与本 HTTP 包并行启动。应将该桥接的私聊 M+/S+ 入口适配为相同的 `session-ingress` 队列协议，并保留群聊店铺查询；独立 S+ 导入器仍可复用同一出站队列。
