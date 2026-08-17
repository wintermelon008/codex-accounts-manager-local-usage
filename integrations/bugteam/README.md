# Codex Accounts BugTeam

这是一个可选的 VS Code 伴随扩展。安装后，Manager Dashboard 顶端会出现 BugTeam 小按钮，打开独立面板后可以查看 BugTeam 余额、1h 商品和当前发车货架，并在用户明确点击后选档购买或创建一笔候补订单。

订单完成后，扩展下载 Sub2 JSON，提取账号并调用 Manager 的受限导入能力。Manager 会先导入并刷新真实额度，只有额度能力可验证的账号才加入无感账号池；扩展不会自动修改当前 `auth.json`，切换仍由用户手动完成。

## 配置

1. 在 BugTeam 网页的 API 页面创建长期 `cfk_` 客户 Token。
2. 在 BugTeam 面板中粘贴 Token 并保存。Token 只持久化到本扩展自己的 VS Code `SecretStorage`；输入框提交后立即清空，不会进入 Dashboard 状态、日志或仓库。
3. 确认余额和 1h 商品报价后，点击「购买并导入无感池」。

面板中的「当前发车」会同步 BugTeam 货架档位。选择仍有库存的档位后点击「选择档位立即购买」会按该档的 `expiry_bucket_start` 下单；不选档点击「下候补订单」则进入新鲜候补队列。右上角「刷新」会手动同步余额、商品、货架和订单状态，创建成功或同步完成会在面板右下角短暂提示。

Token 仍由本地扩展直接访问 BugTeam API；BugTeam 官方更推荐由服务端持有 Token，因此不要在共享机器、公开配置或客户端分发包中复用个人 Token。

## API 与订单行为

- 商品不会硬编码为网页示例中的 `oauth_30d`；扩展读取 BugTeam Dashboard 商品目录，并选择 `billing_base_seconds` 约为 3600 秒的商品。
- 货架读取 `GET /api/customer/inventory/shelves?product=...`；每个 `buckets[]` 按 `bucket_start` 作为发车档位标识，并展示未售、已售、发车时间和当前单价。
- 选档购买和新鲜候补都使用 `POST /api/customer/pickup/orders`；选档购买额外携带 `expiry_bucket_start`。
- 下单前查询余额和库存报价；余额不足时不会创建订单。
- 创建订单使用持久化 `Idempotency-Key`。网络超时后重试会复用原键，避免重复扣款。
- 候补订单会在后台轮询；补货后系统自动发货，扩展下载 `format=sub2` 并导入 Manager。
- 订单和导入结果只保存脱敏状态、订单号和计数，不保存账号 Token。
- 面板提供「清除本地 Token」；进行中的订单或结果待确认时会禁止清除，避免中断轮询或丢失幂等重试能力。

## 开发与打包

```sh
npm --prefix integrations/bugteam test
npm --prefix integrations/bugteam run package:check
npm --prefix integrations/bugteam run package
```

然后在 VS Code 使用 **Extensions: Install from VSIX…** 安装 `dist/codex-accounts-bugteam.vsix`。Manager 未安装或版本未提供受限导入能力时，BugTeam 扩展不会尝试写入账号库。
