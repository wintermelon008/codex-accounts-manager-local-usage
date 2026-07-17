# Local extension customizations

This fork is pinned to upstream `v0.1.16` / commit `4b1689deafd2d303700c5cc26e6fd285979634e4` and packages as `0.1.16-local.18`.

## Scope

- Adds a read-only local Codex token summary below Saved Accounts. The dashboard and Settings window offer `24h`, `7d`, and `14d` views. The `24h` view is rendered as eight three-hour rows.
- Aggregates model, daily, three-hour, input, output, cached-input, and total-token metadata from `$CODEX_HOME/sessions` (default `~/.codex/sessions`).
- Does not read or send session text, account identities, auth data, or raw paths to the Dashboard Webview.
- Persists only sanitized aggregates in VS Code global storage and scans at most once every 15 minutes. Opening the Dashboard inside that window does not trigger another scan.
- The scanner retains a sanitized 14-day daily aggregate and a matching rolling 24-hour aggregate. The selected range filters this cached data locally, so usage rows, model distribution, totals, and event count always use the same range and range changes do not rescan files.
- Shows an optional estimated standard OpenAI API price in USD between total and input tokens, and alongside each usage bar as `Token (US$price)`. Unknown models stay in range totals but are omitted from the model-distribution list. It is an informational estimate only, not a Codex subscription bill.
- The fail-closed usage compatibility check accepts the current aggregate `local-enhancements` manifest and the legacy `local-usage-dashboard` manifest; a reviewed aggregate build must not hide the usage block solely because the manifest scope expanded.

The displayed values are local session observations, not ChatGPT account quota or billing data.

## Experimental account hot switch

- Adds a bundled local CLI shim that proxies the official Codex app-server over stdio; it is not a resident HTTP service.
- Forces Responses HTTP streaming inside the installed runtime because Codex `0.144.2` caches an authenticated WebSocket per loaded thread. This ensures the next turn on the same thread resolves the newly selected account instead of continuing to bill the old WebSocket identity.
- Adds an explicit multi-account seamless-switch pool with selectable 20%, 25%, 33%, or 50% bands for valid five-hour remaining quota. A candidate must be strictly higher than the active account, so an already-highest active account keeps consuming; accounts that only report a weekly window are excluded. Its configuration, scheduler state, and fail-closed execution are independent of upstream Auto Switch.
- Adds an opt-in 1% emergency path that bypasses the normal baseline and grace period, excludes candidates at or below 1%, and uses immediate interrupt-and-Continue semantics while still waiting for all old turns to terminate before changing authentication. Terminal `error` notifications and structured `turn/start` RPC rejections carrying `usageLimitExceeded`, plus compatible failed-turn payloads, are retained briefly so already-stopped ordinary threads can receive one continuation; persistent Goals are paused/resumed and `usageLimited` Goals are explicitly reactivated after the switch. Newer work and the two-minute TTL suppress stale recovery. Non-sensitive runtime counters expose observed failures and successful ordinary/Goal recoveries for live diagnostics.
- Gives active turns a configurable 60-second grace period, queues new turn starts, and never changes authentication while an old turn remains active.
- Pauses active persisted Goals, interrupts an over-grace Goal turn, and restores the Goal after success, rollback, cancellation, or manager disconnect without changing thread-sticky workspace and permission settings.
- Offers opt-in ordinary-turn interruption and one-shot same-thread continuation; the default safely defers the switch and retries on a later quota refresh.
- Keeps a bounded terminal-turn ledger so late `turn/start` responses cannot resurrect completed turns, reconciles explicit already-inactive interrupt results, and retries deferred cross-window convergence after the safe boundary.
- Adds a user-facing Seamless Switching master toggle. Turning it off restores the original persisted-account/reload workflow without uninstalling the runtime; the quota-band scheduler, ordinary-turn policy, and Goal recovery remain child settings of this mode.
- Adds a per-account pool switch at the lower-left of every saved-account card plus explicit Set Pool and Remove from Pool batch actions; a pool with fewer than two members is valid and simply leaves band scheduling inactive.
- Generates the exact local User `chatgpt.cliExecutable` setting for Remote-SSH, WSL, and Dev Container hosts instead of publishing a user-specific absolute path. The enable/disable prompts copy the value and open User Settings.
- Treats either a successful `initialize` response or the client's `initialized` notification as a usable app-server handshake. If hot switching is enabled but the runtime bridge is not ready, switching fails closed and does not fall back to rewriting persisted auth.
- Keeps the existing reload behavior only when the experimental feature is disabled. A failed or deferred in-flight transaction leaves the persisted account unchanged instead of writing new auth while a turn is active.
- Never writes credentials into the shim configuration or logs. Runtime IPC is scoped to the current extension-host PID and local user.
- Separates the stable account-record email from the access-token runtime email reported by Codex. A runtime alias is accepted only after the access token's user ID matches the managed account, so legitimate alias drift does not trigger rollback without weakening fail-closed identity checks.
- Adds a credential-free `verify:seamless-auth` check that starts a selected real Codex binary with synthetic accounts and proves an A-to-B auth change on the same thread. This must be rerun after a Codex protocol/runtime upgrade.

See [HOT_SWITCH.md](HOT_SWITCH.md) for setup, exact scheduling rules, concurrency semantics, compatibility limits, and rollback.

## Equivalent API price

The default bundled rate table uses the standard API input / cached-input / output USD prices documented for [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), and [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5). Cached input is estimated separately; the scanner does not expose enough information to price cache writes. Unknown models are excluded and flagged in the price-card subtitle.

The estimate deliberately excludes tool fees, long-context premiums, cache writes, taxes, exchange rates, and any subscription-specific pricing. Review and update the bundled table whenever API pricing changes.

## Dashboard settings

The existing Dashboard Settings window has a **Local Usage Dashboard** section with a persisted default range and a **Show Estimated API Price** toggle. The corresponding VS Code configuration keys are:

```json
"codexAccounts.localUsageDefaultRange": "7d",
"codexAccounts.localUsageShowEquivalentPrice": true
```

Changing these values changes presentation only. It never changes saved accounts, quota refreshes, or the 15-minute local scanning schedule.

## Update safety

Never patch a Marketplace installation in place. Install the generated VSIX and disable automatic updates for this extension.

## Installation

After `npm run package` produces a VSIX, use **Extensions: Install from VSIX…** in the VS Code window connected to the target Remote-SSH/WSL/Container host. This project is intended for the remote extension host that stores the existing extension under `~/.vscode-server/extensions`.

Set the following in the target user's VS Code settings, or disable Auto Update on this extension from the Extensions view:

```json
"extensions.autoUpdate": false,
"extensions.autoCheckUpdates": false
```

When a Marketplace update is deliberately installed, this local feature is not reattached automatically. The stock extension runs without the local usage block until a newly reviewed VSIX is built and installed.

Before taking a newer upstream version:

1. Fetch the candidate source and ask Codex to review its diff against the pinned baseline.
2. Reapply/review this customization and update `local-customization.json` only after the review.
3. Update the reviewed SHA-256 values, run `npm run verify:customization`, tests, and package a new VSIX.

`npm run package` is intentionally fail-closed. It refuses to package if any changed file falls outside the reviewed list or if any protected file no longer matches its reviewed SHA-256 value.
