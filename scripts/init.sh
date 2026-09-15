#!/bin/bash
# 由 /root/init_repos.sh 调用（也可在仓库根直接跑：./scripts/init.sh）
#
# 职责：生成 .env 与 config.yml，然后按序起服务（agent → mcp）。
#
# 输入（环境变量，通常来自 /root/deploy.conf）：
#   BIGMODEL_KEY / DEEPSEEK_KEY / QWEN_KEY  模型平台 key，填几个启用几个（可 0~3 个）
#   ZHIPU_KEY                               image-gen / video-gen 的智谱 key（空 = 两个服务 enable: false）
#   AUTH_USER / AUTH_PASSWORD               登录账号（默认 admin / admin，请自行改掉）
#   PUBLIC_IP / AGENT_PORT                  对外地址与端口（PUBLIC_IP 空则尝试自动探测）
#   MCP_DIR                                 mcp 仓库位置（默认本仓库同级 ../mcp）
#
# 自动处理（不用配；生成后存进 .env，重跑保持不变，所以不会掉登录态）：
#   AUTH_SECRET / EXECUTOR_TOKEN / LOG_LEVEL
#
# ⚠️ config.yml 由本脚本生成，不要手改（每次生成前会把旧的备份为 config.yml.bak.<时间戳>）。
#    要改配置请改 /root/deploy.conf 后重跑 /root/init_repos.sh。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

CONFIG_YML="$REPO_DIR/config.yml"
ENV_FILE="$REPO_DIR/.env"
MCP_DIR="${MCP_DIR:-$(cd "$REPO_DIR/.." && pwd)/mcp}"

BIGMODEL_KEY="${BIGMODEL_KEY:-}"
DEEPSEEK_KEY="${DEEPSEEK_KEY:-}"
QWEN_KEY="${QWEN_KEY:-}"
ZHIPU_KEY="${ZHIPU_KEY:-}"
AUTH_USER="${AUTH_USER:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-admin}"
PUBLIC_IP="${PUBLIC_IP:-}"
AGENT_PORT="${AGENT_PORT:-8090}"
LOG_LEVEL="${LOG_LEVEL:-debug}"   # 测试期默认 debug（打印 AI↔工具完整交互）；日常用 info
EXECUTOR_TOKEN="${EXECUTOR_TOKEN:-}"
AUTH_SECRET="${AUTH_SECRET:-}"

log()  { echo -e "\n\033[1;32m===== $* =====\033[0m"; }
info() { echo -e "\033[1;36m[INFO]\033[0m $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $*"; }
err()  { echo -e "\033[1;31m[ERROR]\033[0m $*"; }

# ============================================================
# 1. 环境检查
# ============================================================
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    err "docker / docker compose 不可用。请先跑 /root/init.sh 完成服务器初始化。"
    exit 1
fi

gen_hex() {  # $1 = 字节数（默认 32）
    local n="${1:-32}"
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$n"
    else
        head -c "$n" /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

# ============================================================
# 2. 生成 .env（密钥只生成一次，之后复用 → 重跑不掉登录态、不改 executor token）
# ============================================================
log "生成 $ENV_FILE"

if [ -f "$ENV_FILE" ]; then
    EXECUTOR_TOKEN="${EXECUTOR_TOKEN:-$(sed -n 's/^EXECUTOR_TOKEN=//p' "$ENV_FILE" | head -1)}"
    AUTH_SECRET="${AUTH_SECRET:-$(sed -n 's/^AUTH_SECRET=//p' "$ENV_FILE" | head -1)}"
fi
EXECUTOR_TOKEN="${EXECUTOR_TOKEN:-$(gen_hex 32)}"
AUTH_SECRET="${AUTH_SECRET:-$(gen_hex 32)}"

cat > "$ENV_FILE" <<EOF
# 本文件由 scripts/init.sh 生成，勿手改（改配置请改 /root/deploy.conf 后重跑 init_repos.sh）
# EXECUTOR_TOKEN: core 与 executor 之间的调用鉴权（两侧同值，compose 注入）
# AUTH_SECRET:    登录态签名密钥（写进 config.yml 的 auth.secret）
# AGENT_PORT:     agent-core 映射到宿主机的端口
EXECUTOR_TOKEN=$EXECUTOR_TOKEN
AUTH_SECRET=$AUTH_SECRET
AGENT_PORT=$AGENT_PORT
EOF
info "EXECUTOR_TOKEN / AUTH_SECRET 已就位（复用旧的，或本次新生成）"

# PUBLIC_IP 兜底自动探测（deploy.conf 里填了就用填的）
if [ -z "$PUBLIC_IP" ]; then
    for u in https://ifconfig.me https://api.ipify.org; do
        if command -v curl >/dev/null 2>&1; then
            PUBLIC_IP="$(curl -fsS --max-time 5 "$u" 2>/dev/null || true)"
            [ -n "$PUBLIC_IP" ] && break
        fi
    done
fi
if [ -z "$PUBLIC_IP" ]; then
    warn "探测不到公网 IP：public_link 不生效（图生视频用不了）。请在 deploy.conf 里填 PUBLIC_IP 后重跑。"
fi

# ============================================================
# 3. 生成 config.yml
# ============================================================
log "生成 $CONFIG_YML"

if [ -f "$CONFIG_YML" ]; then
    cp "$CONFIG_YML" "$CONFIG_YML.bak.$(date +%s)"
    info "旧 config.yml 已备份为 config.yml.bak.<时间戳>"
fi

# 单个平台骨架（url / 模型 / 参数固定，只有 key 来自配置）
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
    echo "# 改配置请改 /root/deploy.conf 后重跑 /root/init_repos.sh（本文件会重新生成，旧的留 .bak）。"
    echo "# 生成时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "# 已启用平台: ${enabled_plats[*]:-（无）}"
    echo

    if [ "${#enabled_plats[@]}" -eq 0 ]; then
        echo "platforms: []    # deploy.conf 里一个平台 key 都没填"
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

# deploy.conf 里没填 ZHIPU_KEY：image-gen / video-gen 先注册但 enable: false（工具不加载）。
# 填上 ZHIPU_KEY 后重跑 init_repos.sh 即启用。
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

info "平台: ${enabled_plats[*]:-无}；智谱 MCP: $([ -n "$ZHIPU_KEY" ] && echo 启用 || echo 未配置)"

# ============================================================
# 4. 起服务（顺序：agent 先起，它创建 my-app-network）
# ============================================================
log "启动 agent"
docker compose up -d --build

if [ -d "$MCP_DIR" ]; then
    log "启动 mcp（$MCP_DIR）"
    ( cd "$MCP_DIR" && docker compose up -d --build )
else
    warn "没找到 mcp 仓库（$MCP_DIR），跳过。"
fi

# ============================================================
# 5. 汇总
# ============================================================
log "汇总"
echo "---------------------------------------------"
echo " 访问地址 : http://${PUBLIC_IP:-<公网IP>}:${AGENT_PORT}"
echo " 账号     : $AUTH_USER"
echo " 密码     : $AUTH_PASSWORD"
echo " 平台     : ${enabled_plats[*]:-（无，去 /root/deploy.conf 填 key）}"
echo " 智谱 MCP : $([ -n "$ZHIPU_KEY" ] && echo "image-gen / video-gen 已启用" || echo "未配置（enable: false）")"
echo " 日志级别 : $LOG_LEVEL"
echo "---------------------------------------------"
echo
info "容器状态："
docker compose ps
if [ -d "$MCP_DIR" ]; then
    ( cd "$MCP_DIR" && docker compose ps )
fi

echo
info "看日志： docker compose logs -f agent-core"
info "自检（期望 400 缺 path 参数，说明签发链路通了）："
info "  docker exec mcp_video_gen node -e \"fetch('http://agent-core:8081/public-link').then(async r=>console.log(r.status, await r.text()))\""
info "注意：安全组/防火墙需放行 ${AGENT_PORT}（mcp 三个服务一律不用放行）"
log "完成 ✅"
