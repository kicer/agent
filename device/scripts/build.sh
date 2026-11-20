#!/bin/sh
# 交叉编译设备端二进制到 ./bin（纯本地动作：不联网、不推送、不依赖任何特定服务器）。
#
#   sh scripts/build.sh              # 编当前平台
#   sh scripts/build.sh all          # 编 linux-arm64 / linux-amd64 / linux-mips / windows-amd64 / darwin-amd64 / darwin-arm64
#
# 有本机 Go 就用本机；没有但有 docker 就用 golang 镜像；都没有就报错。
set -e
cd "$(dirname "$0")/.."

TARGETS="$(uname -s | tr 'A-Z' 'a-z')/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
[ "${1:-}" = "all" ] && TARGETS="linux/arm64 linux/amd64 linux/mips windows/amd64 darwin/amd64 darwin/arm64"

build_with_go() {
    mkdir -p bin
    for t in $TARGETS; do
        os=${t%/*}; arch=${t#*/}; ext=""; gomips=""
        [ "$os" = windows ] && ext=.exe
        # mips 设备（OpenWrt / 老路由）基本都没有 FPU，硬浮点二进制一跑就是非法指令
        [ "$arch" = mips ] && gomips=softfloat
        echo "build $os/$arch"
        GOOS=$os GOARCH=$arch GOMIPS=$gomips CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" \
            -o "bin/agent-device-$os-$arch$ext" ./cmd/agent
    done
}

if command -v go >/dev/null 2>&1; then
    build_with_go
elif command -v docker >/dev/null 2>&1; then
    echo "本机没有 Go，改用 golang:1.23-alpine 容器编译"
    docker run --rm -v "$PWD":/w -w /w \
        -e CGO_ENABLED=0 -e TARGETS="$TARGETS" \
        golang:1.23-alpine sh -c '
            mkdir -p bin
            for t in $TARGETS; do
                os=${t%/*}; arch=${t#*/}; ext=""; gomips=""
                [ "$os" = windows ] && ext=.exe
                [ "$arch" = mips ] && gomips=softfloat
                echo "build $os/$arch"
                GOOS=$os GOARCH=$arch GOMIPS=$gomips go build -trimpath -ldflags "-s -w" \
                    -o "bin/agent-device-$os-$arch$ext" ./cmd/agent
            done'
else
    echo "需要 Go 或 docker 才能编译" >&2
    exit 1
fi

ls -lh bin
