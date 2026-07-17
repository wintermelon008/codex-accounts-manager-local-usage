# Codex Accounts Manager

English · [简体中文](README.md)

VS Code extension for managing multiple Codex accounts, viewing quota usage, and switching the active global `auth.json`.

![Version](https://img.shields.io/badge/version-0.1.16-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.96.0-007acc)
![License](https://img.shields.io/github/license/wannanbigpig/codex-tools)
![Stars](https://img.shields.io/github/stars/wannanbigpig/codex-tools?style=flat)
![Last Commit](https://img.shields.io/github/last-commit/wannanbigpig/codex-tools)

---

Manage multiple Codex accounts inside VS Code, inspect quota usage, switch the active global account, and monitor key quota data from the status bar.

**Features:** quota dashboard, multi-account management, OAuth sign-in, first-run local account detection and binding, immediate quota refresh after import, cross-window account sync, Codex App auto-restart, status bar monitoring, details panel, multilingual UI, and extension-level language override.

**Language:** follows the current VS Code display language. Primary support is for Simplified Chinese and English, with additional localization for other languages.

---

## Preview

| Quota Dashboard                                                                                                                                   | Details Panel                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/dashboard.png" alt="Codex Tools quota dashboard" width="420" /> | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/detail.png" alt="Codex Tools details panel" width="420" />  |
| Settings Panel                                                                                                                                    | Status Bar                                                                                                                                    |
| <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/setting.png" alt="Codex Tools settings panel" width="260" />    | <img src="https://raw.githubusercontent.com/wannanbigpig/codex-tools/master/media/status_bar.png" alt="Codex Tools status bar" width="220" /> |

---

## Overview

### Quota Dashboard

The extension provides a Webview dashboard for managing and monitoring all saved Codex accounts in one place:

- Current account summary with team info and quick actions
- Quota gauges for 5-hour, weekly, and code review usage
- Saved accounts list for multi-account management
- Quick actions for add, import, and refresh-all

### Multi-Account Management

- Add a new account through OAuth
- Detect an existing local Codex `auth.json` when no account has been saved yet
- Bind the detected local account into the extension with one click
- Import the currently active local Codex `auth.json`
- Refresh quota immediately after local bind or import
- Store multiple accounts locally
- Switch the active account with one click
- Remove accounts you no longer use

### Cross-Window Sync

- Watch global `auth.json` changes
- Automatically sync the active account when another VS Code window switches accounts
- Prompt the current window to reload when an external account switch is detected

### Codex App Integration

- Detect whether Codex App is installed when switching accounts
- Automatically restart Codex App if it is already running
- Skip restart if the desktop app is installed but not currently running
- Currently supports common macOS, Windows, and Linux install/process patterns

### Experimental Seamless Switching and Quota Balancing

- Upstream `Auto Switch` keeps its original thresholds, candidate selection, and reload behavior. All local additions—configurable quota bands, the account pool, no-reload execution, and conversation recovery—live under the separate `Seamless account switching (experimental)` group
- A separate Seamless Switching master toggle restores the original persisted-account and reload workflow when off without uninstalling the runtime, so turning it back on does not require reinstalling the shim
- Seamless quota-band scheduling does not depend on upstream `Auto Switch` or `5-hour quota control`; while enabled it uses its own fail-closed path and never falls back to a persisted-only account change
- Use the switch at the lower-left of each account card to control its five-hour seamless-switch pool membership, or update several accounts with the batch actions. A pool with at least two members supports `1/5 (20%)`, `1/4 (25%)`, `1/3 (33%)`, or `1/2 (50%)` bands when the active account has a usable 5-hour window and candidates also have usable 5-hour and weekly windows with more than `3%` weekly quota
- Optionally enable the 1% emergency switch. At 1% or lower of a usable 5-hour or weekly window it bypasses the initial baseline and grace period, interrupts active turns, and switches only to a safe pool account above `3%` weekly quota. A weekly emergency prioritizes weekly quota; a candidate that reports a 5-hour window must also be above 1%, while a weekly-only account can participate in this path. If a turn already stopped with structured `usageLimitExceeded`, including a structured `turn/start` RPC rejection, the runtime also recovers that recent thread after switching. It is off by default because non-idempotent effects can repeat
- When the active account drops a band, give running Codex turns a 60-second natural-completion grace period before hot-switching the same app-server
- Pause active persisted Goals, interrupt an old Goal turn that outlives the grace period, and resume the Goal after switching while preserving the thread's workspace, sandbox, and approval settings
- For ordinary turns, choose between deferring the switch, interrupting for manual continuation, or an experimental same-thread automatic `Continue`; automatic continuation cannot guarantee exactly-once non-idempotent external effects
- The shim never directly sends `Continue` to multi-agent subagents; their parent agent and conversation orchestration decide whether to schedule further work after a switch
- Keep the ordinary-turn policy and grace controls visible; when hot switching is enabled but its runtime is not ready, fail closed instead of reporting a persisted-only account change as a successful live switch
- Queue new turns behind the switch barrier while preserving the existing conversation/thread state
- Keep one process-wide account active at a time; this does not assign different accounts to simultaneous turns
- Run `Codex Accounts: Install Experimental Seamless Runtime` and reload once for initial setup; on Remote-SSH, WSL, or Dev Containers the manager generates and copies the current user's local User setting, so release instructions never rely on a hard-coded home path
- The installed runtime disables Responses WebSocket reuse so an existing thread's next turn actually uses the newly selected account. Disabling the Seamless Switching master toggle restores the original switch/reload logic; removing the runtime and reloading also restores the official transport
- See [docs/HOT_SWITCH.md](docs/HOT_SWITCH.md) for exact scheduling, compatibility, security, and rollback details

#### Enable and configure

1. Import at least two Codex accounts that you are authorized to use, then run **Refresh All Quotas** once.
2. Run `Codex Accounts: Install Experimental Seamless Runtime` from the Command Palette. Reload once when prompted after the initial installation; later successful switches do not require reloads.
3. On Remote-SSH, WSL, or Dev Containers, paste the generated `chatgpt.cliExecutable` entry into the opened local User Settings JSON. Do not copy an absolute path from another machine and do not put it in Remote Settings.
4. Use the switch at the lower-left of each account card to add at least two accounts to the pool, or select several accounts and use the batch action. Ordinary five-hour band candidates need usable 5-hour and weekly windows with more than `3%` weekly quota; a weekly-only account skips ordinary bands but can participate in a 1% weekly emergency switch.
5. In dashboard settings, enable **Seamless account switching (experimental)** and **Seamless quota-band balancing**, choose a band size (default `1/5 (20%)`), then set automatic quota refresh to `1–5` minutes.
6. Choose a grace period and ordinary-turn policy. Enable the separate **1% emergency forced switch** only when avoiding quota exhaustion outweighs the risk of repeated non-idempotent effects.

Example user-facing configuration:

```json
{
  "codexAccounts.seamlessSwitchEnabled": true,
  "codexAccounts.seamlessSwitchQuotaBandsEnabled": true,
  "codexAccounts.seamlessSwitchQuotaBandSize": 20,
  "codexAccounts.seamlessSwitchEmergencySwitchEnabled": false,
  "codexAccounts.autoRefreshMinutes": 5,
  "codexAccounts.hotSwitchGraceSeconds": 60,
  "codexAccounts.hotSwitchLongTurnPolicy": "defer"
}
```

The install/remove commands manage `codexAccounts.hotSwitchEnabled`, the runtime shim, and `chatgpt.cliExecutable`. Do not install the runtime by changing only the technical flag, and never commit a machine-generated CLI path. Seamless quota-band scheduling does not require upstream **Auto Switch** or **5-hour Quota Control**.

#### What to expect

- An idle manual switch updates authentication in the same Codex app-server. Existing conversations and threads remain intact, with no reload prompt.
- A running turn first receives the configured natural-completion grace period. `defer` safely postpones an ordinary-turn switch; `interruptAndContinue` interrupts the old turn and starts one recovery-marked `Continue` in the same thread after switching.
- Multi-agent subagents do not receive a shim-injected `Continue`, so Codex's parent-agent orchestration remains responsible for their follow-up work.
- An active Goal is paused first. If its turn outlives the grace period, the runtime can interrupt it and then restore the same Goal, workspace, sandbox, and approval state after switching.
- When automatic refresh observes the active account crossing down a configured five-hour quota band, the scheduler selects a fresh, eligible pool account only when its five-hour quota is strictly higher and its weekly quota is above `3%`. If the active account is already the highest, it keeps consuming without a switch. Changing the size establishes a fresh baseline.
- With the 1% emergency setting enabled, even a first observation at 1% of a usable five-hour or weekly window can trigger. Active turns are interrupted; ordinary threads that just stopped on quota exhaustion receive one recovery-marked `Continue` after switching, while persistent Goals use pause/resume semantics and a `usageLimited` Goal is explicitly reactivated. A weekly emergency prioritizes candidates with higher weekly quota and never selects one at or below `3%` weekly quota, preventing a high five-hour value from selecting a weekly-exhausted account; a weekly-only account can use this path as well. Both terminal notifications and structured `turn/start` quota rejections are recognized. Recent-failure records expire after two minutes and a newer turn on the same thread clears them, so they do not become a persistent stopped state. If no eligible account remains, the old account stays active and a later refresh retries.
- The runtime forces the next turn to use the new HTTP credentials instead of reusing an old authenticated WebSocket. Identity, runtime, or rollback failures fail closed and keep or restore the previous account rather than reporting a persisted-only change as success.
- The dashboard and status bar show the new active account. Authentication is still process-wide; accounts are not bound independently per conversation.
- Turning off **Seamless account switching (experimental)** restores the original persisted-account/reload workflow while keeping the runtime installed. Run `Codex Accounts: Remove Experimental Seamless Runtime` and reload once to restore the official transport as well.

### Quota Visibility

Each account can show:

- 5-hour quota percentage
- Weekly quota percentage
- Code review quota percentage
- Reset countdown
- Last refresh time

### Status Bar Monitoring

- Show the current account quota summary in the VS Code status bar
- Pin selected accounts from the dashboard into status visibility
- Click the status bar entry to open the full quota dashboard

### Multilingual UI

- Automatically follows the current VS Code display language
- Primary support for Simplified Chinese and English, with additional localization for other languages
- Dashboard copy, prompts, and interaction text switch with the editor language
- You can also force this extension to use Simplified Chinese, English, or another supported language without changing the rest of VS Code

### Details Panel

Open a per-account details panel to inspect:

- Account email
- Team / organization information
- User ID / account ID
- Raw quota payload

---

## Settings

You can change these directly from the settings button in the top-right corner of the dashboard, or from VS Code Settings by searching for `codexAccounts`.

- `Language`
  - `Auto (follow VS Code)`, `Simplified Chinese`, `English`, and other supported languages
  - Only affects Codex Accounts Manager dashboard copy and prompt text
- `Codex App Restart Policy`
  - Disabled by default
  - When enabled, choose:
  - `Restart automatically`: restart Codex App on account switch if it is already running
  - `Ask every time`: let you confirm each restart manually
- `Automatic Quota Refresh`
  - Can be disabled, or set to `5 / 10 / 15 / 30 / 60` minutes
  - Disabled by default
  - When disabled, no timed refresh runs
- `5-hour Quota Control`
  - Disabled by default; the 5-hour quota remains visible while disabled
  - Controls whether a valid 5-hour quota can trigger automatic switching or quota warnings
- `Automatic Account Switching`
  - Disabled by default
  - When enabled, set separate thresholds for `5-hour` and `weekly` quota
  - After refresh, the extension can switch to another saved account when the active one hits a threshold
  - The 5-hour threshold only applies while `5-hour Quota Control` is enabled; the weekly threshold remains independent
  - Optional quota-band balancing supports 20%, 25%, 33%, and 50% bands and requires at least two enabled account-card pool switches
  - An optional 1% emergency switch interrupts active turns and recovers recently quota-exhausted threads on an eligible account
  - Use a `1 ~ 5` minute automatic refresh interval so every candidate has fresh quota data
- `Codex App Launch Path`
  - Optional custom desktop app path
  - Leave empty to use auto-detection
- `Dashboard Display`
  - Choose whether to show the `Code Review` quota
- `Quota Warning`
  - Enable or disable low-quota alerts
  - Disabled by default
  - When enabled, choose a threshold from `5%` to `90%`
  - After refresh, the extension shows a localized warning when the active account drops below the configured threshold
  - Only quota windows returned by the API are checked; while 5-hour control is disabled, only the weekly quota is checked

---

## Usage

1. Install the extension
2. On first launch, if a local Codex `auth.json` already exists, the extension can bind it and refresh quota immediately
3. Run `Codex Accounts: Add Account via OAuth`
4. Or run `Codex Accounts: Import Current auth.json`
5. Run `Codex Accounts: Show Quota Summary`
6. Refresh quotas, switch accounts, inspect details, and manage status bar visibility from the dashboard

---

## Commands

Available commands in the VS Code Command Palette:

- `Codex Accounts: Add Account via OAuth`
- `Codex Accounts: Install Experimental Seamless Runtime`
- `Codex Accounts: Remove Experimental Seamless Runtime`
- `Codex Accounts: Import Current auth.json`
- `Codex Accounts: Switch Account`
- `Codex Accounts: Refresh Quota`
- `Codex Accounts: Refresh All Quotas`
- `Codex Accounts: Remove Account`
- `Codex Accounts: Open Details`
- `Codex Accounts: Show Quota Summary`

---

## Installation

The extension is now available on the VS Code Marketplace, and you can still install it from a `.vsix` package or run it from source.

### Option 1: Install from the Marketplace

1. Open the Extensions view in VS Code
2. Search for `Codex Accounts Manager`
3. Find the extension published by `wannanbigpig` and click Install

You can also open the Marketplace page directly:

[Codex Accounts Manager - Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=wannanbigpig.codex-accounts-manager)

### Option 2: Install from VSIX

1. Download the released `.vsix` file
2. Open the Command Palette in VS Code
3. Run `Extensions: Install from VSIX...`
4. Select the downloaded `.vsix` file

Or install from the command line:

```bash
code --install-extension codex-accounts-manager-x.y.z.vsix
```

### Option 3: Run from Source

```bash
git clone https://github.com/wannanbigpig/codex-tools.git
cd codex-tools
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

---

## Package VSIX

```bash
npx @vscode/vsce package
```

---

## Notes

- Account data is stored locally
- Switching accounts updates the machine-wide active Codex `auth.json`
- Quota is refreshed immediately after local account bind/import
- External account changes from another window are detected automatically
- Codex App restart only happens when the desktop app is already running
- Quota visibility depends on the data returned by the current Codex session

---

## Support

- ⭐ [GitHub Star](https://github.com/wannanbigpig/codex-tools)
- 💬 [Report Issues](https://github.com/wannanbigpig/codex-tools/issues)

---

## 💝 Support The Project

Thanks for using `Codex Accounts Manager`.

If this project helps you, you can support its ongoing development and maintenance.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Support-orange?style=for-the-badge&logo=buy-me-a-coffee)](https://github.com/wannanbigpig/codex-tools/blob/master/docs/DONATE.en.md)

---

## License

This project is open-sourced under the [MIT License](LICENSE).
