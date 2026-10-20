#!/bin/bash
# init_host.sh — Debian 12 服务器初始化（国内/海外双区，完全幂等，可重复执行）
#
# 定位：只负责「裸机 → 可运行环境」——bashrc / vimrc / Swap / swappiness / 系统更新 / Docker。
#       本脚本不 build 任何镜像；镜像由仓库根 `docker compose up -d --build` 在服务器本地构建（见脚本末尾提示）。
#
# 区域（决定 Docker 用哪个源）：
#   REGION=cn       国内（默认）：腾讯云 docker-ce 镜像源 + registry 加速器
#   REGION=oversea  海外：Docker 官方源，不配加速器
#
# 用法：
#   ./init_host.sh                     # 国内服务器
#   REGION=oversea ./init_host.sh      # 海外服务器
#   SKIP_UPGRADE=1 ./init_host.sh      # 跳过 apt upgrade
#   DOCKER_SELFTEST=1 ./init_host.sh   # 额外跑一次 hello-world 拉取自测（默认关：服务器只 load 镜像）
set -euo pipefail

# ============================================================
# 全局配置
# ============================================================
BASHRC_MARKER="# ===== init.sh custom config ====="
SWAPFILE="/swapfile"
SWAP_SIZE="2G"
SWAPPINESS_FILE="/etc/sysctl.d/99-swappiness.conf"
SWAPPINESS_VALUE="10"
DOCKER_KEYRING="/etc/apt/keyrings/docker.gpg"
DOCKER_LIST="/etc/apt/sources.list.d/docker.list"
DOCKER_DAEMON_JSON="/etc/docker/daemon.json"

REGION="${REGION:-cn}"
SKIP_UPGRADE="${SKIP_UPGRADE:-0}"
DOCKER_SELFTEST="${DOCKER_SELFTEST:-0}"
# 末尾提示里用的仓库地址（私有仓库，可改；仅供 git clone 提示，不会被访问）
REPO_URL="${REPO_URL:-https://git.foresh.com/kicer/agent.git}"

# docker-ce 软件源候选：按顺序试，第一个能下到 GPG key 的胜出
case "$REGION" in
    oversea)
        DOCKER_BASES=("https://download.docker.com/linux/debian")
        REGISTRY_MIRRORS=()
        ;;
    *)
        DOCKER_BASES=(
            "https://mirrors.tencentyun.com/docker-ce/linux/debian"    # 腾讯云内网（CVM 首选）
            "https://mirrors.cloud.tencent.com/docker-ce/linux/debian" # 腾讯云公网
        )
        REGISTRY_MIRRORS=(
            "https://mirror.ccs.tencentyun.com" # 腾讯云内网加速
            "https://docker.1ms.run"
            "https://docker.m.daocloud.io"
        )
        ;;
esac

export DEBIAN_FRONTEND=noninteractive

# ============================================================
# 日志
# ============================================================
log()  { echo -e "\n\033[1;32m===== $* =====\033[0m"; }
warn() { echo -e "\033[1;33m[WARN] $*\033[0m"; }
err()  { echo -e "\033[1;31m[ERROR] $*\033[0m"; }

# ============================================================
# 1. ~/.bashrc
# ============================================================
setup_bashrc() {
    log "1. 配置 ~/.bashrc"
    if grep -qF "$BASHRC_MARKER" ~/.bashrc 2>/dev/null; then
        echo "已配置，跳过。"
        return
    fi
    cat >> ~/.bashrc << 'EOF'

# ===== init.sh custom config =====
export LS_OPTIONS='--color=auto'
eval "$(dircolors)"
alias ls='ls $LS_OPTIONS'
alias ll='ls $LS_OPTIONS -l'
alias l='ls $LS_OPTIONS -lA'

alias rm='rm -i'
alias cp='cp -i'
alias mv='mv -i'
# ===== init.sh custom config end =====
EOF
    echo "已写入 ~/.bashrc。"
}

# ============================================================
# 2. ~/.vimrc
# ============================================================
setup_vimrc() {
    log "2. 配置 ~/.vimrc"
    cat > ~/.vimrc << 'EOF'
set number
set smartindent
set autoindent
set shiftwidth=4
set tabstop=4
set expandtab
set noswapfile
syntax on
EOF
    echo "已写入 ~/.vimrc。"
}

# ============================================================
# 3. Swap
# ============================================================
setup_swap() {
    log "3. 配置 ${SWAP_SIZE} Swap"

    if [ -f "$SWAPFILE" ]; then
        echo "$SWAPFILE 已存在，跳过创建。"
    else
        echo "创建 $SWAPFILE（${SWAP_SIZE}）..."
        local count=$(( ${SWAP_SIZE%G} * 1024 ))
        if ! fallocate -l "$SWAP_SIZE" "$SWAPFILE" 2>/dev/null; then
            warn "fallocate 失败，改用 dd。"
            dd if=/dev/zero of="$SWAPFILE" bs=1M count="$count" status=progress
        fi
        chmod 600 "$SWAPFILE"
        mkswap "$SWAPFILE"
    fi

    if swapon --show | grep -q "^$SWAPFILE"; then
        echo "Swap 已启用。"
    else
        swapon "$SWAPFILE"
        echo "Swap 已启用。"
    fi

    if grep -qF "$SWAPFILE" /etc/fstab; then
        echo "/etc/fstab 已包含 Swap 条目。"
    else
        echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
        echo "已写入 /etc/fstab。"
    fi

    free -h
    swapon --show
}

# ============================================================
# 4. vm.swappiness（独立文件，覆盖写）
# ============================================================
setup_swappiness() {
    log "4. 配置 vm.swappiness=${SWAPPINESS_VALUE}"

    if grep -qE '^[[:space:]]*vm\.swappiness[[:space:]]*=' /etc/sysctl.conf 2>/dev/null; then
        warn "检测到 /etc/sysctl.conf 中有 vm.swappiness，注释掉以免重复。"
        sed -i -E 's|^[[:space:]]*(vm\.swappiness[[:space:]]*=.*)$|# \1  # moved to '"$SWAPPINESS_FILE"' by init.sh|' /etc/sysctl.conf
    fi

    echo "vm.swappiness=${SWAPPINESS_VALUE}" > "$SWAPPINESS_FILE"
    sysctl --system >/dev/null 2>&1 || true
    echo "当前值: $(cat /proc/sys/vm/swappiness)"
}

# ============================================================
# 5. 系统包更新（幂等；可用 SKIP_UPGRADE=1 跳过）
# ============================================================
setup_system_update() {
    log "5. 系统包更新"

    if [ "$SKIP_UPGRADE" = "1" ]; then
        echo "SKIP_UPGRADE=1，跳过。"
        return
    fi

    echo "--- apt update ---"
    apt update

    echo "--- apt upgrade（非交互，保留旧配置文件）---"
    apt upgrade -y \
        -o Dpkg::Options::="--force-confdef" \
        -o Dpkg::Options::="--force-confold"

    # autoremove：无残留时 apt 会输出 0 行，天然幂等
    echo "--- apt autoremove ---"
    apt autoremove -y

    # 清理已下载的 .deb 缓存（幂等）
    apt clean

    # 是否需要重启
    if [ -f /var/run/reboot-required ]; then
        warn "系统建议重启以应用内核/核心库更新。"
        warn "请手动执行： reboot"
        [ -f /var/run/reboot-required.pkgs ] && \
            warn "相关包： $(tr '\n' ' ' < /var/run/reboot-required.pkgs)"
    else
        echo "无需重启。"
    fi
}

# ============================================================
# 6. Docker 安装（已装并运行则整体跳过；源随 REGION 走）
# ============================================================
setup_docker() {
    log "6. 安装 Docker（REGION=$REGION）"

    # 已安装且运行中 → 跳过：不覆盖仓库文件、不下载 GPG key、不碰已有配置
    if command -v docker >/dev/null 2>&1 && systemctl is-active --quiet docker; then
        echo "Docker 已安装并运行，跳过。"
        return
    fi

    # 6.1 HTTPS 相关工具（已装则跳过）
    if ! dpkg -s ca-certificates curl gnupg >/dev/null 2>&1; then
        apt update
        apt install -y ca-certificates curl gnupg
    fi

    install -m 0755 -d /etc/apt/keyrings

    # 6.2 GPG key + 选定可用源
    local base=""
    if [ -s "$DOCKER_KEYRING" ] && gpg --show-keys "$DOCKER_KEYRING" >/dev/null 2>&1; then
        echo "Docker GPG key 已存在且有效，跳过下载。"
        # 复用上次写进 docker.list 的源（第 1 列 deb，第 3 列是 URL）
        base="$(awk '$1 == "deb" { print $3; exit }' "$DOCKER_LIST" 2>/dev/null || true)"
        [ -n "$base" ] || base="${DOCKER_BASES[0]}"
    else
        local cand
        for cand in "${DOCKER_BASES[@]}"; do
            echo "下载 Docker GPG key：$cand/gpg"
            rm -f "$DOCKER_KEYRING"
            if curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 \
                    "$cand/gpg" \
                    | gpg --dearmor --yes -o "$DOCKER_KEYRING" 2>/dev/null \
               && [ -s "$DOCKER_KEYRING" ]; then
                base="$cand"
                break
            fi
            warn "该源不可用，尝试下一个。"
        done
        if [ -z "$base" ]; then
            err "所有 Docker 源都下不到 GPG key。检查网络，或换 REGION=oversea / 手动改 DOCKER_BASES。"
            exit 1
        fi
        chmod a+r "$DOCKER_KEYRING"
        echo "GPG key 已就位（源：$base）。"
    fi

    # 6.3 仓库覆盖写
    local codename arch
    codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
    arch=$(dpkg --print-architecture)
    echo "deb [arch=$arch signed-by=$DOCKER_KEYRING] $base $codename stable" \
        > "$DOCKER_LIST"

    # 6.4 安装
    apt update
    apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    echo "Docker 已安装并启用。"
}

# ============================================================
# 7. Docker 镜像加速器（仅国内；已有 registry-mirrors 则不动）
# ============================================================
setup_docker_mirrors() {
    log "7. 配置 Docker 镜像加速器"

    if [ "${#REGISTRY_MIRRORS[@]}" -eq 0 ]; then
        echo "REGION=$REGION 不需要加速器，跳过。"
        return
    fi

    mkdir -p /etc/docker

    if [ -f "$DOCKER_DAEMON_JSON" ]; then
        if grep -q '"registry-mirrors"' "$DOCKER_DAEMON_JSON"; then
            echo "$DOCKER_DAEMON_JSON 已包含 registry-mirrors，跳过。"
            return
        fi
        local bak="${DOCKER_DAEMON_JSON}.bak.$(date +%s)"
        warn "$DOCKER_DAEMON_JSON 已存在但无 registry-mirrors，备份到 $bak 后覆盖。"
        cp "$DOCKER_DAEMON_JSON" "$bak"
    fi

    {
        echo '{'
        echo '  "registry-mirrors": ['
        local last=$(( ${#REGISTRY_MIRRORS[@]} - 1 ))
        local i comma
        for i in "${!REGISTRY_MIRRORS[@]}"; do
            comma=","
            [ "$i" -eq "$last" ] && comma=""
            printf '    "%s"%s\n' "${REGISTRY_MIRRORS[$i]}" "$comma"
        done
        echo '  ]'
        echo '}'
    } > "$DOCKER_DAEMON_JSON"

    echo "已写入 $DOCKER_DAEMON_JSON"
    systemctl daemon-reload
    systemctl restart docker
    echo "Docker 已重启（已 load 的镜像不受影响）。"
}

# ============================================================
# 8. 验证
# ============================================================
verify() {
    log "8. 验证"
    docker --version
    echo
    echo "--- Registry Mirrors ---"
    docker info 2>/dev/null | grep -A6 "Registry Mirrors" || true

    if [ "$DOCKER_SELFTEST" = "1" ]; then
        echo
        echo "--- hello-world 自测（DOCKER_SELFTEST=1）---"
        if docker run --rm hello-world; then
            echo "Docker 拉取自测通过。"
        else
            warn "hello-world 拉取失败，请检查网络或镜像源。"
        fi
    fi
}

# ============================================================
# 9. 后续部署提示（只打印，不执行任何部署动作）
# ============================================================
print_next_steps() {
    local repo_dir=""
    repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"

    log "部署下一步"

    # 脚本就在本仓库的 scripts/ 下 → 直接给 cd；否则按「单独拷出来跑」给 clone。
    # 判据不用「父目录里有没有 docker-compose.yml」：目录里可能恰好存着一份别处的配置（/tmp 就踩过），
    # 要求 docker-compose.yml 与 scripts/init.sh 同时存在，才算真仓库根。
    if [ -n "$repo_dir" ] && [ -f "$repo_dir/docker-compose.yml" ] && [ -f "$repo_dir/scripts/init.sh" ]; then
        echo "① 进入仓库"
        echo "   cd $repo_dir"
    else
        echo "① 拉代码（私有仓库，需先配好 git 凭据）"
        echo "   git clone $REPO_URL ~/agent"
        echo "   cd ~/agent"
    fi

    cat <<'EOF'

② 生成配置（三个 Key 都可选，填几个启用几个；PUBLIC_IP 不填会自动探测）
   BIGMODEL_KEY=xxx DEEPSEEK_KEY=yyy QWEN_KEY=zzz \
   AUTH_USER=admin AUTH_PASSWORD='换成强密码' PUBLIC_IP=<公网IP> \
   ./scripts/init.sh

③ 构建并启动（首次会构建 MCP 镜像 + executor 技能层，耗时较久）
   docker compose up -d --build
   docker compose logs -f agent-core     # 出现 "Agent server listening on 8090" 即就绪

④ 腾讯云控制台 → 安全组：放行 TCP 8090 入站（改过 AGENT_PORT 就放行对应端口）
⑤ 浏览器打开 http://<公网IP>:8090，用 init.sh 打印的账号登录

备注：
- 上面若提示需要重启（内核/核心库更新），建议先 reboot，再执行第 ③ 步
- init.sh 可重复执行：.env 里的密钥复用，config.yml 会先备份为 .bak.<时间戳>
- 只刷新密钥、不动配置：./scripts/init.sh --env-only
EOF
}

# ============================================================
# main
# ============================================================
main() {
    setup_bashrc
    setup_vimrc
    setup_swap
    setup_swappiness
    setup_system_update
    setup_docker
    setup_docker_mirrors
    verify
    log "初始化完成 ✅"
    print_next_steps
}

main "$@"
