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
- Quick actions for add, import, and refreshing the currently displayed page (up to 50 accounts)

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

- Detect shared account revisions through file watching plus a two-second stat fallback, including Remote-SSH hosts where watcher events can be delayed or dropped
- Merge account-index and token updates atomically under short shared leases so concurrent Mac/Windows/remote extension hosts do not overwrite one another
- Deduplicate background quota and token sweeps with expiring shared leases while keeping manual refresh available
- Converge every live app-server to the selected account at its next safe switching boundary; only the original workflow prompts for reload when Seamless Switching is off

### Codex App Integration

- Detect whether Codex App is installed when switching accounts
- Automatically restart Codex App if it is already running
- Skip restart if the desktop app is installed but not currently running
- Currently supports common macOS, Windows, and Linux install/process patterns

### Experimental Seamless Switching and Quota Balancing

- Upstream `Auto Switch` keeps its original thresholds, candidate selection, and reload behavior. All local additions—configurable quota bands, the account pool, no-reload execution, and conversation recovery—live under the separate `Seamless account switching (experimental)` group
- A separate Seamless Switching master toggle restores the original persisted-account and reload workflow when off without uninstalling the runtime, so turning it back on does not require reinstalling the shim
- Seamless quota-band scheduling does not depend on upstream `Auto Switch` or `5-hour quota control`; while enabled it uses its own fail-closed path and never falls back to a persisted-only account change
- Use the switch at the lower-left of each account card to control pool membership, or update several accounts with the batch actions. Ordinary scheduling classifies accounts by capability: `windowed` has usable five-hour and long-term windows, `reserve` explicitly has no five-hour window but has a usable long-term window, and `unknown` is excluded because data is missing, stale, or erroneous. Plan labels such as Free or Plus are never used to guess ordinary capability
- Select cards from their upper-left controls to hide or unhide them in bulk. A successful hide clears only the corresponding card selections. Hidden accounts are purple, omitted from the default list, removed from the seamless pool immediately, and excluded from both automatic and manual switching. Unhiding restores pool membership; the eye button reveals hidden cards
- The Saved Accounts header also has **Hide weekly <3%**. It targets only currently displayed, non-hidden accounts with a recognized weekly quota strictly below `3%`; accounts without a weekly window are left unchanged
- The same header has **Unhide weekly >90%**. It checks every hidden account regardless of the current group filter, restores only accounts with a recognized weekly quota strictly above `90%`, returns them to the seamless pool, and clears their `A/B/C` group; normal bulk unhide still preserves the group
- Assign selected accounts to groups `A`, `B`, or `C`; each card shows its group. The `A/B/C` buttons above Saved Accounts decide which groups are displayed and eligible for seamless scheduling. Ungrouped, non-hidden accounts always remain displayed and eligible. Turning a group off excludes only its targets from seamless band, Free-1%, and reserve selection; it does not affect manual switching or upstream Auto Switch. An already active account in a disabled group is not forced away, but its next automatic rotation can only target the currently displayed scope
- Saved accounts are paged at 50 cards. Hide/unhide and group-display changes repaginate immediately, and an out-of-range page is clamped back to a valid page.
- The Dashboard **Refresh current page** button refreshes only that displayed page. Per-card refresh, explicitly selected batch refresh, and the explicit Command Palette full refresh retain their explicit target scope.
- Timed quota refresh also processes only the first page of non-hidden accounts in enabled groups (at most 50 accounts). Other accounts remain manual-refresh only.
- A verified Free account with a usable five-hour window never participates in ordinary `20%/25%/33%/50%` bands or the `1%/2%/3%` reserve threshold. It moves only at 1% or a runtime hard-stop signal when Free exhaustion protection is enabled
- Choose `1/5 (20%)`, `1/4 (25%)`, `1/3 (33%)`, or `1/2 (50%)` bands and a `1%`, `2%`, or `3%` reserve threshold (default `3%`). The scheduler rotates eligible windowed accounts first; only after all of them reach the threshold does it select the reserve account with the most long-term quota. A reserve account stays active until its long-term quota reaches the threshold, then selection starts with recovered windowed accounts before another reserve account
- Optionally enable **1% exhaustion protection (Free first)**. At 1% or lower of a usable five-hour or long-term window it bypasses the initial baseline and grace period, interrupts active turns, and auto-continues. When a verified Free account reaches its five-hour floor, it first chooses the fresh Free pool member with the highest five-hour quota and long-term quota above the reserve threshold; if none is eligible, it returns to normal mixed safe selection. A structured `usageLimitExceeded`, including a `turn/start` RPC rejection, is detected through bounded runtime scalars without loading conversation content or history. It is off by default because non-idempotent effects can repeat
- When the active account drops a band, give running Codex turns a 60-second natural-completion grace period before hot-switching the same app-server
- Pause active persisted Goals, interrupt an old Goal turn that outlives the grace period, and resume the Goal after switching while preserving the thread's workspace, sandbox, and approval settings
- For ordinary turns, choose between deferring the switch, interrupting for manual continuation, or an experimental same-thread automatic `Continue`; automatic continuation cannot guarantee exactly-once non-idempotent external effects
- The shim never directly sends `Continue` to multi-agent subagents; their parent agent and conversation orchestration decide whether to schedule further work after a switch
- Keep the ordinary-turn policy and grace controls visible; when hot switching is enabled but its runtime is not ready, fail closed instead of reporting a persisted-only account change as a successful live switch
- Queue new turns behind the switch barrier while preserving the existing conversation/thread state
- Keep one process-wide account active at a time; this does not assign different accounts to simultaneous turns
- Run `Codex Accounts: Install Experimental Seamless Runtime` and reload once for initial setup; on Remote-SSH, WSL, or Dev Containers the manager keeps a reversible backup beside the remote bundled Codex CLI and links it to the shim instead of changing the local VS Code `chatgpt.cliExecutable` setting
- The installed runtime disables Responses WebSocket reuse so an existing thread's next turn actually uses the newly selected account. Disabling the Seamless Switching master toggle restores the original switch/reload logic; removing the runtime and reloading also restores the official transport
- The runtime expands official history requests that explicitly target the current provider to all providers, so local sessions from before and after runtime installation share one history list. It changes only the `thread/list` filter and does not rewrite session files or the state database
- After all managed accounts have been removed, the first seamless switch to a newly imported account uses the currently valid `auth.json` as an in-memory rollback snapshot and validates it against the live app-server identity. A failed switch restores that identity without requiring the master toggle to be disabled first
- Local usage analytics advance a cumulative high-water mark per rollout, ignore repeated or stale `token_count` reports, and treat parent history copied into spawned subagents only as an initial baseline. They adopt a newer shared cache by `calculatedAt`, and the dashboard refreshes at `nextRefreshAt`; the aggregate cache contains statistics only, never conversation text, account identifiers, credentials, or session paths
- The installed seamless runtime batches a tiny local attribution record when a managed turn starts. It contains only an opaque local account ID, thread ID, and timestamp—never prompts, conversation text, email, remote account IDs, or credentials. Account cards reuse the existing 15-minute session scan to aggregate the already-present `token_count` metadata into the current five-hour quota window (or long-term/weekly window when no five-hour window exists). When the runtime returns only one `primary` window, its actual `window_minutes` classifies it as short- or long-term, so a Plus-style long window is not mistaken for a five-hour window. There is no per-token IPC, extra network request, or second body scan. Counters start with the first managed turn and do not backfill history; after a quota reset changes, the old bucket no longer matches and the card shows zero while waiting for a new managed turn.
- See [docs/HOT_SWITCH.md](docs/HOT_SWITCH.md) for exact scheduling, compatibility, security, and rollback details

#### Enable and configure

1. Import at least two Codex accounts that you are authorized to use, then run **Refresh All Quotas** once.
2. Run `Codex Accounts: Install Experimental Seamless Runtime` from the Command Palette. Reload once when prompted after the initial installation; later successful switches do not require reloads.
3. On Remote-SSH, WSL, or Dev Containers, leave `chatgpt.cliExecutable` unset. It is an application-scoped development setting in the official extension and can override Codex across windows/devices. The install command backs up the remote bundled CLI and creates a reversible shim link in the remote extension directory. Remove any manually added value from every local User Settings JSON and from Remote Settings before installing.
4. Use the switch at the lower-left of each account card to add at least two accounts to the pool, or select several accounts and use the batch action. The same selection can assign `A/B/C` groups or remove a group; the group buttons above Saved Accounts set the visible seamless-candidate scope, while ungrouped non-hidden accounts always remain in it. Every automatic candidate needs a fresh, usable long-term window; an account with a five-hour window is treated as windowed, one that explicitly has no five-hour window is treated as reserve, and missing/stale/error data is excluded.
5. In dashboard settings, enable **Seamless account switching (experimental)** and **Seamless quota-band balancing**, choose a band size (default `1/5 (20%)`) and reserve threshold (`1%`, `2%`, or `3%`; default `3%`), then set automatic quota refresh to `1` minute.
6. Choose a grace period and ordinary-turn policy. Enable **1% exhaustion protection (Free first)** only when preventing a Free five-hour hard stop outweighs the risk of repeated non-idempotent effects.

Example user-facing configuration:

```json
{
  "codexAccounts.seamlessSwitchEnabled": true,
  "codexAccounts.seamlessSwitchQuotaBandsEnabled": true,
  "codexAccounts.seamlessSwitchQuotaBandSize": 20,
  "codexAccounts.seamlessSwitchReserveThreshold": 3,
  "codexAccounts.seamlessSwitchEmergencySwitchEnabled": false,
  "codexAccounts.autoRefreshMinutes": 1,
  "codexAccounts.hotSwitchGraceSeconds": 60,
  "codexAccounts.hotSwitchLongTurnPolicy": "defer"
}
```

The install/remove commands manage `codexAccounts.hotSwitchEnabled` and the runtime shim. Local windows still manage `chatgpt.cliExecutable`; Remote-SSH, WSL, and Dev Containers manage a reversible shim link around the remote bundled CLI. Do not install the runtime by changing only the technical flag, and do not retain a cross-device `chatgpt.cliExecutable` path. Seamless quota-band scheduling does not require upstream **Auto Switch** or **5-hour Quota Control**.

#### What to expect

- An idle manual switch updates authentication in the same Codex app-server. Existing conversations and threads remain intact, with no reload prompt.
- A running turn first receives the configured natural-completion grace period. `defer` safely postpones an ordinary-turn switch; `interruptAndContinue` interrupts the old turn and starts one recovery-marked `Continue` in the same thread after switching.
- Multi-agent subagents do not receive a shim-injected `Continue`, so Codex's parent-agent orchestration remains responsible for their follow-up work.
- An active Goal is paused first. If its turn outlives the grace period, the runtime can interrupt it and then restore the same Goal, workspace, sandbox, and approval state after switching.
- When automatic refresh observes a windowed account crossing down a configured five-hour band, the scheduler first selects a fresh windowed account whose five-hour quota is strictly higher and whose long-term quota is above the reserve threshold. It uses the highest-long-term-quota reserve account only after all usable windowed accounts reach the threshold. If the active account remains the best candidate, it keeps consuming; changing the band size establishes a fresh baseline.
- A reserve account remains active while its long-term quota is above the reserve threshold. At the threshold, the scheduler first tries any recovered windowed account above it, otherwise the reserve account with the most remaining long-term quota. Manual switching is unaffected by this automatic ordering.
- With **1% exhaustion protection (Free first)** enabled, even a first observation at 1% of a usable five-hour or long-term window can trigger. Active turns are interrupted; ordinary threads that just stopped on quota exhaustion receive one recovery-marked `Continue` after switching, while persistent Goals use pause/resume semantics and a `usageLimited` Goal is explicitly reactivated. A verified Free account at its five-hour floor first selects a Free pool peer with fresh (at most two-minute-old) quota, the highest five-hour percentage, and long-term quota above the reserve threshold; if none remains, normal mixed selection applies. Both terminal notifications and structured `turn/start` quota rejections are recognized through a fixed-size runtime status poll. Recent-failure records expire after two minutes and a newer turn on the same thread clears them, so they do not become a persistent stopped state. If no eligible account remains, the old account stays active and a later refresh retries.
- The runtime forces the next turn to use the new HTTP credentials instead of reusing an old authenticated WebSocket. Identity, runtime, or rollback failures fail closed and keep or restore the previous account rather than reporting a persisted-only change as success.
- Codex history includes both pre-runtime `openai` sessions and sessions recorded under the seamless HTTP provider. Opening an older thread still resumes it with the current seamless provider, without migrating local history.
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
  - Can be disabled, or set to any whole-minute interval from `1` to `60`
  - Disabled by default
  - When enabled, refreshes only the first page of non-hidden accounts in enabled groups (at most 50); other accounts stay manual-refresh only
- `5-hour Quota Control`
  - Disabled by default; the 5-hour quota remains visible while disabled
  - Controls whether a valid 5-hour quota can trigger automatic switching or quota warnings
- `Automatic Account Switching`
  - Disabled by default
  - When enabled, set separate thresholds for `5-hour` and `weekly` quota
  - After refresh, the extension can switch to another saved account when the active one hits a threshold
  - The 5-hour threshold only applies while `5-hour Quota Control` is enabled; the weekly threshold remains independent
- `Seamless account switching (experimental)`
  - Its master toggle restores the original account-switch/reload workflow when off while retaining an installed runtime
  - Independent quota-band balancing supports 20%, 25%, 33%, and 50% bands without enabling upstream automatic switching or 5-hour quota control
  - A 1%, 2%, or 3% reserve threshold keeps windowed accounts first, then selects the reserve account with the most long-term quota
  - Ordinary capability comes only from fresh quota windows; only the optional Free hard-stop path also verifies a Free plan label; missing, stale, or erroneous data is excluded from automatic selection
  - Optional **1% exhaustion protection (Free first)** sends a Free five-hour hard stop to the safe Free pool peer with the most five-hour quota, then falls back to mixed selection and recovers recently quota-exhausted threads
  - Each account card and the batch actions can add or remove accounts from the pool
  - Upper-left card selection also supports bulk hide/unhide; hidden accounts leave the pool, cannot be switched to, and return to the pool only after being unhidden
  - Configure the safe grace period and ordinary-turn recovery policy, and use a `1` minute automatic refresh interval with Free exhaustion protection so candidates remain fresh
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
