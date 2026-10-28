#!/usr/bin/env bash

set -euo pipefail

log_file=${1:?usage: reload-manager-extension-host.sh LOG_FILE}
manager_service=manager-daemon.service
control_port=43117
control_env=/home/melon/.config/codex-accounts-manager/manager-control.env
extensions_manifest=/home/melon/.vscode-server/extensions/extensions.json
node_bin=/home/melon/.local/node-v22.23.2-linux-x64/bin/node
current_user=$(id -un)

extension_record=$($node_bin - "$extensions_manifest" <<'NODE'
const fs = require("fs");
const path = require("path");

const manifestPath = process.argv[2];
const entries = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entry = entries.find((candidate) => candidate.identifier?.id === "wintermelon.codex-account-manager");
const location = entry?.location?.fsPath ?? entry?.location?.path;
if (!entry || typeof location !== "string" || typeof entry.version !== "string") {
  process.exit(1);
}
process.stdout.write(`${path.resolve(location)}\t${entry.version}`);
NODE
)
IFS=$'\t' read -r extension_dir expected_version <<<"$extension_record"

mkdir -p "$(dirname "$log_file")"
exec >>"$log_file" 2>&1

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

log 'reload worker started'
sleep 5

systemctl --user is-active --quiet "$manager_service"
daemon_pid=$(systemctl --user show "$manager_service" -p MainPID --value)
daemon_command=$(ps -o args= -p "$daemon_pid")
case "$daemon_command" in
  *'/home/melon/codex-accounts-manager-usage/out/runtime/managerDaemon.js'*) ;;
  *) log "unexpected daemon command: $daemon_command"; exit 1 ;;
esac

mapfile -t extension_hosts < <(
  ps -u "$current_user" -o pid=,ppid=,args= \
    | awk '/\/server\/out\/bootstrap-fork --type=extensionHost/ {print $1 ":" $2}'
)
if (( ${#extension_hosts[@]} != 1 )); then
  log "expected one VS Code extension host, found ${#extension_hosts[@]}"
  printf '%s\n' "${extension_hosts[@]}"
  exit 1
fi

IFS=: read -r old_extension_host server_pid <<<"${extension_hosts[0]}"
server_command=$(ps -o args= -p "$server_pid")
case "$server_command" in
  *'/server/out/server-main.js'*) ;;
  *) log "unexpected VS Code Server parent: $server_command"; exit 1 ;;
esac

test -x "$node_bin"
test -r "$extensions_manifest"
test -d "$extension_dir"
test -f "$extension_dir/out/application/accounts/quotaCountdownCore.js"
test -f "$extension_dir/out/runtime/quotaCountdownScheduler.js"
test -f "$extension_dir/out/storage/quotaCountdownStartState.js"
test "$(find "$extension_dir" ! -user melon -print -quit)" = ''
if find "$extension_dir" \( -name '.env' -o -name '.env.*' \) -print -quit | grep -q .; then
  log 'secret-like file found in installed extension'
  exit 1
fi

log "preflight daemon=$daemon_pid server=$server_pid extension_host=$old_extension_host"
kill -TERM "$old_extension_host"

new_extension_host=''
for _attempt in $(seq 1 80); do
  new_extension_host=$(
    ps -u "$current_user" -o pid=,ppid=,args= \
      | awk -v old="$old_extension_host" -v parent="$server_pid" \
        '$1 != old && $2 == parent && /\/server\/out\/bootstrap-fork --type=extensionHost/ {print $1; exit}'
  )
  if [ -n "$new_extension_host" ]; then
    break
  fi
  sleep 0.5
done

[ -n "$new_extension_host" ]
new_command=$(ps -o args= -p "$new_extension_host")
case "$new_command" in
  *'/server/out/bootstrap-fork'*'--type=extensionHost'*) ;;
  *) log "unexpected new extension host: $new_command"; exit 1 ;;
esac

set +u
. "$control_env"
set -u
health_code=$(curl --noproxy '*' --max-time 6 -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN" \
  "http://127.0.0.1:$control_port/healthz")
[ "$health_code" = 200 ]

manifest_version=$("$node_bin" -e \
  'const p=require(process.argv[1]); if(p.name!=="codex-account-manager"||p.publisher!=="wintermelon") process.exit(2); process.stdout.write(p.version)' \
  "$extension_dir/package.json")
[ "$manifest_version" = "$expected_version" ]

log "reload completed daemon=$daemon_pid server=$server_pid old_extension_host=$old_extension_host new_extension_host=$new_extension_host health=$health_code version=$manifest_version extension_dir=$extension_dir"
