#!/usr/bin/env bash

set -u
set -o pipefail

handoff_service=manager-daemon.service
control_port=43117
control_host=127.0.0.1
control_env_file=/home/melon/.config/codex-accounts-manager/manager-control.env
recovery_seconds=60

server_pid=""
extension_host_pid=""
recovery_unit=""
control_token=""
handoff_committed=0

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

get_control_pid() {
  ss -Hlnp "sport = :$control_port" 2>/dev/null \
    | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
    | head -n 1
}

get_command() {
  ps -o args= -p "$1" 2>/dev/null || true
}

get_state() {
  ps -o stat= -p "$1" 2>/dev/null | tr -d '[:space:]'
}

extension_host_count() {
  ps -eo pid=,ppid=,args= 2>/dev/null \
    | awk -v parent_pid="$server_pid" \
      '$2 == parent_pid && $0 ~ /\/server\/out\/bootstrap-fork --type=extensionHost/ {count++} END {print count + 0}'
}

load_control_token() {
  [ -r "$control_env_file" ] || die "control environment file is not readable: $control_env_file"
  set +u
  . "$control_env_file"
  set -u
  control_token=$CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN
  [ -n "$control_token" ] || die 'CODEX_ACCOUNTS_MANAGER_CONTROL_TOKEN is empty'
}

request_code() {
  local path="$1"
  local timeout_seconds="$2"
  curl --noproxy '*' --max-time "$timeout_seconds" -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $control_token" \
    "http://$control_host:$control_port$path" 2>/dev/null || true
}

stop_recovery_timer() {
  if [ -n "$recovery_unit" ]; then
    systemctl --user stop "$recovery_unit" >/dev/null 2>&1 || true
  fi
}

rollback() {
  local exit_code="$?"
  if [ "$handoff_committed" -eq 0 ]; then
    log 'rollback: stopping any partially started daemon and resuming VS Code Server'
    if systemctl --user is-active --quiet "$handoff_service" 2>/dev/null; then
      systemctl --user stop "$handoff_service" >/dev/null 2>&1 || true
    fi
    if [ -n "$server_pid" ]; then
      kill -CONT "$server_pid" >/dev/null 2>&1 || true
    fi

    local attempt=0
    while [ "$attempt" -lt 24 ]; do
      local current_pid="$(get_control_pid || true)"
      if [ -n "$current_pid" ]; then
        local current_command="$(get_command "$current_pid")"
        case "$current_command" in
          *managerDaemon.js*) ;;
          *) break ;;
        esac
      fi
      attempt=$((attempt + 1))
      sleep 0.25
    done
  fi
  stop_recovery_timer
  if [ "$exit_code" -ne 0 ]; then
    log 'rollback: completed; the original VS Code control path should be available again' >&2
  fi
  exit "$exit_code"
}

trap rollback EXIT INT TERM

for required_command in ss sed ps awk systemctl systemd-run curl; do
  command -v "$required_command" >/dev/null 2>&1 || die "required command is unavailable: $required_command"
done

load_control_token

if systemctl --user is-active --quiet "$handoff_service" 2>/dev/null; then
  daemon_pid="$(systemctl --user show "$handoff_service" -p MainPID --value 2>/dev/null || true)"
  daemon_command="$(get_command "$daemon_pid")"
  case "$daemon_command" in
    *managerDaemon.js*) ;;
    *) die 'manager-daemon.service is active but its MainPID is not managerDaemon' ;;
  esac
  [ "$(request_code '/healthz' 4)" = 200 ] || die 'active daemon health check failed'
  log "daemon is already active and healthy (pid=$daemon_pid)"
  handoff_committed=1
  exit 0
fi

extension_host_pid="$(get_control_pid || true)"
[ -n "$extension_host_pid" ] || die "control port $control_port has no listener"
extension_host_command="$(get_command "$extension_host_pid")"
case "$extension_host_command" in
  *'bootstrap-fork --type=extensionHost'*) ;;
  *) die "control port owner is not the expected Extension Host (pid=$extension_host_pid)" ;;
esac

server_pid="$(ps -o ppid= -p "$extension_host_pid" 2>/dev/null | awk '{print $1}')"
[ -n "$server_pid" ] || die 'could not resolve the Extension Host parent'
server_command="$(get_command "$server_pid")"
case "$server_command" in
  */server/out/server-main.js*) ;;
  *) die "Extension Host parent is not the expected VS Code Server (pid=$server_pid)" ;;
esac

server_state="$(get_state "$server_pid")"
case "$server_state" in
  *T*) die "VS Code Server is already stopped (pid=$server_pid, state=$server_state)" ;;
esac

log "preflight passed: server=$server_pid extension_host=$extension_host_pid port=$control_port"

recovery_unit=manager-handoff-recovery-$server_pid-$(date +%s).service
recovery_command="sleep $recovery_seconds; if [ -r /proc/$server_pid/cmdline ] && tr '\\0' ' ' < /proc/$server_pid/cmdline | grep -q '/server/out/server-main.js'; then kill -CONT $server_pid; fi"
systemd-run --user --unit="$recovery_unit" --collect /bin/sh -c "$recovery_command" >/dev/null 2>&1 \
  || die 'could not start the independent Server recovery timer'

local_attempt=0
while [ "$local_attempt" -lt 20 ]; do
  systemctl --user is-active --quiet "$recovery_unit" 2>/dev/null && break
  local_attempt=$((local_attempt + 1))
  sleep 0.1
done
systemctl --user is-active --quiet "$recovery_unit" 2>/dev/null \
  || die 'independent Server recovery timer did not become active'

current_control_pid="$(get_control_pid || true)"
[ "$current_control_pid" = "$extension_host_pid" ] \
  || die 'the control-port owner changed during preflight; refusing to continue'

log "pausing VS Code Server parent $server_pid"
kill -STOP "$server_pid" || die "could not stop VS Code Server parent $server_pid"
local_attempt=0
while [ "$local_attempt" -lt 20 ]; do
  server_state="$(get_state "$server_pid")"
  case "$server_state" in *T*) break;; esac
  local_attempt=$((local_attempt + 1))
  sleep 0.1
done
case "$server_state" in
  *T*) ;;
  *) die "VS Code Server did not enter stopped state (state=$server_state)" ;;
esac

log "stopping old Extension Host $extension_host_pid"
kill -TERM "$extension_host_pid" || die "could not stop old Extension Host $extension_host_pid"
local_attempt=0
while [ "$local_attempt" -lt 60 ]; do
  [ -z "$(get_control_pid || true)" ] && break
  local_attempt=$((local_attempt + 1))
  sleep 0.25
done
[ -z "$(get_control_pid || true)" ] || die 'control port did not become free after stopping Extension Host'

log "starting $handoff_service"
systemctl --user start "$handoff_service" >/dev/null 2>&1 \
  || die "could not start $handoff_service"

daemon_pid=""
local_attempt=0
while [ "$local_attempt" -lt 60 ]; do
  if systemctl --user is-active --quiet "$handoff_service" 2>/dev/null; then
    daemon_pid="$(systemctl --user show "$handoff_service" -p MainPID --value 2>/dev/null || true)"
    [ -n "$daemon_pid" ] && [ "$daemon_pid" != 0 ] && break
  fi
  local_attempt=$((local_attempt + 1))
  sleep 0.25
done
systemctl --user is-active --quiet "$handoff_service" 2>/dev/null \
  || die "$handoff_service did not become active"
[ -n "$daemon_pid" ] && [ "$daemon_pid" != 0 ] \
  || die 'daemon MainPID was not reported'

control_pid=""
control_command=""
local_attempt=0
while [ "$local_attempt" -lt 60 ]; do
  control_pid="$(get_control_pid || true)"
  if [ -n "$control_pid" ]; then
    control_command="$(get_command "$control_pid")"
    case "$control_command" in *managerDaemon.js*) break;; esac
  fi
  local_attempt=$((local_attempt + 1))
  sleep 0.25
done
case "$control_command" in
  *managerDaemon.js*) ;;
  *) die "daemon did not take control port $control_port" ;;
esac

health_code="$(request_code '/healthz' 4)"
status_code="$(request_code '/api/manager/status' 8)"
accounts_code="$(request_code '/api/manager/accounts' 8)"
log "daemon checks: health=$health_code status=$status_code accounts=$accounts_code"
[ "$health_code" = 200 ] || die "daemon health check returned HTTP $health_code"
[ "$status_code" = 200 ] || die "manager status check returned HTTP $status_code"
[ "$accounts_code" = 200 ] || die "manager accounts check returned HTTP $accounts_code"

log "resuming VS Code Server parent $server_pid"
kill -CONT "$server_pid" || die "could not resume VS Code Server parent $server_pid"
local_attempt=0
while [ "$local_attempt" -lt 40 ]; do
  server_state="$(get_state "$server_pid")"
  case "$server_state" in *T*) ;; *) break;; esac
  local_attempt=$((local_attempt + 1))
  sleep 0.25
done
case "$server_state" in
  *T*) die "VS Code Server remained stopped after resume (state=$server_state)" ;;
esac

stable_checks=0
local_attempt=0
while [ "$local_attempt" -lt 40 ]; do
  current_extension_count="$(extension_host_count)"
  control_pid="$(get_control_pid || true)"
  control_command=""
  [ -n "$control_pid" ] && control_command="$(get_command "$control_pid")"
  health_code="$(request_code '/healthz' 3)"
  case "$control_command" in
    *managerDaemon.js*)
      if [ "$current_extension_count" -gt 0 ] && [ "$health_code" = 200 ]; then
        stable_checks=$((stable_checks + 1))
      else
        stable_checks=0
      fi
      ;;
    *) stable_checks=0;;
  esac
  [ "$stable_checks" -ge 6 ] && break
  local_attempt=$((local_attempt + 1))
  sleep 0.5
done
[ "$stable_checks" -ge 6 ] || die 'daemon did not remain owner after Extension Host respawn'

handoff_committed=1
stop_recovery_timer
log "handoff completed: daemon_pid=$daemon_pid control_pid=$control_pid extension_hosts=$current_extension_count"
exit 0
