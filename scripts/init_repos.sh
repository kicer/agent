#!/bin/bash
# init_repos.sh — 两件事（如果你已手动 clone 了仓库，直接用 agent/scripts/init.sh 即可）：
#   1) 拉取/更新仓库（幂等，可重复执行）
#   2) 读 /root/deploy.conf，把变量 export 出去，然后调用 agent/scripts/init.sh
#      （后者只认环境变量，生成 config.yml/.env 与起服务都在那边；见其头注释）
#
# 用法：填好 /root/deploy.conf 后执行 ./init_repos.sh
set -euo pipefail

# ============================================================
# 配置
# ============================================================
DEST_ROOT="/root/workspace/tools"
CONF="${CONF:-/root/deploy.conf}"
AGENT_DIR="$DEST_ROOT/agent"

# 格式："本地目录名|完整URL|分支"（分支留空 = 跟随远端默认分支）
REPOS=(
    "agent|https://git.foresh.com/kicer/agent.git|"
    "mcp|https://git.foresh.com/kicer/mcp.git|"
)

# ============================================================
# 日志
# ============================================================
log()  { echo -e "\n\033[1;32m===== $* =====\033[0m"; }
info() { echo -e "\033[1;36m[INFO]\033[0m $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $*"; }
err()  { echo -e "\033[1;31m[ERROR]\033[0m $*"; }

# ============================================================
# 依赖
# ============================================================
if ! command -v git >/dev/null 2>&1; then
    log "安装 git"
    apt update
    apt install -y git
fi

# ============================================================
# 1. 拉仓库
# ============================================================
mkdir -p "$DEST_ROOT"
cd "$DEST_ROOT"

ok=0
fail=0

for item in "${REPOS[@]}"; do
    IFS='|' read -r name url branch <<< "$item"
    dest="$DEST_ROOT/$name"

    log "处理 $name"
    info "URL:  $url"
    info "目标: $dest"

    if [ -d "$dest/.git" ]; then
        # 已存在 → 有未提交改动就跳过 pull（不覆盖你的东西）
        if ! git -C "$dest" diff --quiet || \
           ! git -C "$dest" diff --cached --quiet; then
            warn "$name 有未提交改动，跳过 pull。"
            fail=$((fail+1))
            continue
        fi

        if git -C "$dest" pull --ff-only; then
            info "$name 更新完成"
            ok=$((ok+1))
        else
            warn "$name pull 失败（本地可能已有未推送的提交，属正常；不影响后续部署）"
            ok=$((ok+1))
        fi

    elif [ -e "$dest" ]; then
        err "$name: $dest 已存在但不是 Git 仓库，跳过。"
        fail=$((fail+1))

    else
        if git clone "$url" "$dest"; then
            info "$name 克隆完成"
            ok=$((ok+1))
        else
            err "$name 克隆失败"
            fail=$((fail+1))
        fi
    fi

    if [ -n "$branch" ] && [ -d "$dest/.git" ]; then
        cur=$(git -C "$dest" rev-parse --abbrev-ref HEAD)
        if [ "$cur" != "$branch" ]; then
            info "切换分支: $cur → $branch"
            git -C "$dest" checkout "$branch"
            git -C "$dest" pull --ff-only || true
        fi
    fi

    if [ -d "$dest/.git" ]; then
        info "分支:   $(git -C "$dest" rev-parse --abbrev-ref HEAD)"
        info "Commit: $(git -C "$dest" rev-parse --short HEAD)  $(git -C "$dest" log -1 --pretty=%s)"
    fi
done

if [ ! -d "$AGENT_DIR" ]; then
    err "缺 $AGENT_DIR，无法继续。"
    exit 1
fi

# ============================================================
# 2. 读 deploy.conf → 传给 agent 的部署脚本
# ============================================================
log "读取部署配置"

if [ ! -f "$CONF" ]; then
    err "找不到 $CONF（配置就在这个文件里，模板见仓库外说明）。"
    exit 1
fi

# set -a 让下面 source 进来的变量全部 export 给子脚本（子脚本只认环境变量）
# shellcheck disable=SC1090
set -a
. "$CONF"
set +a
export CONF

AGENT_INIT="$AGENT_DIR/scripts/init.sh"
if [ ! -f "$AGENT_INIT" ]; then
    err "找不到 $AGENT_INIT（agent 仓库可能太旧，先手动 git pull 一次）。"
    exit 1
fi

log "调用 $AGENT_INIT"
info "配置来源: $CONF"

"$AGENT_INIT"

if [ "$fail" -gt 0 ]; then
    warn "有 $fail 个仓库处理失败（见上面日志）。"
    exit 1
fi
exit 0
