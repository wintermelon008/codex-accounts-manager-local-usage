#!/usr/bin/env bash

set -euo pipefail

readonly NO_PROXY_VALUE="127.0.0.1,localhost,::1"
readonly PROBE_URL="https://chatgpt.com/backend-api/models"
readonly PROBE_CONNECT_TIMEOUT_SECONDS=4
readonly PROBE_MAX_TIME_SECONDS=8

TARGET="both"
PARSED_ARGS=()

usage() {
  cat <<'EOF'
用法：
  codex-route.sh [--target both|codex|manager] list
  codex-route.sh [--target both|codex|manager] status
  codex-route.sh [--target both|codex|manager] check [route|all]
  codex-route.sh [--target both|codex|manager] env <route|auto>
  codex-route.sh [--target both|codex|manager] exec <route|auto> -- <command> [args...]
  codex-route.sh [--target both|codex|manager] shell <route|auto>

路线：
  direct         VServer 直连
  local-forward  VServer 127.0.0.1:17891 -> SSH RemoteForward -> 本机 127.0.0.1:7890
  clash-http     VServer 127.0.0.1:7897 的 Clash HTTP
  clash-socks    VServer 127.0.0.1:7897 的 Clash SOCKS5
  auto           先探测再选择路线；both/manager 不选择 SOCKS5

说明：
  env 只输出当前 shell 可 eval 的 export/unset 命令；exec/shell 只影响子进程。
  manager 只支持 HTTP/HTTPS proxy，不能使用 clash-socks。
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 2
}

canonical_route() {
  case "${1,,}" in
    direct|none|off)
      printf '%s\n' "direct"
      ;;
    local|local-forward|ssh|ssh-forward|17891)
      printf '%s\n' "local-forward"
      ;;
    clash|clash-http|7897|clash-7897)
      printf '%s\n' "clash-http"
      ;;
    clash-socks|socks|socks5|socks5h|7897-socks)
      printf '%s\n' "clash-socks"
      ;;
    auto)
      printf '%s\n' "auto"
      ;;
    all)
      printf '%s\n' "all"
      ;;
    *)
      die "未知路线：$1；使用 list 查看可用路线"
      ;;
  esac
}

route_proxy() {
  case "$1" in
    direct)
      printf '%s\n' ""
      ;;
    local-forward)
      printf '%s\n' "http://127.0.0.1:17891"
      ;;
    clash-http)
      printf '%s\n' "http://127.0.0.1:7897"
      ;;
    clash-socks)
      printf '%s\n' "socks5h://127.0.0.1:7897"
      ;;
    *)
      die "内部错误：$1 不是具体路线"
      ;;
  esac
}

validate_target() {
  case "$1" in
    both|codex|manager)
      ;;
    *)
      die "--target 只能是 both、codex 或 manager"
      ;;
  esac
}

validate_route_for_target() {
  local route="$1"
  if [[ "$route" == "clash-socks" && ( "$TARGET" == "both" || "$TARGET" == "manager" ) ]]; then
    die "clash-socks 只适用于 Codex/通用客户端；manager 只接受 HTTP/HTTPS proxy，请用 clash-http"
  fi
}

emit_env() {
  local route="$1"
  local proxy

  validate_route_for_target "$route"
  proxy="$(route_proxy "$route")"

  case "$route" in
    direct)
      cat <<EOF
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY=$NO_PROXY_VALUE
export no_proxy=$NO_PROXY_VALUE
EOF
      ;;
    local-forward|clash-http)
      cat <<EOF
export HTTP_PROXY=$proxy
export HTTPS_PROXY=$proxy
export ALL_PROXY=$proxy
export http_proxy=$proxy
export https_proxy=$proxy
export all_proxy=$proxy
export NO_PROXY=$NO_PROXY_VALUE
export no_proxy=$NO_PROXY_VALUE
EOF
      ;;
    clash-socks)
      cat <<EOF
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
export ALL_PROXY=$proxy
export all_proxy=$proxy
export NO_PROXY=$NO_PROXY_VALUE
export no_proxy=$NO_PROXY_VALUE
EOF
      ;;
    *)
      die "内部错误：不能为 $route 输出环境"
      ;;
  esac
}

run_with_route() {
  local route="$1"
  shift
  local proxy

  validate_route_for_target "$route"
  proxy="$(route_proxy "$route")"

  case "$route" in
    direct)
      env \
        -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
        -u http_proxy -u https_proxy -u all_proxy \
        NO_PROXY="$NO_PROXY_VALUE" no_proxy="$NO_PROXY_VALUE" \
        "$@"
      ;;
    local-forward|clash-http)
      env \
        HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" ALL_PROXY="$proxy" \
        http_proxy="$proxy" https_proxy="$proxy" all_proxy="$proxy" \
        NO_PROXY="$NO_PROXY_VALUE" no_proxy="$NO_PROXY_VALUE" \
        "$@"
      ;;
    clash-socks)
      env \
        -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
        ALL_PROXY="$proxy" all_proxy="$proxy" \
        NO_PROXY="$NO_PROXY_VALUE" no_proxy="$NO_PROXY_VALUE" \
        "$@"
      ;;
    *)
      die "内部错误：不能运行路线 $route"
      ;;
  esac
}

probe_route() {
  local route="$1"
  local result
  local code

  if ! result="$(run_with_route "$route" curl -4 -sS -o /dev/null \
      --connect-timeout "$PROBE_CONNECT_TIMEOUT_SECONDS" \
      --max-time "$PROBE_MAX_TIME_SECONDS" \
      -w '%{http_code} %{time_total}' "$PROBE_URL" 2>/dev/null)"; then
    return 1
  fi

  code="${result%% *}"
  if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
    printf '%s\n' "$result"
    return 0
  fi
  return 1
}

candidate_routes() {
  case "$TARGET" in
    codex)
      printf '%s\n' clash-http clash-socks local-forward direct
      ;;
    both|manager)
      printf '%s\n' clash-http local-forward direct
      ;;
  esac
}

select_route() {
  local route
  while IFS= read -r route; do
    if probe_route "$route" >/dev/null; then
      printf '%s\n' "$route"
      return 0
    fi
  done < <(candidate_routes)
  die "没有可达的 ChatGPT 路线（target=$TARGET）"
}

print_route_check() {
  local route="$1"
  local result
  local status

  if result="$(probe_route "$route")"; then
    status="ok"
  else
    status="fail"
    result="-"
  fi
  printf '%-14s %-6s %s\n' "$route" "$status" "$result"
}

current_route() {
  local http_proxy_value="${HTTP_PROXY:-${http_proxy:-}}"
  local https_proxy_value="${HTTPS_PROXY:-${https_proxy:-}}"
  local all_proxy_value="${ALL_PROXY:-${all_proxy:-}}"

  if [[ -z "$http_proxy_value$https_proxy_value$all_proxy_value" ]]; then
    printf '%s\n' "direct"
  elif [[ "$http_proxy_value" == "http://127.0.0.1:17891" || "$https_proxy_value" == "http://127.0.0.1:17891" || "$all_proxy_value" == "http://127.0.0.1:17891" ]]; then
    printf '%s\n' "local-forward"
  elif [[ "$http_proxy_value" == "http://127.0.0.1:7897" || "$https_proxy_value" == "http://127.0.0.1:7897" || "$all_proxy_value" == "http://127.0.0.1:7897" ]]; then
    printf '%s\n' "clash-http"
  elif [[ "$all_proxy_value" == "socks5h://127.0.0.1:7897" && -z "$http_proxy_value$https_proxy_value" ]]; then
    printf '%s\n' "clash-socks"
  else
    printf '%s\n' "custom/mixed"
  fi
}

parse_options() {
  PARSED_ARGS=("$@")
  while [[ ${#PARSED_ARGS[@]} -gt 0 ]]; do
    case "${PARSED_ARGS[0]}" in
      --target)
        [[ ${#PARSED_ARGS[@]} -ge 2 ]] || die "--target 缺少值"
        TARGET="${PARSED_ARGS[1]}"
        PARSED_ARGS=("${PARSED_ARGS[@]:2}")
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        PARSED_ARGS=("${PARSED_ARGS[@]:1}")
        break
        ;;
      -* )
        die "未知选项：${PARSED_ARGS[0]}"
        ;;
      *)
        break
        ;;
    esac
  done
  validate_target "$TARGET"
}

main() {
  parse_options "$@"
  set -- "${PARSED_ARGS[@]}"
  [[ $# -gt 0 ]] || { usage; exit 2; }

  local command="$1"
  shift
  local route

  case "$command" in
    list)
      cat <<'EOF'
route          proxy                         target
direct         none                          codex / manager
local-forward  http://127.0.0.1:17891       codex / manager
clash-http     http://127.0.0.1:7897        codex / manager
clash-socks    socks5h://127.0.0.1:7897     codex only
auto           probe then choose             target-dependent
EOF
      ;;
    status)
      printf 'inferred_route=%s\n' "$(current_route)"
      for variable in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
        if [[ -n "${!variable:-}" ]]; then
          printf '%s=set\n' "$variable"
        else
          printf '%s=unset\n' "$variable"
        fi
      done
      ;;
    check)
      route="$(canonical_route "${1:-all}")"
      if [[ "$route" == "all" ]]; then
        printf '%-14s %-6s %s\n' route status 'http_code time_seconds'
        while IFS= read -r route; do
          if [[ "$route" != "clash-socks" || "$TARGET" == "codex" ]]; then
            print_route_check "$route"
          fi
        done < <(printf '%s\n' direct local-forward clash-http clash-socks)
      elif [[ "$route" == "auto" ]]; then
        printf 'selected_route=%s\n' "$(select_route)"
      else
        validate_route_for_target "$route"
        printf '%-14s %-6s %s\n' route status 'http_code time_seconds'
        print_route_check "$route"
      fi
      ;;
    env|use)
      [[ $# -ge 1 ]] || die "$command 需要 route"
      route="$(canonical_route "$1")"
      [[ "$route" != "all" ]] || die "env 不接受 all"
      if [[ "$route" == "auto" ]]; then
        route="$(select_route)"
        printf '[codex-route] selected route=%s target=%s\n' "$route" "$TARGET" >&2
      fi
      emit_env "$route"
      ;;
    exec|run)
      [[ $# -ge 1 ]] || die "$command 需要 route"
      route="$(canonical_route "$1")"
      shift
      [[ "${1:-}" == "--" ]] && shift
      [[ $# -gt 0 ]] || die "$command 需要 -- 后的命令"
      if [[ "$route" == "auto" ]]; then
        route="$(select_route)"
        printf '[codex-route] selected route=%s target=%s\n' "$route" "$TARGET" >&2
      fi
      run_with_route "$route" "$@"
      ;;
    shell)
      [[ $# -ge 1 ]] || die "shell 需要 route"
      route="$(canonical_route "$1")"
      [[ $# -eq 1 ]] || die "shell 只接受一个 route"
      if [[ "$route" == "auto" ]]; then
        route="$(select_route)"
        printf '[codex-route] selected route=%s target=%s\n' "$route" "$TARGET" >&2
      fi
      if [[ "${SHELL:-/bin/bash}" == */zsh ]]; then
        run_with_route "$route" zsh -f -i
      else
        run_with_route "$route" bash --noprofile --norc -i
      fi
      ;;
    auto)
      [[ $# -eq 0 ]] || die "auto 不接受额外参数；用 exec auto -- <command> 或 env auto"
      printf '%s\n' "$(select_route)"
      ;;
    -h|--help)
      usage
      ;;
    *)
      die "未知命令：$command；使用 --help 查看用法"
      ;;
  esac
}

main "$@"
