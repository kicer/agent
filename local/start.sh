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
NPM_LOG="$RUNTIME/npm-install.log"

PORT="${PORT:-8090}"
HOST_ADDR="127.0.0.1"
NPM_REGISTRY="${NPM_REGISTRY:-}"

# 依赖缓存：装成功后把 node_modules 打一张 tarball 存这里，重启 / 换 clone / 删 node_modules
# 都能直接解压恢复，完全不走网络。放用户缓存目录（而不是仓库里）是为了多个 clone 共享；
# 卸载时删这一个目录就行（README 有写）。
LOCAL_CACHE="${AGENT_LOCAL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/agent-local}"
REGISTRY_CACHE="$RUNTIME/registry"
# npm 源候选。并行探测、挑最快的，所以国内会选 npmmirror、海外会选官方，不用用户干预。
REGISTRY_CANDIDATES='https://registry.npmmirror.com https://registry.npmjs.org'

# 四个同栈 MCP 服务在服务器上是各自独立的容器，都监听 3000 也不冲突；
# 本地挤在同一台机器上，必须各占一个端口。默认紧跟 core 的 8090 往后排，
# 所以 core 换端口时（PORT=xxx）要留意别撞上这四个——下面有冲突检查。
MCP_WEB_PORT="${MCP_WEB_PORT:-8091}"
MCP_IMAGE_PORT="${MCP_IMAGE_PORT:-8092}"
MCP_VIDEO_PORT="${MCP_VIDEO_PORT:-8093}"
MCP_ASR_PORT="${MCP_ASR_PORT:-8094}"

# core 与 MCP 抢同一个端口时，后起的那个会 bind 失败、被 start.sh 静默降级成
# 「能力缺失」，排查成本很高。这里直接拒绝启动。
PORT_COLLIDE=0
for p in "$MCP_WEB_PORT" "$MCP_IMAGE_PORT" "$MCP_VIDEO_PORT" "$MCP_ASR_PORT"; do
  [ "$p" = "$PORT" ] && PORT_COLLIDE=1
done

mkdir -p "$RUNTIME" "$ROOT/data"
printf '\n==== %s 启动 ====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"

if [ -t 1 ]; then
  C='\033[1;32m'; Y='\033[1;33m'; N='\033[0m'
  # 终端窗口标题：开着一堆窗口时能一眼认出哪个是它（也是「怎么停」的钥匙）。
  printf '\033]0;Agent 本地端 :%s\007' "$PORT"
else
  C=''; Y=''; N=''
fi
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
  Darwin) NODE_HINT='brew install node@20，或到 nodejs.org 下载 macOS 安装包';;
  *)      NODE_HINT='用 nvm 安装（nvm install 20），或发行版包管理器装 nodejs 20+';;
esac

# ---------- 自检页（纯静态，无 node 也能打开） ----------
# 失败时会用浏览器打开它。浏览器里的标签页只有页面自己给的标题，所以每页都带应用名
# （否则用户开着一堆标签，根本不知道这窗口是谁弹的）+ 仓库/日志路径 + 失败日志尾部。
esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
html_escape() { printf '%s' "$1" | esc; }

open_target() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

# ---------- 状态页 ----------
# 不需要常驻 HTTP 服务：脚本把状态写进 $RUNTIME/ui/ 下的文件，ui_render 拼成整页，
# 页面靠 <meta http-equiv="refresh"> 每秒重读。这样「连 node 都没装」时也能打开。
# 长步骤（npm install / 起 core）另起一个心跳子进程每秒重绘，日志尾巴也就跟着动了。
#
# 状态全部落文件而不是留在 shell 变量里：心跳子进程拿到的是 fork 时的快照，用变量会越刷越旧。
#   ui/title     页面大标题（一行）
#   ui/steps     追加的步骤行（<tr>）
#   ui/busy      进行中的步骤：第一行文案、第二行开始时间戳
#   ui/logpath   当前步骤要展示尾巴的日志文件
#   ui/redirect  成功后自动跳转的地址
#   ui/error     失败说明（HTML 片段）
UI_DIR="$RUNTIME/ui"
UI_OPEN=0
# 状态页是否已经开过一次。ui_init 开了就不在 ui_fail 里再开一个（同一个页面两个标签，用户会懵）。
UI_OPENED=0
TICKER_PID=''

esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
html_escape() { printf '%s' "$1" | esc; }

open_target() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

# 默认 macOS 自动弹出（桌面端就该这样）；Linux 服务器上不乱开窗口，需要时 AGENT_LOCAL_UI=1。
ui_should_open() {
  case "${AGENT_LOCAL_UI:-auto}" in
    0|off|no) return 1;;
    1|on|yes) return 0;;
  esac
  [ "$(uname -s)" = 'Darwin' ]
}

ui_init() {
  rm -rf "$UI_DIR"
  mkdir -p "$UI_DIR"
  : > "$UI_DIR/steps"
  printf '启动中\n' > "$UI_DIR/title"
  ui_render
  if ui_should_open; then
    UI_OPEN=1
    UI_OPENED=1
    open_target "$RUNTIME/status.html"
  fi
}

# 无状态渲染：所有内容都从文件读，所以心跳子进程也能安全调。
# 先写临时文件再 mv：浏览器可能正好在刷新，不能让它读到半截 HTML。
# 临时文件名必须每次不同：$$ 在子 shell 里仍是主 shell 的 PID（POSIX），
# 心跳与主流程同时渲染时会撞车（mv 报 No such file）。
ui_render() {
  tmp=$(mktemp "$RUNTIME/.status.XXXXXX" 2>/dev/null) || tmp="$RUNTIME/status.html.$$.tmp"
  {
    printf '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">\n'
    printf '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    if [ -s "$UI_DIR/redirect" ]; then
      # 后续启动：2 秒后自动进应用（同一个标签页，不再多开一个窗）
      printf '<meta http-equiv="refresh" content="2;url=%s">\n' "$(cat "$UI_DIR/redirect")"
    elif [ -s "$UI_DIR/ready" ]; then
      # 首次安装：就停在这一页，不自动跳（也不刷新），等用户点链接
      printf '\n'
    else
      printf '<meta http-equiv="refresh" content="1">\n'
    fi
    printf '<title>Agent 本地端 - %s</title>\n' "$(cat "$UI_DIR/title" 2>/dev/null)"
    cat <<'CSS'
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:44px 22px;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#20242a}
main{max-width:820px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 30px;box-shadow:0 2px 14px rgba(0,0,0,.07)}
.brand{margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#8a93a0}
h1{font-size:20px;margin:0 0 6px}
.meta{margin:0 0 18px;color:#6b7480;font-size:12.5px;word-break:break-all}
.hint{margin:0 0 18px;color:#4a5563}
h2{font-size:13px;margin:22px 0 8px;color:#4a5563}
pre{margin:0;padding:12px 14px;background:#f6f7f9;border:1px solid #eceef1;border-radius:8px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:8px 10px;border-bottom:1px solid #eceef1;vertical-align:top}
td:first-child{width:52px;white-space:nowrap;font:600 12px/1.8 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em}
.s-ok{color:#1a7f37}
.s-bad{color:#c0392b}
.s-warn{color:#9a6700}
.s-run{color:#6b7480}
.busy{margin:18px 0 0;font-weight:600}
code{background:#f0f2f5;border-radius:5px;padding:1px 5px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-user-select:all;user-select:all}
.open{display:inline-block;margin:0 10px 0 0;padding:10px 18px;background:#1f6feb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}
.open:hover{background:#1a5fd0}
.addr{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:#6b7480;-webkit-user-select:all;user-select:all}
a{color:#0b62d6}
.note{margin:20px 0 0;padding-top:16px;border-top:1px solid #eceef1;color:#4a5563;font-size:14px}
.tip{margin:16px 0 0;color:#6b7480;font-size:13px}
@media (prefers-color-scheme:dark){
  body{background:#16181d;color:#e6e8eb}
  main{background:#1d2026;box-shadow:none}
  .meta,.hint,.note,.tip,h2{color:#a8b1bd}
  td{border-color:#2b3038}
  code{background:#2a2f38}
  pre{background:#111318;border-color:#2b3038;color:#c9d1d9}
}
</style>
CSS
    printf '</head><body><main>\n'
    printf '<p class="brand">Agent 本地端 / local/start.sh</p>\n'
    printf '<h1>%s</h1>\n' "$(cat "$UI_DIR/title" 2>/dev/null)"
    printf '<p class="meta">仓库 <code>%s</code><br>日志目录 <code>%s</code></p>\n' \
      "$(html_escape "$ROOT")" "$(html_escape "$RUNTIME")"
    cat "$UI_DIR/error" 2>/dev/null
    if [ -s "$UI_DIR/steps" ]; then
      printf '<table><tbody>\n'
      cat "$UI_DIR/steps"
      printf '</tbody></table>\n'
    fi
    if [ -f "$UI_DIR/busy" ]; then
      bmsg=$(sed -n 1p "$UI_DIR/busy")
      bsince=$(sed -n 2p "$UI_DIR/busy")
      case "$bsince" in ''|*[!0-9]*) bsince=$(date +%s);; esac
      printf '<p class="busy">进行中：%s（已 %s 秒）</p>\n' \
        "$(html_escape "$bmsg")" "$(( $(date +%s) - bsince ))"
    fi
    # 日志尾巴：进行中和失败时都要。注意不能放在上面的 busy 分支里——
    # ui_fail 会先清掉 busy，放里面的话失败页反而看不到日志。
    if [ -f "$UI_DIR/busy" ] || [ -f "$UI_DIR/error" ]; then
      if [ -f "$UI_DIR/error" ]; then log_lines=40; log_title='日志（末尾 40 行）'
      else log_lines=20; log_title='实时输出（末尾 20 行）'; fi
      lf=$(cat "$UI_DIR/logpath" 2>/dev/null)
      if [ -n "$lf" ] && [ -f "$lf" ]; then
        printf '<h2>%s</h2><pre>' "$log_title"
        tail -n "$log_lines" "$lf" 2>/dev/null | esc
        printf '</pre>\n'
      fi
    fi
    # 首次安装的「下一步」提示（ui_done 写）
    cat "$UI_DIR/note" 2>/dev/null
    if [ -f "$UI_DIR/error" ]; then
      printf '<p class="note">修好后重新执行 <code>./local/start.sh</code>。日志都放在上面的日志目录里（<code>core.log</code>、<code>npm-install.log</code>、<code>mcp-*.log</code>）。</p>\n'
    elif [ -s "$UI_DIR/redirect" ] || [ -s "$UI_DIR/ready" ]; then
      url=$(cat "$UI_DIR/redirect" 2>/dev/null)
      [ -n "$url" ] || url=$(cat "$UI_DIR/ready")
      # 后续启动：会自己跳；首次安装：只停在这页等点击。两种情况都留一个按钮兜底。
      if [ -s "$UI_DIR/redirect" ]; then
        printf '<p class="note">2 秒后自动打开应用；没反应就点下面的按钮。</p>\n'
      fi
      printf '<p class="note"><a class="open" href="%s">打开应用</a> <span class="addr">%s</span></p>\n' "$url" "$url"
      printf '<p class="tip">停止服务：运行 <code>./local/stop.sh</code>（关掉这个页面不影响服务）。</p>\n'
    else
      printf '<p class="tip">本页每秒自动刷新，进度会自己出现。</p>\n'
    fi
    printf '</main></body></html>\n'
  } > "$tmp" && mv -f "$tmp" "$RUNTIME/status.html"
  rm -f "$tmp"
}

ui_title() { printf '%s\n' "$1" > "$UI_DIR/title"; ui_render; }

# 步骤标记只用 ASCII（OK / .. / ! / X），别搞花哨符号。
ui_step() {
  # $1 文字  $2 ok|run|warn|bad
  case "$2" in
    ok)   m='OK';;
    warn) m='!';;
    bad)  m='X';;
    *)    m='..';;
  esac
  printf '<tr><td class="s-%s">%s</td><td>%s</td></tr>\n' "${2:-run}" "$m" "$(html_escape "$1")" >> "$UI_DIR/steps"
  ui_render
}

# 标记一个「正在进行」的步骤：会开一个每秒重绘的心跳，把计时和日志尾巴刷新出来。
ui_busy() {
  # $1 文案  $2 日志文件（可选）
  ui_stop_ticker
  printf '%s\n%s\n' "$1" "$(date +%s)" > "$UI_DIR/busy"
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" > "$UI_DIR/logpath"; else : > "$UI_DIR/logpath"; fi
  ui_render
  if [ "$UI_OPEN" = 1 ]; then
    ( while [ -f "$UI_DIR/busy" ]; do sleep 1; ui_render; done ) &
    TICKER_PID=$!
  fi
}

# 只换「进行中」的文案，保留开始时间：换源重试时计时不该归零（否则看起来像卡死后重来）。
ui_busy_relabel() {
  if [ ! -f "$UI_DIR/busy" ]; then ui_busy "$1" "${2:-}"; return 0; fi
  bsince=$(sed -n 2p "$UI_DIR/busy" 2>/dev/null)
  case "${bsince:-}" in ''|*[!0-9]*) bsince=$(date +%s);; esac
  printf '%s\n%s\n' "$1" "$bsince" > "$UI_DIR/busy"
  [ -n "${2:-}" ] && printf '%s\n' "$2" > "$UI_DIR/logpath"
  ui_render
}

# 必须显式收掉并清空 PID：心跳在 busy 文件消失后自己退出，但变量还留着旧的 PID，
# 下一个步骤就不会再起心跳（页面会永远停在「已 0 秒」）。
ui_stop_ticker() {
  [ -n "$TICKER_PID" ] && kill "$TICKER_PID" 2>/dev/null
  TICKER_PID=''
}

ui_idle() { ui_stop_ticker; rm -f "$UI_DIR/busy"; ui_render; }

ui_done() {
  # $1 应用地址  $2 auto|click（首次安装用 click：给链接让用户自己点，不自动跳）
  ui_stop_ticker
  rm -f "$UI_DIR/busy" "$UI_DIR/error" "$UI_DIR/redirect" "$UI_DIR/ready" "$UI_DIR/note"
  printf '%s\n' "${1:-}" > "$UI_DIR/ready"
  if [ "${2:-auto}" = 'auto' ]; then
    printf '%s\n' "${1:-}" > "$UI_DIR/redirect"
  else
    # 首次安装用户就停在这页，那下一步怎么配模型也得写在页上，不能只在终端里。
    printf '<p class="hint">首次使用：进去后点左下角「用户区」→ 设置 → 模型池，添加平台和 API Key，再点「重启」（服务会自动拉起来）。</p>\n' > "$UI_DIR/note"
  fi
  ui_title '已启动'
}

ui_fail() {
  # $1 标题  $2 说明（HTML）  $3 日志文件（可选）
  ui_stop_ticker
  rm -f "$UI_DIR/busy" "$UI_DIR/redirect"
  printf '%s\n' "$1" > "$UI_DIR/title"
  printf '<p class="hint">%s</p>\n' "$2" > "$UI_DIR/error"
  [ -n "${3:-}" ] && printf '%s\n' "$3" > "$UI_DIR/logpath"
  ui_render
  # 失败一定要让人看到：本次还没弹过就补开一次（Linux 上 ui_init 默认不开，失败也要能看见）。
  if [ "$UI_OPENED" != 1 ]; then
    UI_OPENED=1
    open_target "$RUNTIME/status.html"
  fi
  printf '\n状态页：%s\n' "$RUNTIME/status.html"
}

ui_checks() {
  if [ "$NODE_OK" = 1 ]; then ui_step "Node.js ${NODE_VER}（需要 20+）" ok
  else ui_step "Node.js 缺失或版本过低：$NODE_HINT" bad; fi
  if [ "$NPM_OK" = 1 ]; then ui_step 'npm 可用（装依赖用）' ok
  else ui_step 'npm 缺失：随 Node.js 一起装，重装 Node 即可' bad; fi
  if [ "$PY_OK" = 1 ]; then ui_step "python3 ${PY_VER}（技能可用）" ok
  else ui_step 'python3 未安装（可选，技能清单为空）' warn; fi
  if [ "$FF_OK" = 1 ]; then ui_step "ffmpeg ${FF_VER}（语音可用）" ok
  else ui_step 'ffmpeg 未安装（可选，麦克风入口隐藏）' warn; fi
  if [ "$PORT_FREE" = 1 ]; then ui_step "端口 $PORT 可用" ok
  else ui_step "端口 $PORT 已被占用（换 PORT=8099）" bad; fi
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
# 不再像服务器那样被限制在单个会话子目录里。路径一律加引号：用户选的目录带空格/':'/'#' 时
# 不加引号会被 YAML 当成注释或键值分隔符。
workspace_root: "$ws"
data_root: "$ROOT/data"
skills:
  # 指向 local/.runtime/skills：启动脚本按「有没有可用的 python3」把它软链到真技能目录或空目录。
  # 这样装不装 python3 都不用改这份配置（改完重跑脚本即生效）。
  skills_root: "$ROOT/local/.runtime/skills"
# 故意留空：启动后在设置页添加平台与 API Key，再点「重启」——启动器会自动拉起。
platforms: []
log_level: info
mcp_servers:
  # 四个同栈 MCP 都在本机跑（零依赖 Node），端口由启动器分配（默认 8091~8094），别和上面的 PORT 撞。
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

# 依赖是否装全：0 = 齐全，非 0 = 缺（npm install 中途失败、被手工删过等）。
# 为什么不用 require.resolve：mcp/image_task 依赖 @modelcontextprotocol/sdk 这类纯 ESM 包，
# 它的 exports.require 指向的文件在发布包里并不存在（只有 import 能解析），
# require.resolve 会误判成「没装」，于是每次启动都重装一遍。
# 改为看 node_modules/<dep>/package.json 在不在：能拦住「目录建了但内容没解开」的半成品。
deps_resolvable() {
  node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[2];
    const pkg = require(path.resolve(process.argv[1]));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (!fs.existsSync(path.join(dir, "node_modules", dep, "package.json"))) process.exit(1);
    }
  ' "$1/package.json" "$1" >/dev/null 2>&1
}

# ---------- npm 源：自动探测 ----------
# 国内直连 registry.npmjs.org 经常几十秒超时，而 npm 自己不会换源。用户不该被要求懂这些，
# 所以装之前并行探一次候选源、挑最快的，结果缓存一天。
# 约束：只通过命令行参数传源，绝不写 ~/.npmrc —— 不为了装依赖改用户的全局配置。
probe_registry() {
  node -e '
    const ctl = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
    const probe = async (r) => {
      const t0 = Date.now();
      try { await fetch(r + "/-/ping", { signal: ctl(3000) }); return { r, ms: Date.now() - t0 }; }
      catch { return null; }
    };
    Promise.all(process.argv.slice(1).map(probe)).then((rs) => {
      const ok = rs.filter(Boolean).sort((a, b) => a.ms - b.ms);
      if (!ok.length) process.exit(1);
      process.stdout.write(ok[0].r);
    });
  ' $REGISTRY_CANDIDATES
}

registry_cached() {
  [ -f "$REGISTRY_CACHE" ] || return 1
  reg=$(sed -n 1p "$REGISTRY_CACHE" 2>/dev/null)
  ts=$(sed -n 2p "$REGISTRY_CACHE" 2>/dev/null)
  [ -n "${reg:-}" ] || return 1
  case "${ts:-}" in ''|*[!0-9]*) return 1;; esac
  [ $(( $(date +%s) - ts )) -lt 86400 ] || return 1
  printf '%s' "$reg"
}

registry_remember() {
  { printf '%s\n' "$1"; date +%s; } > "$REGISTRY_CACHE" 2>/dev/null || true
}

short_reg() { printf '%s' "${1#https://}" | sed -e 's|/$||'; }

# 选出要用的源；返回 1 = 一个都连不上。
pick_registry() {
  # 用户显式指定的源优先级最高
  if [ -n "$NPM_REGISTRY" ]; then printf '%s' "$NPM_REGISTRY"; return 0; fi
  # 有代理时探针不可信（node 的 fetch 不走 env 代理，npm 会走），交给 npm 自己
  if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}${ALL_PROXY:-}" ]; then
    printf '%s' "$(npm config get registry 2>/dev/null || printf '')"
    return 0
  fi
  # npm 全局配置里显式改过源（公司私有源）→ 尊重它，不覆盖
  cfg=$(npm config get registry 2>/dev/null || printf '')
  case "$cfg" in
    ''|https://registry.npmjs.org|https://registry.npmjs.org/) : ;;
    *) printf '%s' "$cfg"; return 0 ;;
  esac
  cached=$(registry_cached) && { printf '%s' "$cached"; return 0; }
  reg=$(probe_registry) || return 1
  [ -n "${reg:-}" ] || return 1
  registry_remember "$reg"
  printf '%s' "$reg"
}

# ---------- 依赖缓存 ----------
# 装成功之后把 node_modules 打一张 tarball 放到用户缓存目录：重启、删 node_modules、
# 换一个 clone 都直接解压恢复，完全不走网络。文件名带平台 / 架构 / Node ABI /
# 依赖清单哈希 —— 原生模块（better-sqlite3 的 .node）与 ABI 绑定，不能混用。
cache_key() {
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const h = crypto.createHash("sha256");
    for (const f of process.argv.slice(1)) { try { h.update(fs.readFileSync(f)); } catch {} }
    process.stdout.write(h.digest("hex").slice(0, 16));
  ' "$ROOT/app/package.json" "$ROOT/app/package-lock.json" "$ROOT"/mcp/*/package.json
}

cache_file() {
  abi=$(node -p 'process.versions.modules' 2>/dev/null || printf '0')
  printf '%s/deps-%s-%s-abi%s-%s.tgz' "$LOCAL_CACHE" \
    "$(uname -s | tr 'A-Z' 'a-z')" "$(uname -m)" "$abi" "$(cache_key)"
}

# 有依赖并且已经装好的目录（相对仓库根 + /node_modules），打包缓存用它。
cache_dirs() {
  for d in "$ROOT/app" "$ROOT"/mcp/*/; do
    [ -f "$d/package.json" ] || continue
    [ -d "$d/node_modules" ] || continue
    node -e 'process.exit(Object.keys(require(process.argv[1]).dependencies||{}).length?0:1)' "$d/package.json" >/dev/null 2>&1 || continue
    rel=${d#"$ROOT"/}; rel=${rel%/}
    printf '%s\n' "$rel/node_modules"
  done
}

# 需要安装的目录（每行一个，容忍路径里有空格）。
# 不能只看 node_modules 在不在：npm install 中途失败会留下「目录在、包不全」的半成品，
# 按「存在即已装」判断就会永远跳过安装，core 起来立刻 require 失败。
need_dirs() {
  for d in "$ROOT/app" "$ROOT"/mcp/*/; do
    [ -f "$d/package.json" ] || continue
    node -e 'process.exit(Object.keys(require(process.argv[1]).dependencies||{}).length?0:1)' "$d/package.json" >/dev/null 2>&1 || continue
    if [ ! -d "$d/node_modules" ] || [ ! -f "$d/node_modules/.agent-installed" ] \
       || [ "$d/package.json" -nt "$d/node_modules/.agent-installed" ] \
       || ! deps_resolvable "$d"; then
      printf '%s\n' "$d"
    fi
  done
}

cache_restore() {
  f=$(cache_file)
  [ -f "$f" ] || return 1
  say "使用本地依赖缓存：$f"
  ui_busy_relabel '恢复本地依赖缓存（不走网络）'
  if ! tar -xzf "$f" -C "$ROOT" >>"$NPM_LOG" 2>&1; then
    warn '缓存解压失败，改为联网安装'
    return 1
  fi
  return 0
}

cache_save() {
  list=$(cache_dirs)
  [ -n "$list" ] || return 0
  mkdir -p "$LOCAL_CACHE" 2>/dev/null || return 0
  f=$(cache_file)
  tmp="$f.part"
  # tar 里的路径相对仓库根，解压时 -C "$ROOT" 就能还原
  if printf '%s\n' "$list" | tar -czf "$tmp" -C "$ROOT" -T - >/dev/null 2>&1; then
    mv -f "$tmp" "$f" 2>/dev/null || rm -f "$tmp"
    # 只留最近 3 份：每次依赖变化都会产生新文件，不清理会一直涨
    ls -t "$LOCAL_CACHE"/deps-*.tgz 2>/dev/null | tail -n +4 | while IFS= read -r old; do rm -f "$old"; done
    say "依赖缓存：$f"
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
}

# ---------- 依赖安装 ----------
# 跑一次 npm install（输出落日志），带看门狗。
# npm 10 + Node 22 在网络失败时既不退出也不报错（已知的 "Exit handler never called"）：
# 没有超时用户就会干等到崩溃。超过上限就杀掉，交给外层换源重试。
NPM_TIMEOUT="${AGENT_LOCAL_NPM_TIMEOUT:-240}"
npm_install_into() {
  _dir=$1; _reg=$2
  ( cd "$_dir" && npm install --no-audit --no-fund --omit=dev \
      --registry "$_reg" --replace-registry-host=always \
      --fetch-retries=2 --fetch-timeout=20000 --prefer-offline ) >>"$NPM_LOG" 2>&1 &
  _pid=$!
  _waited=0
  NPM_TIMED_OUT=0
  while kill -0 "$_pid" 2>/dev/null; do
    if [ "$_waited" -ge "$NPM_TIMEOUT" ]; then
      warn "npm ${NPM_TIMEOUT} 秒没有响应，结束它并换源重试"
      # 直接 KILL：npm 卡死时不理 TERM；kill_tree_hard 先递归子进程再杀自己，
      # 不会像「先 TERM 后 KILL」那样把 npm 变成孤儿（PPID=1）漏在外面。
      NPM_TIMED_OUT=1
      kill_tree_hard "$_pid"
      break
    fi
    sleep 2
    _waited=$((_waited + 2))
    # 前台模式下给个心跳，否则长时间没输出像是卡死了
    if [ $((_waited % 20)) -eq 0 ]; then printf '    ... %s 秒\n' "$_waited"; fi
  done
  wait "$_pid" 2>/dev/null
}

# 不只 app：mcp/image_task 与 mcp/video_task 也带 npm 依赖（@modelcontextprotocol/sdk + express），
# 服务器上这些是镜像构建时装好的，本地得自己装。asr / web_search 是零依赖，自动跳过。
ensure_deps() {
  if ! need_dirs | grep -q .; then
    ui_step 'Node 依赖已就绪（无需安装）' ok
    return 0
  fi
  if [ "$NPM_OK" != 1 ]; then
    SETUP_TITLE='缺少 npm，无法安装依赖'
    SETUP_HINT='Node.js 一般自带 npm。若你是用系统包管理器装的 node，可能需要单独安装 <code>npm</code>。'
    return 1
  fi
  : > "$NPM_LOG"

  # 1) 本地缓存：装过一次后，重启 / 删 node_modules / 换 clone 都是解压，秒级且零网络
  if cache_restore; then
    if ! need_dirs | grep -q .; then
      ui_idle
      ui_step 'Node 依赖已就绪（本地缓存恢复）' ok
      return 0
    fi
    warn '缓存不完整，剩下的改为联网安装'
  fi

  # 2) 选源。一个都连不上就别让 npm 重试三次刷屏，直接给结论。
  reg=$(pick_registry) || reg=''
  if [ -z "$reg" ]; then
    SETUP_TITLE='连不上任何 npm 源'
    SETUP_HINT="npmmirror 与官方源都连不上，安装没法进行。检查代理 / VPN 后重跑；或在有网络的机器上装好，把缓存目录拷过来：<code>$(html_escape "$LOCAL_CACHE")</code>。"
    return 1
  fi
  # 什么情况不自动换源：用户显式指定了源，或用的是公司私有源（乱兜底到公网可能装错东西）。
  # 用公共源（npmmirror / 官方）时换源重试是安全的，也是国内环境最需要的。
  allow_fallback=0
  case "$reg" in
    *registry.npmmirror.com*|*registry.npmjs.org*) allow_fallback=1 ;;
  esac
  [ -n "$NPM_REGISTRY" ] && allow_fallback=0
  REG_TRY="$reg"
  if [ "$allow_fallback" = 1 ]; then
    for c in $REGISTRY_CANDIDATES; do
      [ "$c" = "$reg" ] || REG_TRY="$REG_TRY $c"
    done
  fi
  ntry=0
  for t in $REG_TRY; do ntry=$((ntry + 1)); done

  say "安装 Node 依赖（源：$(short_reg "$reg")，通常 1~3 分钟；已装好的目录会跳过）"
  # 长步骤：页面上会持续显示已用秒数 + npm 输出的尾巴（心跳每秒重绘）。
  ui_busy '安装 Node 依赖' "$NPM_LOG"
  ui_step "依赖源：$(short_reg "$reg")" ok
  TRIED_REGS=''
  ndir=0
  need_dirs > "$RUNTIME/needs.txt"
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    ndir=$((ndir + 1))
    drel=${d#"$ROOT"/}; drel=${drel%/}
    installed=0
    i=0
    for try_reg in $REG_TRY; do
      i=$((i + 1))
      say "  npm install → ${drel}（$(short_reg "$try_reg")，第 $i/$ntry 次）"
      ui_busy_relabel "安装依赖：${drel}（$(short_reg "$try_reg")，第 $i/$ntry 次）" "$NPM_LOG"
      # 上一轮失败会留下半成品，不清掉重试大概率还是失败
      [ "$i" -gt 1 ] && rm -rf "$d/node_modules"
      npm_install_into "$d" "$try_reg"
      TRIED_REGS="$TRIED_REGS $try_reg"
      if deps_resolvable "$d"; then
        installed=1
        # 换源成功就记住它，下次不用再探测
        [ -n "$NPM_REGISTRY" ] || registry_remember "$try_reg"
        break
      fi
    done
    if [ "$installed" != 1 ]; then
      install_failed "$drel"
      return 1
    fi
    # 打时间戳：npm 在「已经是最新」时不会更新 node_modules 的 mtime，
    # 只看目录 mtime 会导致每次启动都白跑一次 install。
    touch "$d/node_modules/.agent-installed"
  done < "$RUNTIME/needs.txt"
  ui_idle
  ui_step "Node 依赖已装好（$ndir 个目录）" ok
  cache_save
  return 0
}

# 把 npm 的输出翻译成一句人话：用户不该去读 gyp / ETIMEDOUT 这些字眼。
# 原文仍然完整落在 npm-install.log，状态页只在尾巴里展示。
npm_hint() {
  tail -n 300 "$NPM_LOG" 2>/dev/null > "$RUNTIME/npm-tail.txt"
  if grep -qiE 'gyp ERR!|xcrun: error|Command Line Tools|clang: error|cannot find Python' "$RUNTIME/npm-tail.txt"; then
    printf '%s' '<b>本机缺少编译工具链</b>：某个依赖要现场编译原生模块。装一下 Xcode 命令行工具再重跑：<code>xcode-select --install</code>。'
  elif grep -qiE 'EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|Exit handler never called|CERT_|self.signed|socket hang up|network' "$RUNTIME/npm-tail.txt"; then
    printf '%s' '<b>网络没通</b>：npm 连不上源（已自动换源重试过）。多半是代理 / VPN，或公司网络拦截了 registry。'
  elif grep -qiE 'EACCES|EPERM|permission denied' "$RUNTIME/npm-tail.txt"; then
    printf '%s' '<b>没有写权限</b>：常见于以前用 <code>sudo</code> 装过依赖（目录属主变成 root）。删掉这些 <code>node_modules</code> 后重跑。'
  elif [ "${NPM_TIMED_OUT:-0}" = 1 ]; then
    printf '%s' '<b>源没有响应</b>：npm 卡住超过上限被终止（已自动换源重试）。多半是网络 / 代理 / 被墙。'
  else
    printf '%s' '依赖没有装成功，原因见下面的 npm 输出。'
  fi
}

# 安装失败时把「怎么再试」写进自检页。npm 在断网时只会吐一句
# "Exit handler never called!"（npm 10 + Node 22 的已知毛病），不提源就无从下手。
install_failed() {
  SETUP_TITLE='依赖安装失败'
  tried=''
  for t in ${TRIED_REGS:-}; do
    [ -n "$tried" ] && tried="${tried}、"
    tried="$tried<code>$(short_reg "$t" | esc)</code>"
  done
  [ -n "$tried" ] || tried='（默认配置）'
  SETUP_HINT="<code>$(printf '%s' "$1" | esc)</code>：$(npm_hint)<br>已尝试的源：${tried}。也可以自己指定：<code>NPM_REGISTRY=https://registry.npmmirror.com ./local/start.sh</code>。下面是 npm 的原始输出。"
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
  # 只用 $1，不先赋给变量：POSIX sh 没有局部变量，递归会覆盖它，回到外层时
  # kill 的就不是原本那个进程（踩过：看门狗杀了子进程，父进程和 npm 都留着）。
  [ -n "${1:-}" ] || return 0
  if command -v pgrep >/dev/null 2>&1; then
    for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  fi
  kill "$1" 2>/dev/null || true
}

# 彻底送走（SIGKILL）：npm 卡死时会忽略 TERM（就是 "Exit handler never called" 那个毛病）。
kill_tree_hard() {
  [ -n "${1:-}" ] || return 0
  if command -v pgrep >/dev/null 2>&1; then
    for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree_hard "$c"; done
  fi
  kill -KILL "$1" 2>/dev/null || true
}

do_cleanup() {
  # 心跳子进程也得收掉，不然退出后它会继续每秒重绘页面。
  ui_stop_ticker
  rm -f "$RUNTIME/ui/busy" "$RUNTIME/supervisor.pid"
  for p in $CORE_PID $MCP_PIDS; do kill_tree "$p"; done
  CORE_PID=''
  MCP_PIDS=''
}

# 收到 INT/TERM/HUP 就真停：先置标志，再主动收掉 core。
# 只置标志不够：信号可能只到了脚本（终端关窗发 HUP 就是这种），而 core 还活着，
# 启动器会卡在 wait 上不退出。kill 掉 core 才能让 wait 返回、循环看到 STOPPING 后收尾。
# 信号处理在「后台化」之后才安装：父进程 spawn 完子进程就退出，
# 如果此时已有 EXIT trap，do_cleanup 会把子进程刚写的 supervisor.pid 删掉（实测过）。

health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "http://$HOST_ADDR:$PORT/api/health" >/dev/null 2>&1
  else
    node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$PORT" >/dev/null 2>&1
  fi
}

# 是否已有启动器在跑（打印它的 pid，退出码 0/1）。
# 只看 health() 不够：core 起来要几秒（先起 MCP、装依赖可能更久），这期间再跑一次 start.sh
# 就会拉起第二个启动器；两个 core 抢同一个端口，一个 EADDRINUSE 被守护循环反复重启（实测过），
# 而 stop.sh 只认 pid 文件里那一个，等于停不干净。
# 子进程一启动就把自己的 pid 写进 supervisor.pid，所以这个判断是秒级的。
running_supervisor() {
  [ -f "$RUNTIME/supervisor.pid" ] || return 1
  spid=$(cat "$RUNTIME/supervisor.pid" 2>/dev/null) || return 1
  [ -n "$spid" ] || return 1
  kill -0 "$spid" 2>/dev/null || return 1
  # pid 可能已被系统回收给别的进程：确认它真是本脚本（命令行可能是相对路径，匹配文件名即可）。
  case "$(ps -p "$spid" -o command= 2>/dev/null || true)" in
    *start.sh*) printf '%s' "$spid"; return 0 ;;
  esac
  return 1
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
      AGENT_LOCAL_PICK=1 \
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

# ============ 后台化 ============
# start.sh 只做入口：把真正的启动器 nohup 到后台就返回，所以终端里跑完就能关窗口/做别的事。
# 停止统一走 ./local/stop.sh（或状态页上写的命令）。
#   前台模式（看实时日志、Ctrl-C 停）：AGENT_LOCAL_DETACH=0 ./local/start.sh
# AGENT_LOCAL_DETACHED 是子进程标记，防自己无限重入。
if [ "${AGENT_LOCAL_DETACH:-1}" = 1 ] && [ "${AGENT_LOCAL_DETACHED:-0}" != 1 ]; then
  if spid=$(running_supervisor); then
    say "已在运行（启动器 pid ${spid}）：http://$HOST_ADDR:$PORT"
    printf '停止：%s/stop.sh\n' "$HERE"
    exit 0
  fi
  # 启动器已经退出的残留 pid 文件：留着会误导下面这次启动，直接清掉。
  rm -f "$RUNTIME/supervisor.pid"
  if health; then
    # 端口上有 agent-core，但不是本启动器拉起的（例如手动 node server.js，或启动器被 kill -9 后的遗留）。
    # 这里不能再起一个（两个 core 抢同一端口），也不能声称"已在运行"（本次没有守护循环）。
    say "$PORT 端口上已有 agent-core 在运行（不是本启动器拉起的）"
    printf '先停掉它，再重新启动：%s/stop.sh\n' "$HERE"
    exit 0
  fi
  # node 是硬前提，且跟「选哪个目录」无关：先拦下来，别让用户白选目录、白生成一份配置。
  if [ "$NODE_OK" != 1 ]; then
    ui_init
    ui_checks
    warn '启动前自检未通过：没有找到可用的 Node.js 20+'
    printf '安装方式：%s\n' "$NODE_HINT"
    ui_fail '启动前自检未通过' '没有找到可用的 Node.js 20+，服务起不来。按下面表格里的提示装好后，重新执行 <code>./local/start.sh</code>。'
    exit 1
  fi
  # 首次运行在父进程里做完（选目录需要 tty / 弹窗），子进程只管起服务。
  first_run=0
  if [ ! -f "$CONFIG" ]; then
    say '首次运行：需要选一个 AI 的工作目录'
    WS=$(choose_workspace)
    generate_config "$WS"
    first_run=1
  fi
  nohup env AGENT_LOCAL_DETACHED=1 AGENT_LOCAL_FIRST_RUN="$first_run" "$HERE/start.sh" >>"$LOG" 2>&1 </dev/null &
  child=$!
  sleep 1
  if kill -0 "$child" 2>/dev/null; then
    printf '\n已转到后台运行（pid %s）\n' "$child"
    printf '应用：http://%s:%s\n' "$HOST_ADDR" "$PORT"
    printf '进度/日志：%s/status.html · %s\n' "$RUNTIME" "$LOG"
    printf '停止：%s/stop.sh\n' "$HERE"
    exit 0
  fi
  warn "启动失败：$(cat "$UI_DIR/title" 2>/dev/null || printf '后台进程立刻退出了')"
  # 真正的错误和日志尾巴都在状态页上（子进程的 stdout 只进日志，光 tail 日志看不到为什么）。
  printf '原因和日志：%s/status.html\n' "$RUNTIME"
  printf '后台日志：%s\n' "$LOG"
  exit 1
fi

# 把自己记下来：local/stop.sh 靠它先停启动器（只停 core 会被守护重新拉起来）。
printf '%s\n' "$$" > "$RUNTIME/supervisor.pid"

# 信号处理：收到 INT/TERM/HUP 就真停（只置标志不够，core 还活着时 wait 不会返回）。
on_signal() {
  STOPPING=1
  [ -n "$CORE_PID" ] && kill_tree "$CORE_PID"
}
trap 'on_signal' INT TERM HUP
trap 'do_cleanup' EXIT

# ============ 主流程 ============
ui_init
ui_checks

if [ "$NODE_OK" != 1 ]; then
  warn '启动前自检未通过：没有找到可用的 Node.js 20+'
  printf '安装方式：%s\n' "$NODE_HINT"
  ui_fail '启动前自检未通过' '没有找到可用的 Node.js 20+，服务起不来。按下面表格里的提示装好后，重新执行 <code>./local/start.sh</code>。'
  exit 1
fi

if [ "$PORT_COLLIDE" = 1 ]; then
  ui_fail '端口冲突' "core 要用 ${PORT}，但这四个端口被 MCP 服务占着（8091~8094）。要么换 core 端口（<code>PORT=8099 ./local/start.sh</code>），要么显式改写 MCP 端口（如 <code>MCP_WEB_PORT=8101</code>），但后者还要同步改配置里的 url。"
  exit 1
fi

if [ "$PORT_FREE" != 1 ]; then
  ui_fail '端口被占用' "端口 $PORT 上已经有程序在监听。关掉它，或者换个端口启动：<code>PORT=8099 ./local/start.sh</code>（8091~8094 留给 MCP，别占用；记得把设置页里的访问地址一起改）。"
  exit 1
fi

# 首次安装（配置是本次刚生成的）不自动跳进应用：状态页给按钮，用户自己点。
# 后台模式下这件事是父进程做完再告诉子进程的（AGENT_LOCAL_FIRST_RUN），否则子进程看到的
# 配置已经存在，会误判成「二次启动」而自动跳转。
FIRST_RUN="${AGENT_LOCAL_FIRST_RUN:-0}"
if [ ! -f "$CONFIG" ]; then
  FIRST_RUN=1
  say '首次运行：需要选一个 AI 的工作目录'
  ui_busy '请在弹出的窗口里选择 AI 的工作目录'
  WS=$(choose_workspace)
  generate_config "$WS"
  ui_idle
  ui_step "工作目录：$WS" ok
  ui_step '已生成 local/config.local.yml' ok
else
  say "使用已有配置：$CONFIG"
  ui_step '沿用已有配置 local/config.local.yml' ok
  # 配置首次生成后永不覆盖，所以 MCP 端口只存在配置里。如果它和本次要起的端口不一致
  # （改过默认值、或用了 MCP_*_PORT 覆盖），core 会发现不到工具，但只会在日志里留一条 warn。
  for pair in "web:$MCP_WEB_PORT" "image:$MCP_IMAGE_PORT" "video:$MCP_VIDEO_PORT" "asr:$MCP_ASR_PORT"; do
    tag=${pair%%:*}; mp=${pair#*:}
    grep -q "127.0.0.1:$mp" "$CONFIG" || {
      warn "配置里的 $tag MCP 端口与本次启动（${mp}）不一致，该能力将不可用；改 $CONFIG 或重新生成配置"
      ui_step "配置里 $tag MCP 端口不是 ${mp}（该能力将不可用）" warn
    }
  done
fi

if ! ensure_deps; then
  ui_fail "${SETUP_TITLE:-依赖安装失败}" "${SETUP_HINT:-安装 <code>app/</code> 的 Node 依赖时出错了，多半是网络问题。}" "$NPM_LOG"
  exit 1
fi

if link_skills; then
  if [ "$PY_OK" = 1 ]; then ui_step '技能：已启用（python3 就绪）' ok
  else ui_step '技能：已关闭（未安装 python3，装好后重跑脚本即可）' warn; fi
else
  ui_step '技能目录软链创建失败，技能不可用' warn
fi

# 语音：ffmpeg 在就启用，两条线都靠同一个开关：
#   ASR_URL 注入  → core 才挂 /api/asr、前端才显示麦克风
#   mcp_asr 子进程 → 模型的 transcribe_audio 工具（它转码依赖 ffmpeg，没有就没意义）
# 配置里的 asr 条目总是保留（配置首次生成后不覆盖），所以没 ffmpeg 时 core 会报一次
# 「asr 工具发现失败」——那是预期，不是故障。
say '启动 MCP 服务…'
ui_busy "启动 MCP 服务（${MCP_WEB_PORT}-${MCP_ASR_PORT}）"
start_mcp_flags web_search "$MCP_WEB_PORT" web   server.js --http
start_mcp_flags image_task "$MCP_IMAGE_PORT" image src/mcp-server.js --http
start_mcp_flags video_task "$MCP_VIDEO_PORT" video src/mcp-server.js --http
if [ "$FF_OK" = 1 ]; then
  ASR_URL="http://$HOST_ADDR:$MCP_ASR_PORT"
  start_mcp_env asr "$MCP_ASR_PORT" asr src/server.js
  MCP_COUNT='4 个'
else
  ASR_URL=''
  MCP_COUNT='3 个（asr 未启动：没有 ffmpeg）'
fi
ui_idle
ui_step "MCP 子进程已启动：$MCP_COUNT" ok

say "启动 agent-core（${HOST_ADDR}:${PORT}）…"
# 等 core 健康检查最多 60 秒，这期间页面一直显示「进行中 + core 日志尾巴」。
ui_busy "启动 agent-core（${HOST_ADDR}:${PORT}）" "$LOG"
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
      ui_idle
      ui_step "agent-core 已就绪：http://${HOST_ADDR}:${PORT}" ok
      check_mcp "$MCP_WEB_PORT" web
      check_mcp "$MCP_IMAGE_PORT" image
      check_mcp "$MCP_VIDEO_PORT" video
      [ "$FF_OK" = 1 ] && check_mcp "$MCP_ASR_PORT" asr
      if [ "$FIRST_RUN" = 1 ]; then
        # 首次安装：停在状态页，给一个按钮让用户自己点（先看完「首次使用」提示再进去）。
        ui_done "http://${HOST_ADDR}:${PORT}" click
        # 状态页没弹出来时（Linux / AGENT_LOCAL_UI=0）总得给个入口，否则用户什么都看不到。
        [ "$UI_OPEN" = 1 ] || open_browser
      else
        ui_done "http://${HOST_ADDR}:${PORT}" auto
        open_browser
      fi
      printf '\n'
      say "已启动：http://$HOST_ADDR:$PORT"
      sleep 1
      if [ "$FF_OK" = 1 ]; then
        say '语音：可用（ffmpeg 已就绪；还需在设置页给 asr 填上游地址与模型）'
      else
        say '语音：不可用（未装 ffmpeg，麦克风入口隐藏、asr 子进程未启动；core 日志里的 asr 发现失败是预期的）'
      fi
      if [ "$PY_OK" = 1 ]; then
        say '技能：已启用（python3 就绪）'
      else
        say '技能：已关闭（未安装 python3；装好后重跑本脚本即可）'
      fi
      if [ "$FIRST_RUN" = 1 ]; then
        printf '\n首次使用：左下角「用户区」→ 设置 → 模型池，添加平台和 API Key，然后点「重启」。\n'
      fi
      printf '停止：Ctrl-C，或 %s/stop.sh\n\n' "$HERE"
    fi
  else
    warn 'agent-core 没能起来，最近日志：'
    tail -n 30 "$LOG" 2>/dev/null || true
    kill_tree "$CORE_PID"
    CORE_PID=''
    ui_fail 'agent-core 没能启动' "配置或依赖有问题，服务没起来。日志尾部附在下方；改完重跑 <code>./local/start.sh</code>。若刚在设置页改过配置，也可能是 YAML 写坏了：<code>$(html_escape "$CONFIG" | sed -e 's|.*/||')</code>。" "$LOG"
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
    ui_fail "agent-core 反复启动失败（$FAILS 次）" '最常见的原因是配置写坏了（YAML 缩进/引号）或依赖装了一半。日志尾部在下方；改完重跑 <code>./local/start.sh</code>。' "$LOG"
    exit 1
  fi
  warn 'agent-core 已退出，1 秒后自动拉起（设置页点「重启」走的也是这条路）'
  sleep 1
 done

say '已停止。'
