# Repository instructions

## Versioning and local installation

- Use `0.1.16-dev` for local development. Small edits and rebuilds do not increment the version.
- Use `0.1.16-l1`, `0.1.16-l2`, `0.1.16-l3`, and so on for distributed local release builds. Increment the `lN` suffix only when publishing a release build.
- Keep the root `package.json` version and the root `package-lock.json` package versions synchronized.
- If a local build keeps the same version, overwrite the installed extension with `code --install-extension <path-to-vsix> --force`, then reload VS Code or reopen the Dashboard.
- Keep build timestamps or artifact uniqueness in the VSIX filename/output path rather than appending a per-build counter to the extension version.
