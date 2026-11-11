#!/bin/sh
# local/stop.sh —— 停掉本机 local 模式拉起来的 agent-core 与 MCP 子进程。
#
# 正常停法就是 ./local/stop.sh：启动器默认是后台跑的（start.sh 拉起后就返回）。
# 前台模式（AGENT_LOCAL_DETACH=0）下 Ctrl-C / 关窗口也能停。
# 但终端可能被关掉、进程可能是从别处起的——那时就只能按 pid / 端口找。
#
# 关键点：启动器是父进程（启动器 → core + 3/4 个 MCP），只杀 core 会被它重新拉起来
# （那是「重启」的语义）。所以必须先停启动器，停不掉再按端口硬收。
# 幂等：没在运行时直说，不报错。
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME="$HERE/.runtime"
PIDFILE="$RUNTIME/supervisor.pid"

PORT="${PORT:-8090}"
# 与 start.sh 的默认值一致；用 MCP_*_PORT 改过端口时这里也要跟着改（否则兜底那步找不到它们）。
MCP_PORTS="${MCP_WEB_PORT:-8091} ${MCP_IMAGE_PORT:-8092} ${MCP_VIDEO_PORT:-8093} ${MCP_ASR_PORT:-8094}"
# 预览网关端口是启动时从 3100 往后找的第一个空闲口，只能读它写下的记录。
pv_port=$(cat "$RUNTIME/preview.port" 2>/dev/null || printf '')
case "$pv_port" in ''|*[!0-9]*) pv_port='3100';; esac

stopped=0

say() { printf '==> %s\n' "$*"; }

# 某个端口上处于 LISTEN 的进程 pid（没有 lsof 就返回空）。
pids_on_port() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null
}

stop_pid() {
  # $1 pid  $2 说明
  kill -TERM "$1" 2>/dev/null || return 0
  say "停止$2（pid $1）"
  stopped=1
}

wait_gone() {
  # $1 pid，最多等 10 秒
  i=0
  while [ "$i" -lt 20 ]; do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.5 2>/dev/null || sleep 1
    i=$((i + 1))
  done
}

# 1) 首选：启动器自己写的 pid 文件（最准，也最快）。
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE" 2>/dev/null || printf '')
  case "$pid" in ''|*[!0-9]*) pid='';; esac
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    stop_pid "$pid" '启动器'
    wait_gone "$pid"
    if kill -0 "$pid" 2>/dev/null; then
      say '启动器 10 秒内没退出，强制结束'
      kill -KILL "$pid" 2>/dev/null || true
    fi
    sleep 1
  fi
  rm -f "$PIDFILE"
fi

# 2) pid 文件丢了（终端被强杀、目录被清过）：从 core 的父进程认出启动器。
#    按「谁是 8090 的父进程」找，而不是按启动命令的路径拼写去 pgrep——
#    同机可能有别的 clone，靠路径匹配容易误杀或不匹配（实测 `sh ./local/start.sh` 是相对路径）。
if [ "$stopped" = 0 ]; then
  for pid in $(pids_on_port "$PORT"); do
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    case "$ppid" in ''|0|1|*[!0-9]*) continue;; esac
    if ps -o command= -p "$ppid" 2>/dev/null | grep -q 'start\.sh'; then
      stop_pid "$ppid" '启动器（按 core 的父进程识别）'
      wait_gone "$ppid"
      if kill -0 "$ppid" 2>/dev/null; then
        say '启动器 10 秒内没退出，强制结束'
        kill -KILL "$ppid" 2>/dev/null || true
      fi
    fi
  done
  [ "$stopped" = 1 ] && sleep 2
fi

# 3) 兜底：还占着端口的直接收（启动器已经死了，剩下的都是孤儿）。
for p in "$PORT" $MCP_PORTS "$pv_port"; do
  for pid in $(pids_on_port "$p"); do
    stop_pid "$pid" "端口 $p 上的进程"
  done
done
[ "$stopped" = 1 ] && sleep 2

# 4) 收尾：仍占着端口的强制结束，避免下次启动被判「端口被占用」。
for p in "$PORT" $MCP_PORTS "$pv_port"; do
  for pid in $(pids_on_port "$p"); do
    kill -KILL "$pid" 2>/dev/null || true
  done
done

if [ "$stopped" = 1 ]; then
  say '已停止'
else
  say "没有在运行（$PORT、MCP 端口 $MCP_PORTS、预览端口 $pv_port 都空闲）"
fi
