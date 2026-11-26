#!/bin/bash

# 判定某个 Tauri 开发槽是否正在被使用。
#
# 硬判据只有两个：
#   1. 进程名精确等于 code-agent-tauri，且真实可执行路径等于本槽二进制；
#   2. 本槽 webServer 端口存在 LISTEN 进程。
# 调用 shell 及其祖先始终排除，避免编排命令行里出现 app 路径时把自己当成槽实例。

_tauri_guard_trim_number() {
  printf '%s' "$1" | tr -d '[:space:]'
}

_tauri_guard_excluded_pids() {
  local current="$$"
  local excluded=" "
  local parent

  while :; do
    case "$current" in
      ''|*[!0-9]*) break ;;
    esac
    case "$excluded" in
      *" $current "*) break ;;
    esac
    excluded="${excluded}${current} "
    [ "$current" -gt 1 ] || break
    parent="$(ps -o ppid= -p "$current" 2>/dev/null || true)"
    parent="$(_tauri_guard_trim_number "$parent")"
    [ -n "$parent" ] && [ "$parent" != "$current" ] || break
    current="$parent"
  done

  printf '%s' "$excluded"
}

_tauri_guard_pid_is_excluded() {
  local pid="$1"
  local excluded="$2"
  case "$excluded" in
    *" $pid "*) return 0 ;;
    *) return 1 ;;
  esac
}

_tauri_guard_executable_paths() {
  local pid="$1"
  local comm

  comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
  comm="$(printf '%s' "$comm" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$comm" in
    /*) printf '%s\n' "$comm" ;;
  esac

  if [ -r "/proc/$pid/exe" ]; then
    readlink "/proc/$pid/exe" 2>/dev/null || true
    return 0
  fi

  # macOS 的 ps comm 通常已经是完整路径；lsof txt 是无 /proc 时的硬兜底。
  lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n\(\/.*\)$/\1/p' || true
}

_tauri_guard_real_executable_path() {
  _tauri_guard_executable_paths "$1" | sed -n '1p'
}

find_tauri_slot_instances() {
  local app_path="$1"
  local port="$2"
  local process_name="${3:-code-agent-tauri}"
  local expected_executable="${app_path%/}/Contents/MacOS/code-agent-tauri"
  local excluded
  local seen=" "
  local pid
  local path
  local executable_paths

  case "$port" in
    ''|*[!0-9]*)
      echo "[install-dev] 无效的槽端口：$port" >&2
      return 2
      ;;
  esac

  excluded="$(_tauri_guard_excluded_pids)"

  # pgrep 只按短进程名精确筛候选；路径判定来自真实进程信息，不看 argv。
  # Linux 的 comm 只有 15 字节，长进程名要同时按截断名取候选，再由 /proc 路径精确判定。
  for pid in $(
    pgrep -x "$process_name" 2>/dev/null || true
    if [ -d /proc ] && [ "${#process_name}" -gt 15 ]; then
      pgrep -x "${process_name:0:15}" 2>/dev/null || true
    fi
  ); do
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    _tauri_guard_pid_is_excluded "$pid" "$excluded" && continue
    executable_paths="$(_tauri_guard_executable_paths "$pid")"
    if printf '%s\n' "$executable_paths" | grep -Fxq "$expected_executable"; then
      printf 'pid=%s real_executable=%s criterion=app-path\n' "$pid" "$expected_executable"
      seen="${seen}${pid} "
    fi
  done

  # webServer 可能是 app 拉起的 node 子进程，因此端口命中独立成立，不要求进程名是 Tauri。
  for pid in $(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true); do
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    _tauri_guard_pid_is_excluded "$pid" "$excluded" && continue
    case "$seen" in
      *" $pid "*) continue ;;
    esac
    path="$(_tauri_guard_real_executable_path "$pid")"
    [ -n "$path" ] || path="<unresolved>"
    printf 'pid=%s real_executable=%s criterion=tcp-listen:%s\n' "$pid" "$path" "$port"
    seen="${seen}${pid} "
  done
}

refuse_if_tauri_slot_in_use() {
  local app_name="$1"
  local app_path="$2"
  local port="$3"
  local running
  local confirmed
  local record
  local pid

  TAURI_SLOT_CONFIRMED_PIDS=""
  if ! running="$(find_tauri_slot_instances "$app_path" "$port")"; then
    echo "[install-dev] 无法判定槽 '$app_name' 是否在用，拒绝覆盖" >&2
    return 1
  fi
  [ -n "$running" ] || return 0

  if [ "${NEO_INSTALL_FORCE:-0}" = "1" ]; then
    echo "[install-dev] NEO_INSTALL_FORCE=1：槽 '$app_name' 有实例在跑，仍按要求覆盖" >&2
    printf '%s\n' "$running" >&2
    confirmed=""
    while IFS= read -r record; do
      pid="${record%% *}"
      case "$pid" in
        pid=*) pid="${pid#pid=}" ;;
        *) continue ;;
      esac
      case "$pid" in
        ''|*[!0-9]*) continue ;;
      esac
      confirmed="${confirmed}${confirmed:+ }${pid}"
    done <<< "$running"
    TAURI_SLOT_CONFIRMED_PIDS="$confirmed"
    return 0
  fi

  cat >&2 <<EOM
[install-dev] 拒绝安装：槽 '$app_name' 正有实例在跑，装包会把它杀掉并重写资源目录。
$running
  → 换一个槽（NEO_SLOT=<n>）或等使用者退出；确认过没人在用再加 NEO_INSTALL_FORCE=1。
EOM
  return 1
}

terminate_confirmed_tauri_slot_instances() {
  local pid

  for pid in ${TAURI_SLOT_CONFIRMED_PIDS:-}; do
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    kill -TERM "$pid" 2>/dev/null || true
  done
}
