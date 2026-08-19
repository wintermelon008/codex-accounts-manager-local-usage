# Codex Accounts BugTeam

这是一个可选的 VS Code 伴随扩展。安装后，Manager Dashboard 顶端会出现 BugTeam 小按钮，独立面板按卡片维护不同服务来源；每个来源独立配置和购入，交付结果统一调用 Manager 的受限无感池导入能力。

订单完成后，扩展下载 Sub2 JSON，提取账号并调用 Manager 的受限导入能力。Manager 会先导入并刷新真实额度，只有额度能力可验证的账号才加入无感账号池；面板的“已购账号额度”区域会逐个显示脱敏邮箱、套餐、5h/周额度、Credits 余额和入池状态。扩展不会自动修改当前 `auth.json`，切换仍由用户手动完成。

## BugTeam 官方 API

1. 在 BugTeam 网页的 API 页面创建长期 `cfk_` 客户 Token。
2. 在 BugTeam 面板中粘贴 Token 并保存。Token 只持久化到本扩展自己的 VS Code `SecretStorage`；输入框提交后立即清空，不会进入 Dashboard 状态、日志或仓库。
3. 确认余额和 1h 商品报价后，点击「购买并导入无感池」。

面板中的「当前发车」会同步 BugTeam 货架档位。选择仍有库存的档位后点击「选择档位立即购买」会按该档的 `expiry_bucket_start` 下单；不选档点击「下候补订单」则进入新鲜候补队列。右上角「刷新」会手动同步余额、商品、货架和订单状态，创建成功或同步完成会在面板右下角短暂提示。

Token 仍由本地扩展直接访问 BugTeam API；BugTeam 官方更推荐由服务端持有 Token，因此不要在共享机器、公开配置或客户端分发包中复用个人 Token。

## 超级炸弹车

`https://tingbai.top/bugteam/` 没有公开 API 文档，但网页前端使用同源 `/bugteam-api/store` 接口。商品目录可匿名读取；买家余额、下单、订单状态和 Sub2 下载由 HttpOnly Cookie 会话与 CSRF Token 保护。

在“超级炸弹车”来源卡片中保存买家账号和密码后，凭据只进入本扩展的 VS Code `SecretStorage`，不会进入 Webview 状态、日志或 Manager API。所有按钮都有按压状态；异步操作继续显示进行中、成功或失败，货架选择显示明确的“已选择”。点击“开始候补”会立即持久化一笔固定购买 `1` 个的本地候补任务，即使当前无货、目录暂时为空或一次目录刷新失败也会继续后台轮询；金额下限和上限可以分别留空，两者都不填时不限制金额。扩展按 `3` 秒基础间隔加 `0–1` 秒随机偏移读取公开目录，面板在每轮检查期间显示“正在刷新库存”，其余时间实时显示下一次刷新倒计时。公开目录若遇一次瞬时网络失败会自动重试一次；连续失败会显示明确的网络错误，但不会把“候补未启动”误判为历史候补仍在运行。发现库存后获取实时 quote，只有总价满足可选的 `>= 下限` 和 `<= 上限` 且余额足够时才自动下单。价格不匹配时跳过本次库存并继续候补，余额不足时暂停。

候补针对当前来源的可售商品，而不是永久锁定启动时无货目录中的商品编码；若补货时目录新增或切换到另一个有货商品，扩展会跟随实时商品下单。失败、退款或取消的历史订单不会阻止重新设置金额范围并启动新候补；仍在处理或结果未确认的订单继续保持互斥，已完成但等待账号导入的订单不再阻塞候补。

目录的 `purchasable` 和报价的 `can_buy` 是网站的可购买权威信号；即使库存数量字段短暂为 `0` 或缺失，只要网站明确返回可购买，扩展仍会获取实时报价并尝试下单。

自动下单前会持久化 `Idempotency-Key`。网络结果不确定或扩展重启后只复用同一个请求键，不创建第二笔扣款请求。订单完成后下载 `format=sub2` 并进入与官方来源相同的 Manager 导入流程。购买记录保留订单号、检测时间、金额、导入结果和下单时观测到的“预计炸车时间”；该时间遵循网站前端算法，以 `supply.refreshed_at + minimum_remaining_seconds` 计算并在下单时固化。

## BugTeam 官方 API 与订单行为

- 商品不会硬编码为网页示例中的 `oauth_30d`；扩展读取 BugTeam Dashboard 商品目录，并选择 `billing_base_seconds` 约为 3600 秒的商品。
- 货架读取 `GET /api/customer/inventory/shelves?product=...`；每个 `buckets[]` 按 `bucket_start` 作为发车档位标识，并展示未售、已售、发车时间和当前单价。
- 选档购买和新鲜候补都使用 `POST /api/customer/pickup/orders`；选档购买额外携带 `expiry_bucket_start`。
- 下单前查询余额和库存报价；余额不足时不会创建订单。
- 创建订单使用持久化 `Idempotency-Key`。网络超时后重试会复用原键，避免重复扣款。
- 候补订单会在后台轮询；补货后系统自动发货，扩展下载 `format=sub2` 并导入 Manager。每次导入前会按规范化邮箱查询 Manager，已存在的账号会直接跳过，不会重复写入或重新启用无感池。账号写入成功后即停止自动导入重试；额度刷新或无感池启用失败仍保留面板警告和手动重试入口，但不会阻塞后续候补。
- 订单和导入结果只保存脱敏状态、订单号和计数，不保存账号 Token。
- 面板提供「清除本地 Token」；进行中的订单或结果待确认时会禁止清除，避免中断轮询或丢失幂等重试能力。

## 开发与打包

```sh
npm --prefix integrations/bugteam test
npm --prefix integrations/bugteam run package:check
npm --prefix integrations/bugteam run package
```

然后在 VS Code 使用 **Extensions: Install from VSIX…** 安装 `dist/codex-accounts-bugteam.vsix`。Manager 未安装或版本未提供受限导入能力时，BugTeam 扩展不会尝试写入账号库。
