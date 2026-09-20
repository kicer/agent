#!/bin/bash
# init.sh — 生成 .env 与 config.yml。
#
# 只读环境变量，不依赖任何外部文件；**全部可选**，什么都不给也能直接跑。
#
# 用法：
#   ./scripts/init.sh                                     # 全用默认值（无模型、admin/admin、自动探测公网 IP）
#   BIGMODEL_KEY=xxx PUBLIC_IP=1.2.3.4 ./scripts/init.sh  # 给几个变量就行
#
# 输入（都可选）：
#   BIGMODEL_KEY / DEEPSEEK_KEY / QWEN_KEY  模型平台 key，填几个启用几个（0~3 个）
#   ZHIPU_KEY                               image-gen / video-gen 的智谱 key（空 = 这两个服务 enable: false）
#   AUTH_USER / AUTH_PASSWORD               登录账号（默认 admin / admin，请自行改掉）
#   PUBLIC_IP / AGENT_PORT                  对外地址与端口（PUBLIC_IP 空则尝试自动探测）
#   LOG_LEVEL                               日志级别（调试 debug；日常用 info）
#   AUTH_SECRET / EXECUTOR_TOKEN            一般不用给：不给就自动生成并复用（见下）
#
# ⚠️ config.yml 是本脚本的生成物，不要手改（每次生成前会把旧的备份为 config.yml.bak.<时间戳>）。
set -euo pipefail

# ============================================================
# 路径与默认值
# ============================================================
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

CONFIG_YML="$REPO_DIR/config.yml"
ENV_FILE="$REPO_DIR/.env"

BIGMODEL_KEY="${BIGMODEL_KEY:-}"
DEEPSEEK_KEY="${DEEPSEEK_KEY:-}"
QWEN_KEY="${QWEN_KEY:-}"
ZHIPU_KEY="${ZHIPU_KEY:-}"
AUTH_USER="${AUTH_USER:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-admin}"
PUBLIC_IP="${PUBLIC_IP:-}"
AGENT_PORT="${AGENT_PORT:-8090}"
LOG_LEVEL="${LOG_LEVEL:-info}"
EXECUTOR_TOKEN="${EXECUTOR_TOKEN:-}"
AUTH_SECRET="${AUTH_SECRET:-}"
# 只用于日志里显示"配置从哪来"，不影响行为
CONFIG_SOURCE="${CONF:-环境变量}"

log()  { echo -e "\n\033[1;32m===== $* =====\033[0m"; }
info() { echo -e "\033[1;36m[INFO]\033[0m $*"; }
warn() { echo -e "\n\033[1;33m[WARN]\033[0m $*"; }
err()  { echo -e "\033[1;31m[ERROR]\033[0m $*"; }

gen_hex() {  # $1 = 字节数（默认 32）
    local n="${1:-32}"
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$n"
    else
        head -c "$n" /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

# ============================================================
# 1. 生成 .env（密钥只生成一次，之后复用 → 重跑不掉登录态、不改 executor token）
# ============================================================
log "生成 $ENV_FILE"

if [ -f "$ENV_FILE" ]; then
    EXECUTOR_TOKEN="${EXECUTOR_TOKEN:-$(sed -n 's/^EXECUTOR_TOKEN=//p' "$ENV_FILE" | head -1)}"
    AUTH_SECRET="${AUTH_SECRET:-$(sed -n 's/^AUTH_SECRET=//p' "$ENV_FILE" | head -1)}"
fi
EXECUTOR_TOKEN="${EXECUTOR_TOKEN:-$(gen_hex 32)}"
AUTH_SECRET="${AUTH_SECRET:-$(gen_hex 32)}"

cat > "$ENV_FILE" <<EOF
# 本文件由 scripts/init.sh 生成，勿手改（改配置请重新运行该脚本，或用环境变量覆盖）
# EXECUTOR_TOKEN: core 与 executor 之间的调用鉴权（两侧同值，compose 注入）
# AUTH_SECRET:    登录态签名密钥（写进 config.yml 的 auth.secret）
# AGENT_PORT:     agent-core 映射到宿主机的端口
EXECUTOR_TOKEN=$EXECUTOR_TOKEN
AUTH_SECRET=$AUTH_SECRET
AGENT_PORT=$AGENT_PORT
EOF
info "EXECUTOR_TOKEN / AUTH_SECRET 已就位（沿用已有 .env 的值，没有则新生成）"

# PUBLIC_IP 兜底：只有没给时才去探测（探测不到只告警，不影响启动，只是图生视频用不了）
if [ -z "$PUBLIC_IP" ]; then
    for u in https://ifconfig.me https://api.ipify.org; do
        if command -v curl >/dev/null 2>&1; then
            PUBLIC_IP="$(curl -fsS --max-time 5 "$u" 2>/dev/null || true)"
            [ -n "$PUBLIC_IP" ] && break
        fi
    done
fi
if [ -z "$PUBLIC_IP" ]; then
    warn "没给 PUBLIC_IP 也探测不到：public_link 不生效（需要外部服务来取文件的场景用不了）。"
    warn "设置后重跑即可： PUBLIC_IP=<公网IP> $0"
fi

# ============================================================
# 2. 生成 config.yml
# ============================================================
log "生成 $CONFIG_YML"

if [ -f "$CONFIG_YML" ]; then
    cp "$CONFIG_YML" "$CONFIG_YML.bak.$(date +%s)"
    info "旧 config.yml 已备份为 config.yml.bak.<时间戳>"
fi

# 单个平台骨架（url / 模型 / 参数固定，只有 key 来自变量）
emit_platform() {
    case "$1" in
        bigmodel)
            cat <<EOF
  - name: bigmodel
    url: https://open.bigmodel.cn/api/paas/v4
    keys:
      - api_key: "$2"
        concurrency: 1
    models:
      - id: glm-5.3-flash
        vision: true
        extra_params: { reasoning_effort: "low", tool_stream: true }
        thinking_params: { reasoning_effort: "max" }
EOF
            ;;
        deepseek)
            cat <<EOF
  - name: deepseek
    url: https://api.deepseek.com
    keys:
      - api_key: "$2"
        concurrency: 1
    models:
      - id: deepseek-flash
        vision: true
        extra_params: { thinking: { type: "disabled" } }
        thinking_params: { thinking: { type: "enabled" }, reasoning_effort: "max" }
EOF
            ;;
        qwen)
            cat <<EOF
  - name: qwen
    url: https://dashscope.aliyuncs.com/compatible-mode/v1
    keys:
      - api_key: "$2"
        concurrency: 1
    models:
      - id: qwen3.8-flash
        vision: true
        extra_params: { enable_thinking: false }
        thinking_params: { enable_thinking: true, reasoning_effort: "xhigh" }
EOF
            ;;
    esac
}

enabled_plats=()
if [ -n "$BIGMODEL_KEY" ]; then enabled_plats+=("bigmodel"); fi
if [ -n "$DEEPSEEK_KEY" ]; then enabled_plats+=("deepseek"); fi
if [ -n "$QWEN_KEY" ];     then enabled_plats+=("qwen"); fi

{
    echo "# 本文件由 scripts/init.sh 生成，请勿手改！"
    echo "# 改配置请带环境变量重新运行该脚本（本文件会重新生成，旧的留 .bak）。"
    echo "# 生成时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "# 已启用平台: ${enabled_plats[*]:-（无）}"
    echo

    if [ "${#enabled_plats[@]}" -eq 0 ]; then
        echo "platforms: []    # 没有配置任何平台 key（BIGMODEL_KEY / DEEPSEEK_KEY / QWEN_KEY）"
    else
        echo "platforms:"
        if [ -n "$BIGMODEL_KEY" ]; then emit_platform bigmodel "$BIGMODEL_KEY"; fi
        if [ -n "$DEEPSEEK_KEY" ]; then emit_platform deepseek "$DEEPSEEK_KEY"; fi
        if [ -n "$QWEN_KEY" ];     then emit_platform qwen "$QWEN_KEY"; fi
    fi
    echo

    cat <<EOF
workspace_root: /workspace/tasks
data_root: /workspace/data

skills:
  skills_root: /workspace/skills

# 给外部服务（如智谱）现签公网临时链接用；base_url 就是本服务的对外地址
public_link:
  base_url: "${PUBLIC_IP:+http://$PUBLIC_IP:$AGENT_PORT}"
  ttl_ms: 1800000

log_level: $LOG_LEVEL

auth:
  secret: "$AUTH_SECRET"
  users:
    - user: $AUTH_USER
      password: "$AUTH_PASSWORD"
EOF

    if [ -n "$ZHIPU_KEY" ]; then
        cat <<EOF

mcp_servers:
  - name: web-search
    url: "http://mcp_web_search:3000/"
  - name: image-gen
    url: "http://mcp_image_gen:3000/mcp"
    enable: true
    headers:
      Authorization: "Bearer $ZHIPU_KEY"
  - name: video-gen
    url: "http://mcp_video_gen:3000/mcp"
    enable: true
    headers:
      Authorization: "Bearer $ZHIPU_KEY"
EOF
    else
        cat <<'EOF'

# 没有配置 ZHIPU_KEY：image-gen / video-gen 先注册但 enable: false（工具不加载）。
# 带上 ZHIPU_KEY 重新运行本脚本即启用。
mcp_servers:
  - name: web-search
    url: "http://mcp_web_search:3000/"
  - name: image-gen
    url: "http://mcp_image_gen:3000/mcp"
    enable: false
    headers:
      Authorization: ""
  - name: video-gen
    url: "http://mcp_video_gen:3000/mcp"
    enable: false
    headers:
      Authorization: ""
EOF
    fi
} > "$CONFIG_YML"

info "配置来源: $CONFIG_SOURCE"
info "平台: ${enabled_plats[*]:-无}；智谱 MCP: $([ -n "$ZHIPU_KEY" ] && echo 启用 || echo 未配置)"

# ============================================================
# 3. 汇总
# ============================================================
log "汇总"
echo "---------------------------------------------"
echo " 访问地址 : http://${PUBLIC_IP:-<公网IP>}:${AGENT_PORT}"
echo " 账号     : $AUTH_USER"
echo " 密码     : $AUTH_PASSWORD"
echo " 平台     : ${enabled_plats[*]:-（无）}"
echo " 智谱 MCP : $([ -n "$ZHIPU_KEY" ] && echo "image-gen / video-gen 已启用" || echo "未配置（enable: false）")"
echo " 日志级别 : $LOG_LEVEL"
echo "---------------------------------------------"
log "完成 ✅"
