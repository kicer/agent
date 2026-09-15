#!/bin/bash
# init.sh — 腾讯云 Debian 12 服务器初始化
# 特性：完全幂等，可重复执行；每步独立判断，不产生重复配置。
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

TENCENT_DOCKER_BASE="https://mirrors.cloud.tencent.com/docker-ce/linux/debian"

REGISTRY_MIRRORS=(
    "https://mirror.ccs.tencentyun.com"
    "https://docker.1ms.run"
    "https://docker.m.daocloud.io"
)

# 是否自动执行 apt upgrade（1=是，0=否）。默认自动，可用环境变量覆盖：
#   SKIP_UPGRADE=1 ./init.sh
SKIP_UPGRADE="${SKIP_UPGRADE:-0}"

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
# 6. Docker 安装
# ============================================================
setup_docker() {
    log "6. 安装 Docker"

    # 6.1 HTTPS 相关工具（已装则跳过）
    if ! dpkg -s ca-certificates curl gnupg >/dev/null 2>&1; then
        apt update
        apt install -y ca-certificates curl gnupg
    fi

    install -m 0755 -d /etc/apt/keyrings

    # 6.2 GPG key
    if [ -s "$DOCKER_KEYRING" ] && gpg --show-keys "$DOCKER_KEYRING" >/dev/null 2>&1; then
        echo "Docker GPG key 已存在且有效，跳过下载。"
    else
        echo "下载 Docker GPG key（腾讯云镜像）..."
        rm -f "$DOCKER_KEYRING"
        if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 \
                "$TENCENT_DOCKER_BASE/gpg" \
                | gpg --dearmor --yes -o "$DOCKER_KEYRING"; then
            err "GPG key 下载失败。请检查网络后重试。"
            exit 1
        fi
        chmod a+r "$DOCKER_KEYRING"
        echo "GPG key 已就位。"
    fi

    # 6.3 仓库覆盖写
    local codename arch
    codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
    arch=$(dpkg --print-architecture)
    echo "deb [arch=$arch signed-by=$DOCKER_KEYRING] $TENCENT_DOCKER_BASE $codename stable" \
        > "$DOCKER_LIST"

    # 6.4 安装
    apt update
    apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    echo "Docker 已安装并启用。"
}

# ============================================================
# 7. Docker 镜像加速器
# ============================================================
setup_docker_mirrors() {
    log "7. 配置 Docker 镜像加速器"

    mkdir -p /etc/docker

    if [ -f "$DOCKER_DAEMON_JSON" ]; then
        if grep -q '"registry-mirrors"' "$DOCKER_DAEMON_JSON"; then
            echo "$DOCKER_DAEMON_JSON 已包含 registry-mirrors，跳过。"
            return
        fi
        warn "$DOCKER_DAEMON_JSON 已存在但无 registry-mirrors，备份后覆盖。"
        cp "$DOCKER_DAEMON_JSON" "${DOCKER_DAEMON_JSON}.bak.$(date +%s)"
    fi

    {
        echo '{'
        echo '  "registry-mirrors": ['
        local last=$((${#REGISTRY_MIRRORS[@]} - 1))
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
    echo "Docker 已重启。"
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

    echo
    echo "--- hello-world 测试 ---"
    if docker run --rm hello-world; then
        echo "Docker 验证通过。"
    else
        warn "hello-world 拉取失败，请检查网络或镜像源。"
    fi
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
}

main "$@"
