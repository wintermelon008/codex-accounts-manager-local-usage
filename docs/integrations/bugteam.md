# BugTeam 可选集成

`integrations/bugteam` 是 Manager 的独立可选 VSIX。安装后，Manager Dashboard 顶端会显示 BugTeam 小按钮；点击后打开扩展自己的二级 Webview 面板。

面板只提供用户触发的购买入口：显示 BugTeam 可用余额、动态识别的 1h 商品、当前发车货架和库存报价。货架档位来自 `/api/customer/inventory/shelves`；选中有库存的档位可直接购买，不选档则创建新鲜候补订单。候补订单状态在后台持续轮询，订单创建使用持久化 `Idempotency-Key`，网络超时后复用同一个键。订单完成后扩展下载 `format=sub2`，将顶层 `accounts[]` 转成 Manager Shared JSON，再调用 Manager 的受限导入能力。

面板右上角「刷新」会同步余额、商品、货架和订单状态，并在同步完成、选档购买或候补订单创建后通过面板右下角 Toast 给出反馈。选档下单向 `/api/customer/pickup/orders` 增加 `expiry_bucket_start`；新鲜候补不携带该字段。

Manager 对导入账号执行以下流程：先隔离到非池状态，再刷新真实额度；只有 `getBalanceQuotaCapability(account) !== "unknown"` 的账号才设置为无感池成员。该流程不会修改当前 `auth.json`，用户仍然手动切换账号。

BugTeam Token 存储在 BugTeam 扩展自己的 VS Code `SecretStorage`。输入框提交后立即清空；Token 不会进入 Dashboard snapshot、订单持久化状态、日志或公开仓库。BugTeam 官方更推荐服务端保存 Token，因此不要把个人 Token 分发给其他设备或提交到配置文件。

## 安装与验证

```sh
npm --prefix integrations/bugteam test
npm --prefix integrations/bugteam run package:check
npm --prefix integrations/bugteam run package
```

安装 `integrations/bugteam/dist/codex-accounts-bugteam.vsix` 后，需要同时安装兼容版本的 Codex Accounts Manager。BugTeam 扩展不读取 Manager 私有存储，也不直接导入 Manager 数据库；若 Manager 没有受限导入能力，扩展会停止激活并提示升级。
