# SessionHub

Manager 默认开启 SessionHub，把普通会话、Supergoal、Loop-goal、Feishu 引用和 Codex `thread_id` 关联到同一份 Vserver registry。

Manager 激活时优先使用进程环境中的 `CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN`；若 Extension Host 没有继承该环境变量，会读取用户级配置文件 `~/.config/codex-accounts-manager/manager-control.env`。该文件只应由当前用户读写。

registry 路径为：

```text
~/.local/state/codex-accounts-manager/session-registry.json
```

查询：

```bash
npm run session-hub -- list --project lowbitwidth
npm run session-hub -- locate --value <goal-id-or-thread-id>
npm run session-hub -- show --conversation <conversation-id>
```

登记：

```bash
npm run session-hub -- register \
  --kind loop-goal \
  --project lowbitwidth \
  --goal <goal-id> \
  --run <run-id> \
  --thread <native-thread-id> \
  --artifact <artifact-locator>
```

Goal 产物继续保存在既定的 `melon-codex` 目录；registry 只保存会话定位信息。Feishu 只登记外部引用，不维护第二份 transcript。

Dashboard 顶部的“解锁失效 Codex 会话”按钮只清理当前没有进程持有 `FLOCK` 的 UUID 会话锁。仍被活跃 Codex writer 占用的锁会保留并在提示中报告，不会为了恢复界面强制终止进程；网络断开后应先等待旧 Remote Extension Host 退出，或显式结束确认过的旧 Codex 进程后再重试。
