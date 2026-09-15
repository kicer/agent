#!/bin/bash
# init_repos.sh — 从零把 agent + mcp 拉到本地并跑起来（幂等，可重复执行）。
#
# 位置：随便放哪都能跑（常驻位置是 agent/scripts/init_repos.sh；也支持拷到别处做首次引导）。
#
# 行为：
#   1) 先确定“仓库父目录”（agent/ 与 mcp/ 的上级），顺序见下面注释；
#      然后按 REPOS 表：目标目录里有 Git 仓库就只 pull 到最新；没有才 clone。
#      有未提交改动时跳过 pull（不覆盖你的东西），直接用当前代码继续。
#   2) 读部署配置（默认 <两个仓库的父目录>/deploy.conf，可用 CONF=... 覆盖），export 给 scripts/init.sh
#   3) 调 scripts/init.sh：生成 config.yml/.env → 起 agent + mcp
#
# 用法：
#   ./scripts/init_repos.sh                           # 配置默认在 ../deploy.conf
#   DEST_ROOT=/srv/tools ./init_repos.sh              # 指定仓库父目录（脚本放哪都行）
#   CONF=/root/deploy.conf ./scripts/init_repos.sh    # 或显式指定配置
#
# 注：本脚本自己也在被 pull 的 agent 仓库里。bash 已打开的 FD 指向旧 inode，所以“边跑边被
#     git pull 更新”不会错乱：本次仍按旧内容执行，下次运行才生效。
set -euo pipefail

# ============================================================
# 路径与配置
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME:-/root}"

# 仓库父目录（agent/ 与 mcp/ 的上级）的确定顺序 —— 保证脚本放在哪、从哪个目录跑都对：
#   1) 显式 DEST_ROOT=...（最高优先）
#   2) 脚本随 agent 仓库走（<父目录>/agent/scripts/init_repos.sh）：父目录里就有 scripts/init.sh
#   3) 当前目录或 $HOME/workspace/tools 下已有 agent/ 或 mcp/ 仓库 → 就地更新（只 pull，不另建副本）
#   4) 都没有（首次引导）→ 落到 $HOME/workspace/tools
if [ -z "${DEST_ROOT:-}" ] && [ -f "$SCRIPT_DIR/../scripts/init.sh" ]; then
    DEST_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi
if [ -z "${DEST_ROOT:-}" ]; then
    for d in "$PWD" "$HOME_DIR/workspace/tools"; do
        if [ -d "$d/agent/.git" ] || [ -d "$d/mcp/.git" ]; then DEST_ROOT="$d"; break; fi
    done
fi
if [ -z "${DEST_ROOT:-}" ]; then
    DEST_ROOT="$HOME_DIR/workspace/tools"
    echo -e "\033[1;33m[WARN]\033[0m 没找到已有仓库，按默认位置新建：$DEST_ROOT（可用 DEST_ROOT=/path 指定）"
fi

AGENT_DIR="$DEST_ROOT/agent"
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
        # 已存在：只 pull（clone 过就不再另建副本）。有未提交改动就跳过 pull，直接用当前代码继续
        if ! git -C "$dest" diff --quiet || \
           ! git -C "$dest" diff --cached --quiet; then
            warn "$name 有未提交改动，跳过 pull，直接用当前代码继续。"
        else
            head_before="$(git -C "$dest" rev-parse HEAD)"
            if git -C "$dest" pull --ff-only --quiet; then
                if [ "$head_before" = "$(git -C "$dest" rev-parse HEAD)" ]; then
                    info "$name 已是最新"
                else
                    info "$name 已更新到最新"
                fi
            else
                warn "$name pull 失败（本地可能有未推送的提交，属正常；用当前代码继续）"
            fi
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
