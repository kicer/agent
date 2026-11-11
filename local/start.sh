#!/bin/sh
# local/start.sh —— 本机（macOS / Linux）一键启动 agent-core。
#
# 这个脚本只负责「把容器部署的形状换成本机形状」，不改任何业务逻辑：
#   1. 探测环境（node 必需；ffmpeg 决定能不能语音；python3 决定技能可不可用）
#   2. 首次运行：选工作目录 + 生成 local/config.local.yml
#   3. 起 core（+ 四个同栈 MCP 子进程），就绪后打开浏览器
#   4. 守护：core 退出就拉起来
#
# 第 4 步是必须的，不是锦上添花：设置页的「重启」按钮实现是 process.exit(0)，
# 原本靠 Docker 的 restart 策略把容器拉起来（routes/system.js 注释写明「非 docker 部署不会自动拉起」）。
# 本地没有 Docker，没有这个循环，用户配完模型一点重启，服务就再也回不来了。
#
# 为什么用 POSIX sh 写：macOS 自带的是 bash 3.2（2007 年），没有关联数组等语法，
# 当作 sh 跑最稳，Linux 上也一样。
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
RUNTIME="$HERE/.runtime"
CONFIG="$HERE/config.local.yml"
LOG="$RUNTIME/core.log"

PORT="${PORT:-8090}"
HOST_ADDR="127.0.0.1"
NPM_REGISTRY="${NPM_REGISTRY:-}"

# 四个同栈 MCP 服务在服务器上是各自独立的容器，都监听 3000 也不冲突；
# 本地挤在同一台机器上，必须各占一个端口。
MCP_WEB_PORT="${MCP_WEB_PORT:-3101}"
MCP_IMAGE_PORT="${MCP_IMAGE_PORT:-3102}"
MCP_VIDEO_PORT="${MCP_VIDEO_PORT:-3103}"
MCP_ASR_PORT="${MCP_ASR_PORT:-3104}"

mkdir -p "$RUNTIME" "$ROOT/data"
printf '\n==== %s 启动 ====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"

if [ -t 1 ]; then C='\033[1;32m'; Y='\033[1;33m'; N='\033[0m'; else C=''; Y=''; N=''; fi
say()  { printf "${C}==>${N} %s\n" "$*"; }
warn() { printf "${Y}[!]${N} %s\n" "$*"; }

# ---------- 探测 ----------
NODE_VER=''
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v 2>/dev/null || echo '')
  # 用真跑一次判定而不是只看版本字符串：确保这个 node 是可执行的。
  if node -e 'process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
    NODE_OK=1
  fi
fi

NPM_OK=0
command -v npm >/dev/null 2>&1 && NPM_OK=1

# macOS 的 /usr/bin/python3 是 Xcode 命令行工具的桩：文件存在，但没装 CLT 时一执行就弹安装窗。
# 所以必须真跑一句，command -v 会骗人。
PY_OK=0
PY_VER=''
if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then
  PY_OK=1
  PY_VER=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo '')
fi

FF_OK=0
FF_VER=''
if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version >/dev/null 2>&1; then
  FF_OK=1
  FF_VER=$(ffmpeg -version 2>/dev/null | head -n 1 | sed -e 's/^ffmpeg version //' -e 's/ .*//')
fi

PORT_FREE=1
if [ "$NODE_OK" = 1 ]; then
  node -e 'const net=require("net"),s=net.createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close(()=>process.exit(0)))' "$PORT" >/dev/null 2>&1 || PORT_FREE=0
fi

case "$(uname -s)" in
  Darwin) NODE_HINT='<code>brew install node@20</code>，或到 nodejs.org 下载 macOS 安装包';;
  *)      NODE_HINT='用 nvm 安装（<code>nvm install 20</code>），或发行版包管理器装 nodejs 20+';;
esac

# ---------- 自检页（纯静态，无 node 也能打开） ----------
html_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

open_target() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

setup_head() {
  # $1 标题 $2 建议（可含 HTML）
  cat > "$RUNTIME/setup.html" <<EOF
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>$(html_escape "$1")</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:44px 22px;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#20242a}
main{max-width:820px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 30px;box-shadow:0 2px 14px rgba(0,0,0,.07)}
h1{font-size:20px;margin:0 0 6px}
.hint{margin:0 0 20px;color:#4a5563}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #eceef1;vertical-align:top}
th{color:#6b7480;font-weight:600;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em}
td:first-child{width:120px;white-space:nowrap}
.s-ok{color:#1a7f37;font-weight:600;white-space:nowrap}
.s-bad{color:#c0392b;font-weight:600;white-space:nowrap}
.s-warn{color:#9a6700;font-weight:600;white-space:nowrap}
code{background:#f0f2f5;border-radius:5px;padding:1px 5px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-user-select:all;user-select:all}
.note{margin:20px 0 0;padding-top:16px;border-top:1px solid #eceef1;color:#4a5563;font-size:14px}
.tip{margin:16px 0 0;color:#6b7480;font-size:13px}
@media (prefers-color-scheme:dark){
  body{background:#16181d;color:#e6e8eb}
  main{background:#1d2026;box-shadow:none}
  .hint,.note{color:#a8b1bd}
  th,td{border-color:#2b3038}
  code{background:#2a2f38}
}
</style></head><body><main>
<h1>$(html_escape "$1")</h1>
<p class="hint">$2</p>
<table><thead><tr><th>检查项</th><th>状态</th><th>说明</th></tr></thead><tbody>
EOF
}

setup_row() {
  # $1 名称 $2 ok|bad|warn $3 状态文字 $4 说明（可含 HTML）
  printf '<tr><td>%s</td><td class="s-%s">%s</td><td>%s</td></tr>\n' \
    "$(html_escape "$1")" "$2" "$(html_escape "$3")" "$4" >> "$RUNTIME/setup.html"
}

setup_rows() {
  if [ "$NODE_OK" = 1 ]; then
    setup_row 'Node.js' ok "已安装 $NODE_VER" '需要 20 或更高版本'
  else
    setup_row 'Node.js' bad '缺失或版本过低' "必需。$NODE_HINT"
  fi
  if [ "$NPM_OK" = 1 ]; then
    setup_row 'npm' ok '可用' '安装依赖用'
  else
    setup_row 'npm' bad '缺失' '随 Node.js 一起安装，重装 Node 即可'
  fi
  if [ "$PY_OK" = 1 ]; then
    setup_row 'python3' ok "已安装 $PY_VER" '可选：用于技能（skills/*/run.py）'
  else
    setup_row 'python3' warn '未安装' '可选。没有它时技能清单为空，其余功能不受影响'
  fi
  if [ "$FF_OK" = 1 ]; then
    setup_row 'ffmpeg' ok "已安装 $FF_VER" '可选：语音输入与音频转码'
  else
    setup_row 'ffmpeg' warn '未安装' '可选。没有它时语音输入入口自动隐藏'
  fi
  if [ "$PORT_FREE" = 1 ]; then
    setup_row "端口 $PORT" ok '可用' 'agent-core 监听地址'
  else
    setup_row "端口 $PORT" bad '已被占用' "换一个端口再启动：<code>PORT=8091 ./local/start.sh</code>"
  fi
}

setup_close() {
  cat >> "$RUNTIME/setup.html" <<'EOF'
</tbody></table>
<p class="note">装好之后回到终端，重新执行 <code>./local/start.sh</code>（或双击 <code>start.command</code>）。</p>
<p class="tip">这个页面是本地静态文件，不会自动刷新，也不会重试。</p>
</main></body></html>
EOF
  open_target "$RUNTIME/setup.html"
  printf '\n自检页已保存：%s\n' "$RUNTIME/setup.html"
}

# ---------- 首次运行：选目录 + 生成配置 ----------
choose_workspace() {
  ws=''
  if [ "$(uname -s)" = 'Darwin' ] && command -v osascript >/dev/null 2>&1; then
    ws=$(osascript -e 'POSIX path of (choose folder with prompt "选择 Agent 的工作目录：AI 会在这个目录里干活")' 2>/dev/null) || ws=''
  fi
  if [ -z "$ws" ] && [ -t 0 ]; then
    printf '工作目录（AI 会在这里干活）[%s/AgentWork]: ' "$HOME"
    read -r ans || ans=''
    if [ -n "${ans:-}" ]; then ws=$ans; else ws="$HOME/AgentWork"; fi
  fi
  [ -z "$ws" ] && ws="$HOME/AgentWork"
  printf '%s\n' "${ws%/}"
}

generate_config() {
  ws=$1
  mkdir -p "$ws" 2>/dev/null || { say "无法创建工作目录：$ws"; exit 1; }
  cat > "$CONFIG" <<EOF
# 本机 local 模式配置 —— 由 local/start.sh 首次启动时生成，之后不再覆盖。
# 改模型 / 密钥 / MCP：浏览器打开 http://$HOST_ADDR:$PORT → 左下角用户区 → 设置。
# 想彻底重来：删掉本文件再跑一次 ./local/start.sh（会话记录在 data/ 和工作目录里，不会被删）。
port: $PORT
# AI 的工作根。启动器注入 AGENT_FILE_SCOPE=workspace，文件工具可读写这个目录下的任意位置，
# 不再像服务器那样被限制在单个会话子目录里。
workspace_root: $ws
data_root: $ROOT/data
skills:
  # 指向 local/.runtime/skills：启动脚本按「有没有可用的 python3」把它软链到真技能目录或空目录。
  # 这样装不装 python3 都不用改这份配置（改完重跑脚本即生效）。
  skills_root: $ROOT/local/.runtime/skills
# 故意留空：启动后在设置页添加平台与 API Key，再点「重启」——启动器会自动拉起。
platforms: []
log_level: info
mcp_servers:
  # 四个同栈 MCP 都在本机跑（零依赖 Node），端口由启动器分配，别和上面的 PORT 撞。
  # 上游密钥/地址由这里的 headers 带（在设置页对应卡片里填）；不填则该能力不可用。
  - name: web_search
    url: "http://127.0.0.1:$MCP_WEB_PORT/"
  - name: image_task
    url: "http://127.0.0.1:$MCP_IMAGE_PORT/mcp"
    mode: skill
  - name: video_task
    url: "http://127.0.0.1:$MCP_VIDEO_PORT/mcp"
    mode: skill
  - name: asr
    url: "http://127.0.0.1:$MCP_ASR_PORT/mcp"
    mode: skill
EOF
  say "已生成配置：$CONFIG"
  say "工作目录：$ws"
}

# ---------- 技能目录：用软链切换，不动配置 ----------
link_skills() {
  link="$RUNTIME/skills"
  if [ "$PY_OK" = 1 ]; then dest="$ROOT/skills"; else dest="$RUNTIME/empty-skills"; mkdir -p "$dest"; fi
  rm -f "$link" 2>/dev/null || true
  # 万一上次留下了真目录（老版本行为），先挪走再建软链
  if [ -d "$link" ] && [ ! -L "$link" ]; then rm -rf "$link"; fi
  ln -s "$dest" "$link" || { warn "技能目录软链创建失败：$link"; return 1; }
}

# ---------- 依赖安装 ----------
# 不只 app：mcp/image_task 与 mcp/video_task 也带 npm 依赖（@modelcontextprotocol/sdk + express），
# 服务器上这些是镜像构建时装好的，本地得自己装。asr / web_search 是零依赖，自动跳过。
ensure_deps() {
  NEED=''
  for d in "$ROOT/app" "$ROOT"/mcp/*/; do
    [ -f "$d/package.json" ] || continue
    if node -e 'process.exit(Object.keys(require(process.argv[1]).dependencies||{}).length?0:1)' "$d/package.json" >/dev/null 2>&1; then
      if [ ! -d "$d/node_modules" ] || [ "$d/package.json" -nt "$d/node_modules" ]; then
        NEED="$NEED $d"
      fi
    fi
  done
  [ -z "$NEED" ] && return 0
  if [ "$NPM_OK" != 1 ]; then
    SETUP_TITLE='缺少 npm，无法安装依赖'
    SETUP_HINT='Node.js 一般自带 npm。若你是用系统包管理器装的 node，可能需要单独安装 <code>npm</code>。'
    return 1
  fi
  say '首次运行：安装 Node 依赖（需要联网，通常 1~3 分钟）'
  for d in $NEED; do
    say "  npm install → ${d#$ROOT/}"
    if [ -n "$NPM_REGISTRY" ]; then
      ( cd "$d" && npm install --no-audit --no-fund --omit=dev --registry "$NPM_REGISTRY" ) || return 1
    else
      ( cd "$d" && npm install --no-audit --no-fund --omit=dev ) || return 1
    fi
  done
  return 0
}

# ---------- 子进程 ----------
MCP_PIDS=''
# 四个服务对接参数的方式不一样，别混用：
#   image_task / video_task / web_search → 认 --http --host --port
#   mcp_asr                              → 只认 PORT 环境变量（它的 argv 不解析）
start_mcp_flags() {
  dir=$1; mport=$2; tag=$3; shift 3
  ( cd "$ROOT/mcp/$dir" && exec node "$@" --host "$HOST_ADDR" --port "$mport" >>"$RUNTIME/mcp-$tag.log" 2>&1 ) &
  MCP_PIDS="$MCP_PIDS $!"
}

start_mcp_env() {
  dir=$1; mport=$2; tag=$3; shift 3
  ( cd "$ROOT/mcp/$dir" && exec env PORT="$mport" node "$@" >>"$RUNTIME/mcp-$tag.log" 2>&1 ) &
  MCP_PIDS="$MCP_PIDS $!"
}

CORE_PID=''
STOPPING=0

kill_tree() {
  pid=$1
  [ -n "$pid" ] || return 0
  if command -v pgrep >/dev/null 2>&1; then
    for c in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$c"; done
  fi
  kill "$pid" 2>/dev/null || true
}

do_cleanup() {
  for p in $CORE_PID $MCP_PIDS; do kill_tree "$p"; done
  CORE_PID=''
  MCP_PIDS=''
}

on_signal() { STOPPING=1; }
trap 'on_signal' INT TERM HUP
trap 'do_cleanup' EXIT

health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "http://$HOST_ADDR:$PORT/api/health" >/dev/null 2>&1
  else
    node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$PORT" >/dev/null 2>&1
  fi
}

port_open() {
  node -e 'const s=require("net").connect(Number(process.argv[1]),"127.0.0.1");s.setTimeout(800);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.on("timeout",()=>{s.destroy();process.exit(1)})' "$1" >/dev/null 2>&1
}

# MCP 起不来是静默降级（core 只会发现不到工具），所以启动后主动点名报告。
check_mcp() {
  if ! port_open "$1"; then
    warn "MCP $2 没起来（端口 $1）——日志：local/.runtime/mcp-$2.log"
  fi
}

start_core() {
  ( cd "$ROOT/app" && exec env \
      PORT="$PORT" \
      HOST="$HOST_ADDR" \
      AGENT_CONFIG="$CONFIG" \
      AGENT_FILE_SCOPE=workspace \
      ASR_URL="$ASR_URL" \
      PYTHONPATH="$ROOT/skills/deps" \
      node server/server.js >>"$LOG" 2>&1 ) &
  CORE_PID=$!
}

open_browser() {
  url="http://$HOST_ADDR:$PORT"
  if command -v open >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

# ============ 主流程 ============
if [ "$NODE_OK" != 1 ]; then
  setup_head '启动前自检未通过' "没有找到可用的 Node.js 20+，服务起不来。按下面提示装好后，重新执行 <code>./local/start.sh</code>。"
  setup_rows
  setup_close
  exit 1
fi

if [ "$PORT_FREE" != 1 ]; then
  setup_head '端口被占用' "端口 $PORT 上已经有程序在监听。关掉它，或者换个端口启动：<code>PORT=8091 ./local/start.sh</code>（记得把设置页里的访问地址一起改）。"
  setup_rows
  setup_close
  exit 1
fi

if [ ! -f "$CONFIG" ]; then
  say '首次运行：需要选一个 AI 的工作目录'
  WS=$(choose_workspace)
  generate_config "$WS"
else
  say "使用已有配置：$CONFIG"
fi

if ! ensure_deps; then
  setup_head "${SETUP_TITLE:-依赖安装失败}" "${SETUP_HINT:-安装 <code>app/</code> 的 Node 依赖时出错了，多半是网络问题。}"
  setup_rows
  setup_close
  printf '\n最近日志：\n'
  tail -n 20 "$LOG" 2>/dev/null || true
  exit 1
fi

link_skills

# 语音：ffmpeg 在就启用（ASR_URL 由 core 直接读 env，不是配置），不在就不给入口。
if [ "$FF_OK" = 1 ]; then ASR_URL="http://$HOST_ADDR:$MCP_ASR_PORT"; else ASR_URL=''; fi

say '启动 MCP 服务…'
start_mcp_flags web_search "$MCP_WEB_PORT" web   server.js --http
start_mcp_flags image_task "$MCP_IMAGE_PORT" image src/mcp-server.js --http
start_mcp_flags video_task "$MCP_VIDEO_PORT" video src/mcp-server.js --http
start_mcp_env   asr        "$MCP_ASR_PORT"   asr   src/server.js

say "启动 agent-core（$HOST_ADDR:$PORT）…"
FIRST=1
FAILS=0
while :; do
  start_core

  i=0
  while [ "$i" -lt 60 ]; do
    health && break
    kill -0 "$CORE_PID" 2>/dev/null || break
    sleep 1
    i=$((i + 1))
  done

  if health; then
    if [ "$FIRST" = 1 ]; then
      FIRST=0
      open_browser
      printf '\n'
      say "已启动：http://$HOST_ADDR:$PORT"
      sleep 1
      check_mcp "$MCP_WEB_PORT" web
      check_mcp "$MCP_IMAGE_PORT" image
      check_mcp "$MCP_VIDEO_PORT" video
      check_mcp "$MCP_ASR_PORT" asr
      if [ "$FF_OK" = 1 ]; then
        say '语音：可用（ffmpeg 已就绪；还需在设置页给 asr 填上游地址与模型）'
      else
        say '语音：不可用（未安装 ffmpeg，麦克风入口会自动隐藏）'
      fi
      if [ "$PY_OK" = 1 ]; then
        say '技能：已启用（python3 就绪）'
      else
        say '技能：已关闭（未安装 python3；装好后重跑本脚本即可）'
      fi
      printf '\n首次使用：左下角「用户区」→ 设置 → 模型池，添加平台和 API Key，然后点「重启」。\n'
      printf '关闭：在本终端按 Ctrl-C（会一起停掉子进程）。\n\n'
    fi
  else
    warn 'agent-core 没能起来，最近日志：'
    tail -n 30 "$LOG" 2>/dev/null || true
    kill_tree "$CORE_PID"
    CORE_PID=''
    exit 1
  fi

  wait "$CORE_PID" 2>/dev/null
  code=$?
  [ "$STOPPING" = 1 ] && break
  # 设置页的「重启」就是 exit 0；非 0 = 崩溃。连续崩 5 次就停下来别刷屏（典型是配置写坏了）。
  if [ "$code" = 0 ]; then FAILS=0; else FAILS=$((FAILS + 1)); fi
  if [ "$FAILS" -ge 5 ]; then
    warn "agent-core 连续 $FAILS 次异常退出，不再自动重启。最近日志："
    tail -n 30 "$LOG" 2>/dev/null || true
    exit 1
  fi
  warn 'agent-core 已退出，1 秒后自动拉起（设置页点「重启」走的也是这条路）'
  sleep 1
 done

say '已停止。'
