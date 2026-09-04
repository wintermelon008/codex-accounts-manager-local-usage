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

Dashboard 顶部的“强制解锁 Codex 会话”按钮会先清理当前没有进程持有 `FLOCK` 的 UUID 会话锁，再定位持锁进程。属于其它 VS Code 窗口、且命令行确认为 Codex `app-server` 的持锁进程会被终止后重试解锁；当前窗口进程树、无法确认类型或无法终止的持锁进程会保留并在提示中报告。
