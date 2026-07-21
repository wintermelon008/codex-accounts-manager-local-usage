# Local extension customizations

This fork is pinned to upstream `v0.1.16` / commit `4b1689deafd2d303700c5cc26e6fd285979634e4` and packages as `0.1.16-local.27`.

## Scope

- Adds a read-only local Codex token summary below Saved Accounts. The dashboard and Settings window offer `24h`, `7d`, and `14d` views. The `24h` view is rendered as eight three-hour rows.
- Aggregates model, daily, three-hour, input, output, cached-input, and total-token metadata from `$CODEX_HOME/sessions` (default `~/.codex/sessions`).
- Does not read or send session text, account identities, auth data, or raw paths to the Dashboard Webview.
- Persists only sanitized aggregates in VS Code global storage and scans at most once every 15 minutes. Before streaming files, the scanner excludes session files whose mtime is safely outside the retained window; while streaming, it parses only `session_meta`, `turn_context`, `token_count`, and inter-agent turn-boundary metadata instead of allocating object graphs for conversation and tool-output records. Token events advance a per-rollout cumulative high-water mark, so repeated/stale reports are ignored. Spawned subagent rollouts use the copied parent history only as their initial baseline and begin contributing after their own trigger-turn boundary. Each host adopts a strictly newer shared result by `calculatedAt`, the Dashboard refreshes at `nextRefreshAt`, and an expiring scan lease deduplicates work across extension hosts.
- The scanner retains a sanitized 14-day daily aggregate and a matching rolling 24-hour aggregate. The selected range filters this cached data locally, so usage rows, model distribution, totals, and event count always use the same range and range changes do not rescan files.
- Shows an optional estimated standard OpenAI API price in USD between total and input tokens, and alongside each usage bar as `Token (US$price)`. Unknown models stay in range totals but are omitted from the model-distribution list. It is an informational estimate only, not a Codex subscription bill.
- The fail-closed usage compatibility check accepts the current aggregate `local-enhancements` manifest and the legacy `local-usage-dashboard` manifest; a reviewed aggregate build must not hide the usage block solely because the manifest scope expanded.

The displayed values are local session observations, not ChatGPT account quota or billing data.

## Experimental account hot switch

- Adds a bundled local CLI shim that proxies the official Codex app-server over stdio; it is not a resident HTTP service.
- Forces Responses HTTP streaming inside the installed runtime because Codex `0.144.2` caches an authenticated WebSocket per loaded thread. This ensures the next turn on the same thread resolves the newly selected account instead of continuing to bill the old WebSocket identity.
- Merges the official current-provider `thread/list` view across provider IDs without rewriting local history, so sessions created before and after the HTTP provider was introduced remain visible together while the runtime is installed.
- Adds an explicit multi-account seamless-switch pool with selectable 20%, 25%, 33%, or 50% bands and a 1%, 2%, or 3% reserve threshold. Fresh quota payloads, not Free/Plus plan labels, classify ordinary scheduling as `windowed` (usable five-hour and long-term windows), `reserve` (explicitly no five-hour window and a usable long-term window), or `unknown` (missing, stale, or erroneous data). Ordinary scheduling rotates windowed accounts first and moves to the highest-long-term-quota reserve account only when all usable windowed accounts reach the threshold. A reserve account remains active above the threshold, then selection starts with recovered windowed accounts before another reserve account. Manual switching is unchanged. This configuration, scheduler state, and fail-closed execution are independent of upstream Auto Switch.
- Adds opt-in **1% exhaustion protection (Free first)** for usable five-hour or long-term quota. It bypasses the normal baseline and grace period. When a source is both a verified Free plan and valid `windowed` account at the five-hour floor, it first selects a Free peer refreshed within two minutes with the highest five-hour quota and long-term quota above the reserve threshold; no eligible Free peer falls back to the normal mixed selector. It uses immediate interrupt-and-Continue semantics while still waiting for all old turns to terminate before changing authentication. Terminal `error` notifications and structured `turn/start` RPC rejections carrying `usageLimitExceeded`, plus compatible failed-turn payloads, are retained briefly so already-stopped ordinary threads can receive one continuation; persistent Goals are paused/resumed and `usageLimited` Goals are explicitly reactivated after the switch. Newer work and the two-minute TTL suppress stale recovery. The extension-host monitor is enabled only with this protection, performs a two-second poll of bounded scalar runtime status, retains no thread IDs/text/history, serializes requests, retries a deferred selection after ten seconds, and backs off an unavailable status RPC for thirty seconds. Non-sensitive runtime counters expose observed failures and successful ordinary/Goal recoveries for live diagnostics.
- Gives active turns a configurable 60-second grace period, queues new turn starts, and never changes authentication while an old turn remains active.
- Pauses active persisted Goals, interrupts an over-grace Goal turn, and restores the Goal after success, rollback, cancellation, or manager disconnect without changing thread-sticky workspace and permission settings.
- Offers opt-in ordinary-turn interruption and one-shot same-thread continuation; the default safely defers the switch and retries on a later quota refresh.
- Leaves multi-agent subagent recovery to its parent agent. Before a one-shot continuation, the shim reads only thread metadata; a thread with a parent or subagent source is not given a direct `turn/start`, because current app-server rejects direct input to those threads.
- Keeps a bounded terminal-turn ledger so late `turn/start` responses cannot resurrect completed turns. If app-server reports that a tracked turn ID has been replaced by a newer active turn in the same thread, the shim resynchronizes that exact ID and retries the interrupt once; explicit already-inactive results are also reconciled. It only auto-continues after the replacement turn confirms `interrupted`, and retries deferred cross-window convergence after the safe boundary.
- Adds a user-facing Seamless Switching master toggle. Turning it off restores the original persisted-account/reload workflow without uninstalling the runtime; the quota-band scheduler, ordinary-turn policy, and Goal recovery remain child settings of this mode.
- Adds a per-account pool switch at the lower-left of every saved-account card plus explicit Set Pool and Remove from Pool batch actions; a pool with fewer than two members is valid and simply leaves band scheduling inactive.
- On Remote-SSH, WSL, and Dev Container hosts, avoids `chatgpt.cliExecutable` entirely. The install command refuses to proceed while that application-scoped setting remains, then saves the remote bundled CLI as a same-directory backup and replaces its path with a reversible link to the manager launcher. This keeps one client machine's local path from overriding Codex on another client connected to the same host.
- Treats either a successful `initialize` response or the client's `initialized` notification as a usable app-server handshake. If hot switching is enabled but the runtime bridge is not ready, switching fails closed and does not fall back to rewriting persisted auth.
- Keeps the existing reload behavior only when the experimental feature is disabled. A failed or deferred in-flight transaction leaves the persisted account unchanged instead of writing new auth while a turn is active.
- Supports a safe first seamless switch after every managed account has been deleted. Runtime protocol v3 captures the currently valid `auth.json` only as an in-memory rollback snapshot, confirms its identity against the live app-server, and restores it if the target switch fails; the old identity is not silently imported into the account list.
- Never writes credentials into the shim configuration or logs. Runtime IPC is scoped to the current extension-host PID and local user.
- Separates the stable account-record email from the access-token runtime email reported by Codex. A runtime alias is accepted only after the access token's user ID matches the managed account, so legitimate alias drift does not trigger rollback without weakening fail-closed identity checks.
- Adds a credential-free `verify:seamless-auth` check that starts a selected real Codex binary with synthetic accounts and proves an A-to-B auth change on the same thread. This must be rerun after a Codex protocol/runtime upgrade.

See [HOT_SWITCH.md](HOT_SWITCH.md) for setup, exact scheduling rules, concurrency semantics, compatibility limits, and rollback.

## Cross-host coordination

- Account index, token mirror, and quota-mirror writes use unique temporary files, atomic replacement, expiring shared leases, and three-way account merges. Concurrent Mac, Windows, and remote extension hosts cannot overwrite a newly imported/deleted account merely by flushing an older in-memory snapshot.
- File watching is backed by a two-second stat/revision poll so Remote-SSH and network-filesystem hosts still observe changes when an event is delayed or dropped.
- Background token refresh, quota scanning, and seamless scheduling use separate expiring leases. Another host can reap a lease after its owner exits, while an explicit manual refresh remains available.
- Each app-server keeps its own turn barrier and converges to the shared active account at a safe boundary. This is deliberate eventual convergence, not a cross-process atomic switch; an already-running turn can finish with its original account.
- Shared local-usage caches contain aggregate statistics and timing metadata only. They never include conversation text, account IDs, credentials, or full session paths.

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

Seamless scheduling additionally exposes `codexAccounts.seamlessSwitchReserveThreshold` with allowed values `1`, `2`, and `3` (default `3`). It appears only inside the Seamless Switching settings group and does not alter upstream Auto Switch thresholds.

## Update safety

Never edit a Marketplace extension's source or bundle in place. Install the generated VSIX and disable automatic updates for this extension. The remote seamless-runtime command is a deliberately narrow, reversible exception: it renames only the remote bundled Codex executable to a same-directory backup and makes the original executable path a launcher symlink. Removing the runtime restores that backup only if the link still belongs to this manager; it never replaces another tool's link.

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

The development toolchain keeps ESLint 8 for the repository's `.eslintrc.json` configuration and pins VSCE 2.32 with a compatible Cheerio release so the documented package command also runs in the current Node 18 release shell. These are development-only dependencies; the generated extension runtime does not ship them.

The build pins `@vscode/vsce` to `2.32.0` and Cheerio to `1.0.0`, so packaging remains reproducible on the repository host's Node `18.19+` runtime. Re-evaluate these pins together when the build environment moves to Node 20 or newer.

When a reviewed customization intentionally removes an upstream file, record it in `removedFiles` in `local-customization.json`. The baseline check then requires that file to remain absent; it does not silently accept an unreviewed deletion.
