# Repository instructions

## Version naming and local installation

- Follow the upstream extension's base version. For the current upstream `0.1.21`, the local versions use the same `0.1.21` base and add a local-build suffix.
- The development version is fixed at `<upstream-version>-dev`; for the current line this is `0.1.21-dev`. Development rebuilds and small edits do not increment the version.
- A stable local release uses `<upstream-version>-lN`, where `N` is the next sequential positive integer: `l1`, `l2`, `l3`, and so on. The current stable release is `0.1.21-l7`; `x` in the shorthand `-lx` is only a placeholder and must never be used literally as a release version.
- Before publishing a stable build, inspect the latest stable entry in `docs/CHANGELOG.md` and use the next unused `lN` number. Do not reuse an earlier number or switch to an unrelated suffix scheme.
- A release must keep these values synchronized: root `package.json` `version`/`displayName`, root `package-lock.json` package versions, the current `README` release references, the top `docs/CHANGELOG.md` heading, `announcements.json` `releaseVersion`/current announcement ID, and the VSIX filename.
- Every dev or stable update must preserve the extension ID `wintermelon.codex-account-manager`: keep root `package.json` `publisher` as `wintermelon` and `name` as `codex-account-manager`; never change them to the upstream extension identity `wannanbigpig.codex-accounts-manager`.
- If a local build keeps the same version, overwrite the installed extension with `code --install-extension <path-to-vsix> --force`. Do not reload VS Code or reopen the Dashboard automatically; only do so when the current user request explicitly authorizes it.
- Keep build timestamps or artifact uniqueness in the VSIX filename/output path rather than appending a per-build counter to the extension version.

## VS Code / Remote-SSH 操作授权

- 未经当前用户请求明确授权，不得自动启动、重连、重启或关闭 VS Code、Remote-SSH、VS Code Server、Extension Host、Codex app-server、Manager daemon、SSH 会话或任何新窗口。
- 不得调用 `workbench.action.reloadWindow`、`scripts/reload-manager-extension-host.sh`、终止 Extension Host 后等待其拉起，或使用会隐式创建新 VS Code/Remote-SSH 连接的 CLI 操作。
- 打包、安装扩展、修改代码或检查状态时，默认保持现有窗口、连接和进程不变。若验证确实需要 reload、重启、关闭或新连接，必须先停止并向用户请求明确授权；只做静态检查、日志检查和现有进程的只读健康检查。

## 测试数据隔离

测试必须清除真实存储环境变量（如 `CODEX_ACCOUNTS_PRIVATE_DIR`、`AIDECK_DATA_DIR`），仅使用独立临时目录；严禁读写真实数据库或项目 `private/`。
