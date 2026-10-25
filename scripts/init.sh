#!/bin/bash
# init.sh — 首次部署准备：生成 .env、探测公网地址、创建初始管理员。幂等。
#
#   ./scripts/init.sh                    # 已有 .env / config.yml 均不覆盖
#
# 可选变量：PUBLIC_IP、AGENT_PORT、AUTH_USER / AUTH_PASSWORD（默认 admin / admin）、
#          EXECUTOR_TOKEN / WXBOT_TOKEN / AUTH_SECRET（不给则生成并复用）。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

ENV_FILE="$REPO_DIR/.env"
CONFIG_YML="$REPO_DIR/config.yml"

PUBLIC_IP="${PUBLIC_IP:-}"
PORT_INPUT="${AGENT_PORT:-}"
AUTH_USER="${AUTH_USER:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-admin}"

info()  { echo -e "\033[1;36m[INFO]\033[0m $*"; }
warn()  { echo -e "\n\033[1;33m[WARN]\033[0m $*"; }
title() { echo -e "\n\033[1;32m===== $* =====\033[0m"; }

gen_hex() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

env_get() {
    [ -f "$ENV_FILE" ] || return 0
    awk -F= -v k="$1" '$1==k { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE" || true
}

yaml_q() {
    local s="${1//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '"%s"' "$s"
}

detect_public_ip() {
    command -v curl >/dev/null 2>&1 || return 0
    local u ip
    for u in https://ifconfig.me https://api.ipify.org; do
        ip="$(curl -fsS --max-time 5 "$u" 2>/dev/null || true)"
        if [ -n "$ip" ]; then printf '%s' "$ip"; return 0; fi
    done
}

# ---------- .env ----------
title "生成 $ENV_FILE"

EXECUTOR_TOKEN="${EXECUTOR_TOKEN:-$(env_get EXECUTOR_TOKEN)}"
WXBOT_TOKEN="${WXBOT_TOKEN:-$(env_get WXBOT_TOKEN)}"
AUTH_SECRET="${AUTH_SECRET:-$(env_get AUTH_SECRET)}"
AGENT_PORT="${PORT_INPUT:-$(env_get AGENT_PORT)}"
AGENT_PORT="${AGENT_PORT:-8090}"
OLD_URL="$(env_get PUBLIC_BASE_URL)"

EXECUTOR_TOKEN="${EXECUTOR_TOKEN:-$(gen_hex)}"
WXBOT_TOKEN="${WXBOT_TOKEN:-$(gen_hex)}"
AUTH_SECRET="${AUTH_SECRET:-$(gen_hex)}"

if [ -n "$PUBLIC_IP" ]; then
    PUBLIC_BASE_URL="http://$PUBLIC_IP:$AGENT_PORT"
elif [ -n "$OLD_URL" ]; then
    # 显式改端口时只换端口，保留原协议与主机
    if [ -n "$PORT_INPUT" ]; then
        PUBLIC_BASE_URL="$(printf '%s' "$OLD_URL" | sed -E "s#^(https?://[^/:]+)(:[0-9]+)?#\1:$AGENT_PORT#")"
    else
        PUBLIC_BASE_URL="$OLD_URL"
    fi
else
    DETECTED_IP="$(detect_public_ip)"
    PUBLIC_BASE_URL="${DETECTED_IP:+http://$DETECTED_IP:$AGENT_PORT}"
    if [ -z "$PUBLIC_BASE_URL" ]; then
        warn "未探测到公网 IP，PUBLIC_BASE_URL 留空（可设 PUBLIC_IP 后重跑）"
    fi
fi

EXTRAS=""
if [ -f "$ENV_FILE" ]; then
    EXTRAS="$(awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ &&
        $1 !~ /^(EXECUTOR_TOKEN|WXBOT_TOKEN|AUTH_SECRET|AGENT_PORT|PUBLIC_BASE_URL)$/ { print }' \
        "$ENV_FILE" || true)"
fi

{
    echo "# 由 scripts/init.sh 生成；重跑复用已有密钥，并保留其它变量。"
    echo "EXECUTOR_TOKEN=$EXECUTOR_TOKEN"
    echo "WXBOT_TOKEN=$WXBOT_TOKEN"
    echo "AUTH_SECRET=$AUTH_SECRET"
    echo "AGENT_PORT=$AGENT_PORT"
    echo "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
    if [ -n "$EXTRAS" ]; then
        echo
        printf '%s\n' "$EXTRAS"
    fi
} > "$ENV_FILE"

info "EXECUTOR_TOKEN / WXBOT_TOKEN / AUTH_SECRET 已就位"

# ---------- config.yml（只写初始管理员）----------
title "检查 $CONFIG_YML"

if [ -d "$CONFIG_YML" ]; then
    rmdir "$CONFIG_YML" 2>/dev/null || { warn "config.yml 是非空目录，请先处理：$CONFIG_YML"; exit 1; }
    info "已删除被误建的空目录"
fi

CREATED=0
if [ -f "$CONFIG_YML" ]; then
    info "已存在，跳过"
else
    cat > "$CONFIG_YML" <<EOF
auth:
  secret: $(yaml_q "$AUTH_SECRET")
  users:
    - user: $(yaml_q "$AUTH_USER")
      password: $(yaml_q "$AUTH_PASSWORD")
      role: admin
EOF
    info "已创建，初始管理员 $AUTH_USER"
    CREATED=1
fi

# ---------- 汇总 ----------
title "汇总"
echo " 访问地址 : ${PUBLIC_BASE_URL:-（未设置）}"
if [ "$CREATED" = "1" ]; then
    echo " 初始账号 : $AUTH_USER${AUTH_PASSWORD:+ / }$([ "$AUTH_PASSWORD" = "admin" ] && echo 'admin（登录后请修改）' || echo '<AUTH_PASSWORD 传入值>')"
fi
echo " 下一步   : docker compose up -d --build"
