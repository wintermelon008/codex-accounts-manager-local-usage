# Manager private state

Manager runtime data that may contain credentials or local operational content
uses a common private root. Set `CODEX_ACCOUNTS_PRIVATE_DIR` to the same
absolute `private/` directory for the core Manager and separately installed
Mailbox extension.

When the variable is not set, a source checkout uses `<extension root>/private`.
An installed VSIX never uses its replaceable extension directory; it reuses the
stable VS Code `globalStorageUri` directory instead. Test and legacy contexts
continue to use their supplied global storage directory. Existing
global-storage data is therefore retained as the migration source and stable
fallback; an explicit environment variable remains the way to make a packaged
extension use a repository-local `private/` directory.

The root contains the account index, account credential file, Mailbox files,
registration inbox, session registry, sharing state, host policy/state and the
future primary/standby snapshot names. The directory is ignored by Git and
excluded from extension packages. Current local files are protected by
owner-only filesystem permissions; the `manager-state.*.age` files are only
reserved names at this stage. Snapshot encryption and daily primary to
standby transfer remain separate follow-up operations. During migration, core
account credentials and some Mailbox provider values may also remain in the
old VS Code SecretStorage mirror for compatibility; the private files are the
new source of truth.
