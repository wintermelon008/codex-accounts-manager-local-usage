# Repository instructions

## Version naming and local installation

- Follow the upstream extension's base version. For the current upstream `0.1.19`, the local versions use the same `0.1.19` base and add a local-build suffix.
- The development version is fixed at `<upstream-version>-dev`; for the current line this is `0.1.19-dev`. Development rebuilds and small edits do not increment the version.
- A stable local release uses `<upstream-version>-lN`, where `N` is the next sequential positive integer: `l1`, `l2`, `l3`, and so on. The current stable release is `0.1.19-l5`; `x` in the shorthand `-lx` is only a placeholder and must never be used literally as a release version.
- Before publishing a stable build, inspect the latest stable entry in `docs/CHANGELOG.md` and use the next unused `lN` number. Do not reuse an earlier number or switch to an unrelated suffix scheme.
- A release must keep these values synchronized: root `package.json` `version`/`displayName`, root `package-lock.json` package versions, the current `README` release references, the top `docs/CHANGELOG.md` heading, `announcements.json` `releaseVersion`/current announcement ID, and the VSIX filename.
- If a local build keeps the same version, overwrite the installed extension with `code --install-extension <path-to-vsix> --force`, then reload VS Code or reopen the Dashboard.
- Keep build timestamps or artifact uniqueness in the VSIX filename/output path rather than appending a per-build counter to the extension version.

## 测试数据隔离

测试必须清除真实存储环境变量（如 `CODEX_ACCOUNTS_PRIVATE_DIR`、`AIDECK_DATA_DIR`），仅使用独立临时目录；严禁读写真实数据库或项目 `private/`。
