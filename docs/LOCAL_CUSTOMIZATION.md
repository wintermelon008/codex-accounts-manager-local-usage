# Local usage dashboard customization

This fork is pinned to upstream `v0.1.16` / commit `4b1689deafd2d303700c5cc26e6fd285979634e4` and packages as `0.1.16-local.5`.

## Scope

- Adds a read-only local Codex token summary below Saved Accounts. The dashboard and Settings window offer `24h`, `7d`, and `14d` views. The `24h` view is rendered as eight three-hour rows.
- Aggregates model, daily, three-hour, input, output, cached-input, and total-token metadata from `$CODEX_HOME/sessions` (default `~/.codex/sessions`).
- Does not read or send session text, account identities, auth data, or raw paths to the Dashboard Webview.
- Persists only sanitized aggregates in VS Code global storage and scans at most once every 15 minutes. Opening the Dashboard inside that window does not trigger another scan.
- The scanner retains a sanitized 14-day daily aggregate and a matching rolling 24-hour aggregate. The selected range filters this cached data locally, so usage rows, model distribution, totals, and event count always use the same range and range changes do not rescan files.
- Shows an optional estimated standard OpenAI API price in USD between total and input tokens, and alongside each usage bar as `Token (US$price)`. Unknown models stay in range totals but are omitted from the model-distribution list. It is an informational estimate only, not a Codex subscription bill.

The displayed values are local session observations, not ChatGPT account quota or billing data.

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
