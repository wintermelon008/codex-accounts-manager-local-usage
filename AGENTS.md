# Repository instructions

## Versioning and local installation

- Use `0.1.19-dev` for local development. Small edits and rebuilds do not increment the version.
- Use `0.1.19-l4` for the current distributed local release build. Increment the `lN` suffix only when publishing a later local release build.
- Keep the root `package.json` version and the root `package-lock.json` package versions synchronized.
- If a local build keeps the same version, overwrite the installed extension with `code --install-extension <path-to-vsix> --force`, then reload VS Code or reopen the Dashboard.
- Keep build timestamps or artifact uniqueness in the VSIX filename/output path rather than appending a per-build counter to the extension version.

## 测试数据隔离

测试必须清除真实存储环境变量（如 `CODEX_ACCOUNTS_PRIVATE_DIR`、`AIDECK_DATA_DIR`），仅使用独立临时目录；严禁读写真实数据库或项目 `private/`。
