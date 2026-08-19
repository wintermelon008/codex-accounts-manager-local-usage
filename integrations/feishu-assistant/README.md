# Feishu Manager Assistant

这是一个全新的、独立运行的飞书机器人，使用飞书官方 Node SDK 的长连接接收 `im.message.receive_v1` 事件。它与 `feishu-private-import` 使用不同的进程和飞书 App，不共享事件入口，也不会自动读取旧机器人配置。

当前版本通过 Manager 的本地回环控制接口提供：

- 查看账号数量、健康状态、额度窗口、无感池资格和今日 Token 用量；
- 查看今日按模型用量；
- 触发全部或指定账号的额度刷新，并异步回报结果；
- 查询本地 M+ 导入任务的脱敏状态；
- 检查 Manager 控制接口健康状况；
- 分析 HTTPS 商品页，按条件筛选有库存的最低价商品，并保存网页使用步骤；
- 在支付适配器确认成功后，为显式配置的网站执行器提供已保存流程。

机器人只接受管理员的一对一私聊。消息中不会接受或回显账号令牌；账号导入仍使用 Manager 已有的本地受限收件箱协议。

## 1. 创建新的飞书 App

在飞书开发者后台创建一个全新的企业自建应用，并启用机器人能力。订阅事件时选择长连接模式，不需要为此机器人暴露公网 HTTP 回调地址；订阅 `im.message.receive_v1`。为应用开通发送机器人消息所需的 IM 权限，并按开发者后台要求发布或启用应用。

把管理员的 `open_id` 放入 `FEISHU_ADMIN_OPEN_IDS`。不要把 App Secret、Manager 控制令牌或其他私密配置写入仓库。

## 2. 配置 Manager

在启动 VS Code / Manager 的环境中设置一个仅本机使用的随机控制令牌，并显式打开外部控制接口：

```dotenv
CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN=<local-private-token>
```

然后在 VS Code 设置中启用：

```json
{
  "codexAccounts.externalControlEnabled": true,
  "codexAccounts.externalControlPort": 43117
}
```

接口只绑定 `127.0.0.1`，所有请求必须携带同一个 Bearer 令牌。默认地址为 `http://127.0.0.1:43117`；如果修改端口，机器人配置中的 `MANAGER_CONTROL_URL` 也要同步修改。缺少令牌时，Manager 不会启动该接口。

启用外部控制后，Manager 会同时启动受限的本地导入收件箱，以消费支付适配器提交的已规范化 OAuth 导入任务；不需要再单独打开 `codexAccounts.localImportInboxEnabled`。如果只使用旧的独立收件箱机器人而不启用外部控制，则仍需单独打开该设置。

当前回环接口为：`GET /healthz`、`GET /api/manager/status`、`GET /api/manager/accounts`、`GET /api/manager/usage/today`、`POST /api/manager/quotas/refresh`、`GET /api/manager/jobs/<uuid>`、`POST /api/manager/imports` 和 `GET /api/manager/imports/<uuid>`。除导入请求中的规范 OAuth 条目外，响应只包含脱敏账号/额度信息或计数；所有接口都需要 Bearer 令牌。

## 3. 配置并运行机器人

```dotenv
FEISHU_APP_ID=<new-feishu-app-id>
FEISHU_APP_SECRET=<new-feishu-app-secret>
FEISHU_ADMIN_OPEN_IDS=<admin-open-id-1,admin-open-id-2>

MANAGER_CONTROL_URL=http://127.0.0.1:43117
MANAGER_CONTROL_TOKEN=<same-local-private-token>
# 可选，范围 1000–120000，默认 10000
MANAGER_CONTROL_TIMEOUT_MS=10000

# 可选：配置后才启用“购买/支付”命令
FEISHU_ASSISTANT_PAYMENT_PROVIDER_MODULE=/absolute/path/to/payment-provider.mjs
# 可选：支付状态文件必须位于本机私有目录，默认使用 XDG state 目录
FEISHU_ASSISTANT_PAYMENT_STATE_PATH=/absolute/path/to/payments.json
# 可选，范围 3000–300000，默认 10000
FEISHU_ASSISTANT_PAYMENT_POLL_INTERVAL_MS=10000

# 可选：网页流程状态文件，默认使用 XDG state 目录
FEISHU_ASSISTANT_WEB_WORKFLOW_STATE_PATH=/absolute/path/to/web-workflows.json
# 可选：显式网站执行器模块；未配置时仍可分析和查询网页，但不会自动操作网站
FEISHU_ASSISTANT_WEB_EXECUTOR_MODULE=/absolute/path/to/site-executor.mjs
# 可选：启用网页智能抽取；未配置时使用本地 JSON-LD 分析器
FEISHU_ASSISTANT_OPENAI_API_KEY=<openai-api-key>
# 可选，默认 https://api.openai.com/v1
FEISHU_ASSISTANT_OPENAI_BASE_URL=https://api.openai.com/v1
# 可选，默认 gpt-5.6
FEISHU_ASSISTANT_WEB_MODEL=gpt-5.6
```

安装依赖并启动：

```bash
npm install
npm start
```

也可以将 `templates/feishu-assistant.service.template` 复制为用户级服务模板，在目标设备上填入 `PRIVATE_ENV_FILE`、`NODE_BIN` 和 `PACKAGE_ROOT`。该模板不会推断或复制已有服务配置。

## 4. 私聊命令

| 命令                     | 作用                                       |
| ------------------------ | ------------------------------------------ |
| `帮助`                   | 显示命令说明                               |
| `账号` / `状态`          | 查看账号、健康、额度池和今日用量           |
| `用量`                   | 查看今日 Token 总量及按模型统计            |
| `刷新额度`               | 刷新全部可刷新的真实账号额度               |
| `刷新额度 <账号 ID ...>` | 只刷新指定账号                             |
| `导入状态 <任务编号>`    | 查看 M+ 本地导入任务的脱敏状态             |
| `健康`                   | 检查 Manager 控制接口是否可达              |
| `购买 <商品编号>`        | 通过已配置的支付适配器创建订单并发送二维码 |
| `支付状态 [订单号]`      | 查询订单；机器人也会自动轮询活动订单       |
| `分析商品 <URL> [条件]`  | 分析商品页，按条件排序并保存网页步骤       |
| `网页流程 <URL>`         | 查询已保存的网页分析和使用指引             |

额度刷新会先返回任务编号，机器人随后轮询 Manager 的任务状态并发送最终结果；不会在飞书事件处理的首个响应中同步等待整批账号刷新。

## 5. 网页商品分析与流程复用

示例：

```text
分析商品 https://example.com/products free 已接码 有库存 最低价
网页流程 https://example.com/products
```

网页抓取只接受不带账号密码的 HTTPS 地址，并限制响应大小和等待时间。模型（如果配置了 `FEISHU_ASSISTANT_OPENAI_API_KEY`，否则使用本地 JSON-LD 分析器）只负责从页面文本中抽取商品、库存、价格、手机验证和使用步骤；本地代码再执行确定性的条件过滤和价格升序排序。页面内容被当作不可信数据，网页里的指令不能改变助手的权限，也不能让模型调用工具。

保存记录只包含脱敏后的商品、证据、步骤和警告，不保存 cookie、密码、Token、验证码或敏感填充值。状态文件所在目录为 0700，文件为 0600。网页步骤是可复用的分析结果，不等于已经登录或已经下单。

当前调查的 `https://riceai.cc/products/chatgpt-free-account` 会跳转到 `/lander`，返回 GoDaddy/ParkWeb 域名停放页（页面包含 `LANDER_SYSTEM="PW"`），因此助手会报告页面不可用，不会猜测商品接口、库存或使用指引，也不会对该站点硬编码接口。

如果页面依赖 JavaScript，结果会标记“可能需要浏览器渲染”。本阶段的抓取器不执行页面脚本；要真正点击、填写、提交或读取登录后的内容，必须配置一个明确的网站执行器模块。

执行器模块约定如下：

```js
export function createWebWorkflowExecutor({ env }) {
  return {
    async execute({ workflow, selected, order, payment, previousResult }) {
      // 这里使用站点专用、可审计的浏览器自动化实现。
      // payment.state 已由助手确认是 "paid"；不要从网页内容自行判定支付成功。
      return { state: "completed" };
    }
  };
}
```

`execute` 只会收到已保存的公开流程、选中的商品、脱敏订单/支付上下文和上次的有限结果。助手不会把账号令牌、密码或验证码传给通用网页分析器或保存层。执行器的站点登录凭据应由执行器自己通过受保护的运行环境管理。

## 6. 支付流程边界

支付功能采用本地适配器，不内置或猜测任何第三方网站接口。未设置 `FEISHU_ASSISTANT_PAYMENT_PROVIDER_MODULE` 时，机器人不会创建订单；设置后，模块必须导出 `createPaymentProvider({ manager, env, webWorkflow })`，并返回以下三个函数：

```js
export function createPaymentProvider({ manager, env, webWorkflow }) {
  return {
    async createOrder({ productId, quantity, idempotencyKey }) {
      return {
        orderId: "provider-order-id",
        productId,
        amountFen: 990,
        currency: "CNY",
        qr: { imageUrl: "https://payment.example/qr" },
        expiresAt: "2026-08-18T12:00:00.000Z"
      };
    },
    async getOrderStatus({ orderId }) {
      return { status: "pending" }; // 或 paid / failed / expired
    },
    async fulfillPaidOrder({ order, payment, idempotencyKey, previousResult }) {
      // 如需复用已保存网页流程，只能在这里（支付已确认后）调用：
      // return webWorkflow.executeAfterPayment({
      //   url: "https://example.com/products",
      //   order,
      //   payment,
      //   previousResult
      // });
      const queued = await manager.enqueueImport(/* 已获得且已规范化的 OAuth 账号数组 */);
      return { state: "pending", managerImportJobId: queued.id };
    }
  };
}
```

实际适配器需要自行向目标站点校验商品、金额、订单号、支付状态和幂等关系。`fulfillPaidOrder` 只有在 Manager 控制层已经确认支付状态为 `paid` 后才会被调用；它负责取得账号并调用 `manager.enqueueImport(accounts)`，随后通过 `manager.getImportStatus(jobId)` 继续查询导入结果。Manager 只接受 1–50 个包含 `email`、`tokens.id_token` 和 `tokens.access_token` 的规范 OAuth 条目，写入现有私有收件箱，机器人不会在回复中回显令牌。

工作流会把订单状态保存到本机 0600 文件，使用创建幂等键避免同一管理员并发下重复下单，并在 `pending` 或失败的后续流程中重试。二维码支持飞书已有 `imageKey`、Base64 图片、HTTPS 图片地址和文本内容；HTTPS 图片会先上传为飞书图片消息。状态文件只保存订单流程所需的信息，不应由适配器把账号令牌放入订单结果、日志或该文件。

通用支付工作流在远端状态明确为 `paid` 之前不会调用 `fulfillPaidOrder`；网页服务自身还会再次检查 `payment.state === "paid"`。未配置显式执行器时，支付适配器调用网页履约会得到明确错误，不会退化为猜测点击。

## 7. 开发验证

```bash
npm test
npm run package:check
```

本包的测试使用本地 fake Manager 客户端，不会连接真实飞书 App、Manager 或支付网站。
