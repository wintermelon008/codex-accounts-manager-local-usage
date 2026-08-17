# Codex Accounts Manager · Local Build

[简体中文](README.md) · English

A VS Code extension for managing multiple Codex accounts: add or import accounts, inspect quota, switch the active `auth.json`, and optionally use local usage analytics, experimental seamless switching, and local integrations.

> This is a local fork based on upstream `v0.1.16`. This guide describes builds with a `-local` version. The upstream Marketplace extension does not promise the local capabilities listed below.

## Start in three minutes

1. Install a `-local` `.vsix` supplied by, or built from, this repository.
2. Run `Codex Accounts: Add Account via OAuth`, or `Codex Accounts: Import Current auth.json`.
3. Run `Codex Accounts: Show Quota Summary` to refresh quota, switch accounts, and manage backups from the Dashboard.

On first launch, the extension can bind and refresh an existing local Codex `auth.json`. Account records and credentials remain on the current local/remote extension host; switching updates that host's active Codex `auth.json`.

## Features and prerequisites

This table applies only to local builds from this repository.

| Category               | Feature                                                                                                               | What is required                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ready after install    | Multi-account OAuth/import, quota cards, manual quota-countdown start, switching, details, backup/restore, status bar, and cross-window sync | Import an account. The starter appears only while a server-reported quota window has not started (for example, a five-hour, seven-day, or thirty-day window).                                                                                                    |
| Ready after install    | Local Codex token usage, six time categories, and multi-select Free/Plus/Pro filters                                 | Local sessions and imported accounts make the relevant views available. The usage view reads metadata only, never conversation bodies.                                                                                      |
| Opt-in settings        | Upstream Auto Switch, quota warnings, timed quota refresh, and Codex App restart                                      | Enable the relevant Dashboard setting. No automatic switch is enabled by default.                                                                                                                                           |
| One-time bundled setup | Experimental seamless switching and quota bands                                                                       | On Linux/macOS, run the install command, reload once, then prepare at least two fresh accounts and configure their pool. Windows is not supported yet.                                                                      |
| Optional package       | Feishu private-chat M+/S+ import                                                                                      | Install the restricted private-chat bot separately. M+ still requires the explicit Manager inbox setting; S+ is consumed only by a separately started importer.                                                               |
| Optional package       | Sub2API Gateway                                                                                                       | Install the standalone Gateway VSIX; it registers the downstream as a saved manual-only virtual account whose card owns configuration, key storage, refresh, usage, and estimated price. Core Manager never imports provider-side accounts or keys. |

## Experimental seamless switching

This is separate from upstream Auto Switch. It updates authentication at a safe boundary inside the same Codex app-server; successful switches do not require a reload and existing threads/history remain available.

1. Import and refresh at least two accounts you are authorized to use.
2. Run `Codex Accounts: Install Experimental Seamless Runtime`, then reload once.
3. Add accounts to the seamless pool from their cards; use hidden accounts, `A/B/C` groups, and plan filters to organize the visible scope.
4. Enable **Seamless account switching (experimental)**, then independently enable **Quota-band switching** and/or **Low-quota switching**. A one-minute quota refresh is recommended.
5. Choose a band size and wait time under **Quota-band switching**; choose **After exhaustion**, `1%`, `3%` (default), or `5%` under **Low-quota switching**; then choose the shared **Switch policy**.

When **Low-quota switching** is off, low quota, structured `usageLimitExceeded`, and exhaustion batches cannot start a new automatic switch; quota-band switching remains independent. **After exhaustion** waits within one band until every conversation in the active batch actually stops for quota exhaustion, for up to 6 hours. For `Selected model is at capacity. Please try a different model.`, the runtime waits one minute per thread and sends `Continue.`; a seamless account switch claims any still-waiting capacity recovery first. Auto-continuation can still repeat non-idempotent external effects. See [the seamless-switch guide](docs/HOT_SWITCH.md) for full rules.

The local usage panel shows at most eight rows: `24h` uses eight 3-hour buckets, `3d` merges four 3-hour buckets into each of six half-day buckets, and `7d`, `14d`, `7w`, and `7m` use seven daily, grouped-daily, weekly, or calendar-month buckets. The Settings overlay supports multiple enabled categories; clearing all categories falls back to `24h`. Range changes project cached data locally and do not rescan sessions.

## Optional local integrations

- [Feishu private-chat M+/S+ import package](docs/integrations/feishu-private-import.md): accepts only administrator one-to-one text messages. M+ writes to Manager's explicit local inbox; S+ writes only to a separate private queue.
- [Standalone Sub2API Gateway and S+ importer](docs/integrations/sub2api-gateway.md): the Gateway VSIX, administrative importer, and core Manager install and stop independently; the Gateway appears as a manual-only saved virtual account with card-local actions and tracker usage, but never becomes an OAuth account or normal pool member.
- [BugTeam one-hour account integration](docs/integrations/bugteam.md): a standalone VSIX shows balance, products, current pickup shelves, and explicit purchase/reservation actions; completed Sub2 JSON is imported and eligible accounts are enabled in the seamless pool without switching the current account.

## Install and update

### Use the local build

Obtain `codex-accounts-manager-<version>.vsix` from this repository (`0.1.16-dev` for development, then `0.1.16-l1`, `0.1.16-l2`, and so on for distributed local releases), then use **Extensions: Install from VSIX…** in the target VS Code window, or run:

```bash
code --install-extension codex-accounts-manager-<version>.vsix --force
```

Local capabilities ship with that VSIX. If you deliberately install a Marketplace update, reinstall a local build afterward.

### Build from source

```bash
git clone https://github.com/wintermelon008/codex-accounts-manager-local-usage.git
cd codex-accounts-manager-local-usage
npm ci
npm run package
```

`npm run package` runs the portability audit, compiles the extension, and produces a `.vsix`. The detailed documentation is bundled in the VSIX, so the relative links in this README work after installation.

Optional components are built separately:

```bash
npm --prefix integrations/feishu-private-import run package
npm --prefix integrations/sub2api-gateway run package
npm --prefix integrations/mailbox run package
npm --prefix integrations/bugteam run package
npm --prefix integrations/sub2api-importer run package
```

Optional packages are not bundled in the core VSIX. Build and configure `integrations/feishu-private-import`, `integrations/sub2api-gateway`, `integrations/mailbox`, `integrations/bugteam`, or `integrations/sub2api-importer` from their own READMEs; none copies existing services, credentials, accounts, or machine paths automatically.

### Use the upstream Marketplace build

If you only need upstream core account management, search the Extensions view for **Codex Accounts Manager** from publisher `wannanbigpig`. It is released independently from this fork; do not assume it includes local usage analytics, the Feishu inbox, the Sub2API Gateway, or local seamless-switch enhancements.

## Documentation index

- [Seamless switching, quota bands, and thresholds](docs/HOT_SWITCH.md)
- [Standalone Sub2API Gateway, S+ importer, and migration](docs/integrations/sub2api-gateway.md)
- [Feishu private-chat M+/S+ importer](docs/integrations/feishu-private-import.md)
- [BugTeam one-hour account integration](docs/integrations/bugteam.md)
- [Independent delivery, disablement, and migration](docs/integrations/README.md)
- [Core local text import inbox](docs/LOCAL_IMPORT_INBOX.md)
- [Changelog](docs/CHANGELOG.md)

Frequently used commands: `Add Account via OAuth`, `Import Current auth.json`, `Show Quota Summary`, `Refresh All Quotas`, and `Install/Remove Experimental Seamless Runtime`. Other actions are available from the Dashboard or Command Palette.

## Feedback and license

- This fork: <https://github.com/wintermelon008/codex-accounts-manager-local-usage>
- Upstream project: <https://github.com/wannanbigpig/codex-tools>
- License: [MIT](LICENSE)
