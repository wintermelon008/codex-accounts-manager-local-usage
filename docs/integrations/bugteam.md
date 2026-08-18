# BugTeam 可选集成

`integrations/bugteam` 是 Manager 的独立可选 VSIX。安装后，Manager Dashboard 顶端会显示 BugTeam 小按钮；点击后打开扩展自己的二级 Webview 面板。面板以一张卡片维护一个服务来源，来源各自保存连接配置、库存和订单状态，但交付后统一调用 Manager 的受限无感池导入能力。异步按钮通过独立动作回执显示进行中、成功或失败，不再由后台状态推送提前结束按钮反馈。

## BugTeam 官方 API

面板只提供用户触发的购买入口：显示 BugTeam 可用余额、动态识别的 1h 商品、当前发车货架和库存报价。货架档位来自 `/api/customer/inventory/shelves`；选中有库存的档位可直接购买，不选档则创建新鲜候补订单。候补订单状态在后台持续轮询，订单创建使用持久化 `Idempotency-Key`，网络超时后复用同一个键。订单完成后扩展下载 `format=sub2`，将顶层 `accounts[]` 转成 Manager Shared JSON，再调用 Manager 的受限导入能力。只要导入或无感池启用未全部成功，完成订单仍按 30 秒节流保留后台重试；重启扩展会从持久化订单恢复轮询和导入警告，全部账号入池后才关闭订单处理。

面板右上角「刷新」会同步余额、商品、货架和订单状态，并在同步完成、选档购买或候补订单创建后通过面板右下角 Toast 给出反馈。选档下单向 `/api/customer/pickup/orders` 增加 `expiry_bucket_start`；新鲜候补不携带该字段。

Manager 对导入账号执行以下流程：先隔离到非池状态，再刷新真实额度；只有 `getBalanceQuotaCapability(account) !== "unknown"` 的账号才设置为无感池成员。该流程不会修改当前 `auth.json`，用户仍然手动切换账号。

BugTeam Token 存储在 BugTeam 扩展自己的 VS Code `SecretStorage`。输入框提交后立即清空；Token 不会进入 Dashboard snapshot、订单持久化状态、日志或公开仓库。BugTeam 官方更推荐服务端保存 Token，因此不要把个人 Token 分发给其他设备或提交到配置文件。

## 超级炸弹车来源

`https://tingbai.top/bugteam/` 的网页前端调用同源 `/bugteam-api/store` 接口：公开商品目录位于 `GET /catalog`，买家登录建立 HttpOnly Cookie 会话并返回 CSRF Token；余额、订单、订单状态和 `format=sub2` 下载都要求该买家会话。扩展不抓取 HTML，也不模拟点击，而是复用网页本身的 JSON 请求契约。

买家账号和密码只存入 BugTeam 扩展的 VS Code `SecretStorage`，不进入 Webview 状态、日志、订单记录或 Manager 公共 API。用户必须在来源卡片中明确点击“开始候补”；点击后立即持久化候补任务，即使目录当前为空、无货或一次刷新失败也会保持运行并等待下一轮。候补固定购买 `1` 个，金额下限和上限可以分别留空，两者都不填时不限制金额。后台按 `3` 秒基础间隔加 `0–1` 秒随机偏移读取公开目录；面板在请求期间显示“正在刷新库存”，请求间隔内显示下一轮刷新倒计时。目录读取若遇一次瞬时网络失败会安全重试一次；连续失败显示明确的网络错误，且不会把未启动状态和历史订单混为一谈。发现库存后先获取实时 quote；总价需同时满足可选的 `>= 下限` 与 `<= 上限`，等于边界时允许下单。价格不匹配时跳过本次库存并继续候补，余额不足时暂停，只有范围和余额检查都通过才进入自动扣款边界。

本地候补跟随来源目录中当前可购买的商品，不把启动时的无货商品编码当作长期锁定条件；补货时新增或切换商品编码仍会进入报价和下单。失败、退款或取消的历史订单允许重新启动候补，进行中、结果不确定或完成但尚未全部入池的订单仍阻止创建第二笔任务。面板所有按钮提供按压反馈，异步按钮使用独立动作回执显示进行中、成功或失败，货架档位用选中态确认本地选择。

目录的 `purchasable` 与 quote 的 `can_buy` 按网站前端契约作为权威可购买信号；库存数量字段短暂为 `0` 或缺失时不会再被扩展额外过滤，最终由实时 quote 和下单接口确认库存。

自动购买在发请求前持久化同一个 `Idempotency-Key`、商品、数量和预期金额。网络结果不确定或扩展重启后只复用原请求，避免重复扣款。取得订单号后停止候补并轮询订单；完成后下载 Sub2，调用与官方来源共用的规范化和 Manager 入池函数。购买记录最多保留最近 `20` 条非凭据状态，包含订单号、库存检测时间、成交金额、导入结果和下单时的“预计炸车时间”。该字段按网站前端的 `supply.refreshed_at + minimum_remaining_seconds` 计算；`departure_time` 为空时也能与网站倒计时保持一致。

Manager 的受限导入结果还会返回每个账号的脱敏额度摘要。面板统一展示账号邮箱或内部标识、套餐、5h/周剩余百分比、Credits 余额和无感池启用状态，不返回或显示 OAuth Token。额度刷新失败时对应账号明确显示失败状态，不把旧额度当作本次余额。

## 安装与验证

```sh
npm --prefix integrations/bugteam test
npm --prefix integrations/bugteam run package:check
npm --prefix integrations/bugteam run package
```

安装 `integrations/bugteam/dist/codex-accounts-bugteam.vsix` 后，需要同时安装兼容版本的 Codex Accounts Manager。BugTeam 扩展不读取 Manager 私有存储，也不直接导入 Manager 数据库；若 Manager 没有受限导入能力，扩展会停止激活并提示升级。
