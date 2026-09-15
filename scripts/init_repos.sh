#!/bin/bash
# init_repos.sh — 从零把 agent + mcp 拉到本地并跑起来（幂等，可重复执行）。
#
# 位置：agent/scripts/init_repos.sh（随 agent 仓库一起走，路径全部按脚本自身位置推导）
#
# 行为：
#   1) 按下面 REPOS 表：仓库不存在就 clone；已存在就 pull 到最新。
#      有未提交改动时跳过 pull（不覆盖你的东西），直接用当前代码继续。
#   2) 读部署配置（默认 <两个仓库的父目录>/deploy.conf，可用 CONF=... 覆盖），export 给 scripts/init.sh
#   3) 调 scripts/init.sh：生成 config.yml/.env → 起 agent + mcp
#
# 用法：
#   ./scripts/init_repos.sh                          # 配置默认在 ../deploy.conf
#   CONF=/root/deploy.conf ./scripts/init_repos.sh    # 或显式指定
#
# 注：本脚本自己也在被 pull 的 agent 仓库里。bash 已打开的 FD 指向旧 inode，所以“边跑边被
#     git pull 更新”不会错乱：本次仍按旧内容执行，下次运行才生效。
set -euo pipefail

# ============================================================
# 路径与配置（按脚本位置推导：<父目录>/agent/scripts/init_repos.sh）
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_ROOT="$(cd "$AGENT_DIR/.." && pwd)"   # 两个仓库按同级目录存放
AGENT_INIT="$AGENT_DIR/scripts/init.sh"

# 部署配置（含密钥，不进仓库）：按顺序找第一个存在的
#   1) <两个仓库的父目录>/deploy.conf   2) scripts/deploy.conf（已 gitignore）   3) /root/deploy.conf
if [ -z "${CONF:-}" ]; then
    for c in "$DEST_ROOT/deploy.conf" "$AGENT_DIR/scripts/deploy.conf" /root/deploy.conf; do
        if [ -f "$c" ]; then CONF="$c"; break; fi
    done
fi
CONF="${CONF:-$DEST_ROOT/deploy.conf}"

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
warn() { echo -e "\n\033[1;33m[WARN]\033[0m $*"; }
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
# 1. 拉仓库（不存在则 clone；存在则 pull 到最新后继续）
# ============================================================
log "准备仓库（父目录：$DEST_ROOT）"

fail=0

for item in "${REPOS[@]}"; do
    IFS='|' read -r name url branch <<< "$item"
    dest="$DEST_ROOT/$name"

    log "处理 $name"
    info "URL:  $url"
    info "目标: $dest"

    if [ -d "$dest/.git" ]; then
        # 已存在：拉到最新。有未提交改动就跳过 pull，直接用当前代码继续
        if ! git -C "$dest" diff --quiet || \
           ! git -C "$dest" diff --cached --quiet; then
            warn "$name 有未提交改动，跳过 pull，直接用当前代码继续。"
        elif git -C "$dest" pull --ff-only; then
            info "$name 已是最新"
        else
            warn "$name pull 失败（本地可能有未推送的提交，属正常；用当前代码继续）"
        fi

    elif [ -e "$dest" ]; then
        err "$name: $dest 已存在但不是 Git 仓库，跳过。"
        fail=$((fail+1))
        continue

    else
        if git clone "$url" "$dest"; then
            info "$name 克隆完成"
        else
            err "$name 克隆失败"
            fail=$((fail+1))
            continue
        fi
    fi

    if [ -n "$branch" ]; then
        cur=$(git -C "$dest" rev-parse --abbrev-ref HEAD)
        if [ "$cur" != "$branch" ]; then
            info "切换分支: $cur → $branch"
            git -C "$dest" checkout "$branch"
            git -C "$dest" pull --ff-only || true
        fi
    fi

    info "分支:   $(git -C "$dest" rev-parse --abbrev-ref HEAD)"
    info "Commit: $(git -C "$dest" rev-parse --short HEAD)  $(git -C "$dest" log -1 --pretty=%s)"
done

# ============================================================
# 2. 读部署配置 → 传给 scripts/init.sh
# ============================================================
log "读取部署配置"

if [ ! -f "$AGENT_INIT" ]; then
    err "找不到 $AGENT_INIT（agent 仓库不完整？）"
    exit 1
fi

if [ ! -f "$CONF" ]; then
    err "找不到部署配置：$CONF"
    echo
    echo "从模板复制一份填上即可："
    echo "    cp $AGENT_DIR/scripts/deploy.conf.example $CONF"
    echo "    chmod 600 $CONF && vi $CONF"
    exit 1
fi

# set -a 让下面 source 进来的变量全部 export 给子脚本（子脚本只认环境变量）
# shellcheck disable=SC1090
set -a
. "$CONF"
set +a
export CONF

log "调用 $AGENT_INIT"
info "配置来源: $CONF"

"$AGENT_INIT"

if [ "$fail" -gt 0 ]; then
    warn "有 $fail 个仓库处理失败（见上面日志）。"
    exit 1
fi
exit 0
