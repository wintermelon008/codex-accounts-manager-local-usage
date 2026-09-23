# Manager private state

This directory is the runtime-private root for a Manager checkout. It is
intentionally excluded from Git and from packaged extensions. Only the
non-sensitive layout contract is kept in the repository.

Runtime files may include account credentials, Mailbox provider state,
registration keys, 2FAuth configuration, host policy/state, and encrypted
primary/standby snapshots. Do not add real values to tracked files.

Local JSON files currently rely on owner-only filesystem permissions. The
reserved `.age` snapshot names do not imply that snapshot encryption or
transfer is active yet.

On first Manager initialization, `host-policy.v1.json` is created with daily
midnight sync, explicit promotion, and automatic promotion disabled. The
current role and snapshot counters live in `host-state.v1.json`; existing
policy/state files are never overwritten automatically.

The `CODEX_ACCOUNTS_PRIVATE_DIR` environment variable can point the core
Manager and separately installed Mailbox extension at the same absolute
directory on a device.
