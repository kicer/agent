#!/bin/bash
# office 技能资产与入口（skills/README 5.2 约定：本脚本在「镜像构建(skills 阶段)」与「启动 init」两处都跑，必须幂等）：
#
# 1) 资产 bin/officecli —— officecli 官方 .NET 单文件二进制，按平台取对应 release 资产：
#    Linux(x64/arm64) / macOS(x64/arm64)。Windows 暂不支持（要用时手工放置二进制并设 OFFICECLI_BIN）。
#    校验和 pin 死，取自上游 release 的 SHA256SUMS（与下面 VER 对应）。注意 officecli 会自更新，
#    所以 sha 只约束「本次下载的资产」；已在且能跑的直接沿用（详见下方 usable() 的注释）。
#    不进 git（.gitignore 已排除 skills/office/bin/）、不进镜像：init 阶段写进宿主 ./skills 卷，
#    executor 容器以 :ro 挂到 /workspace/skills —— 运行期只读执行，改动版本=改本文件 pin 重启。
#    构建阶段（$HERE 在 /tmp 下，产物即弃）跳过下载，只烘 PATH 入口。
#    主源 GitHub，备源 gh-proxy（国内网络）。
# 2) PATH 入口 /usr/local/bin/office -> <运行期技能根>/scripts/office —— 构建阶段写进镜像层持久；
#    init 阶段根只读，|| true 静默（镜像里已就位）。
#    本地端（macOS）没有写 /usr/local/bin 的权限，这里会静默失败——不影响使用：
#    local/start.sh 直接把 scripts 目录放进 PATH，本地同样能直接调 `office`。
#
# 两个源都拉不到：exit 1（init 不写 marker，下次启动自动重试）；救急可手动放置同名二进制到
# skills/office/bin/officecli（sha 对上即认），再 docker compose up -d 重跑 init。
#
# 本地首次使用（macOS/Linux）：bash skills/office/install.sh，装完即可 `office help`，
# 无需重启 agent（封装层每次执行时才解析二进制路径）。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
VER=v1.0.157
ASSET="$HERE/bin/officecli"

ln -sfn "${EXECUTOR_SKILLS_DIR:-/workspace/skills}/office/scripts/office" /usr/local/bin/office 2>/dev/null || true

# 构建阶段：PATH 入口已烘，资产交给 init（避免每次 skills 层重建白拉 35MB）。
# 放在平台探测之前：构建阶段不下载，也就不该因为构建机架构不被识别而中断镜像构建。
case "$HERE" in
  /tmp/*) echo "[office] build stage: PATH 入口就位；bin/officecli 资产由 init 阶段落到技能卷"; exit 0 ;;
esac

# 平台 → 资产名 + 官方校验和（SHA256SUMS@$VER）
case "$(uname -s)" in
  Linux)
    case "$(uname -m)" in
      x86_64|amd64)  NAME=officecli-linux-x64;  SHA=f8eefe88dbfa7464bee421e5421efe57fc26bc3180b30e56eef58594c8245c94 ;;
      aarch64|arm64) NAME=officecli-linux-arm64; SHA=60db926c8a1371984b9e99622a834777befb02b6f73d0f3fff914ffcc2760d2f ;;
      *) echo "[office] 不支持的 Linux 架构：$(uname -m)" >&2; exit 1 ;;
    esac ;;
  Darwin)
    case "$(uname -m)" in
      x86_64) NAME=officecli-mac-x64;   SHA=178c1e9ebaf44c24d2b4b359064a5dea6eb7b2f539809871a3de1c09599dff9f ;;
      arm64)  NAME=officecli-mac-arm64; SHA=0dae0990a9cc29688a5d54469f984c34e5b15ab6bbd194a0ffdc571bb9040124 ;;
      *) echo "[office] 不支持的 macOS 架构：$(uname -m)" >&2; exit 1 ;;
    esac ;;
  *)
    echo "[office] 本平台没有预置资产（$(uname -s) $(uname -m)）：手工放置二进制到 $ASSET 并设 OFFICECLI_BIN 即可" >&2
    exit 1 ;;
esac

# macOS 默认没有 sha256sum，只有 shasum
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

verify() { [ -f "$ASSET" ] && [ "$(sha_of "$ASSET")" = "$SHA" ]; }

# 已存在且能跑就算就位：officecli 会自更新到上游 latest（实测 1.0.157 跑一次就变成 1.0.160，
# 文件大小与 latest 资产完全一致），拿 sha pin 去比对已跑过的二进制只会反复重拉 34MB。
# 校验和的意义因此收窄为「管本次下载的东西」；服务器上卷是 :ro，二进制不会漂，正常仍走 verify。
usable() { [ -f "$ASSET" ] && "$ASSET" --version >/dev/null 2>&1; }

if verify; then
  echo "[office] 资产已就位（sha 匹配）：$ASSET"
  exit 0
fi

if usable; then
  echo "[office] 资产已就位（版本 $("$ASSET" --version 2>/dev/null | head -1)，与 pin 的 $VER 不同：officecli 自更新所致）"
  exit 0
fi

mkdir -p "$HERE/bin"
for u in "https://github.com/iOfficeAI/OfficeCLI/releases/download/$VER/$NAME" \
         "https://gh-proxy.com/https://github.com/iOfficeAI/OfficeCLI/releases/download/$VER/$NAME"; do
  echo "[office] 拉取 $u (connect<=10s, speed>=100KB/s, max 300s)"
  t0=$(date +%s)
  if curl -fL \
       --connect-timeout 10 \
       --max-time 300 \
       --speed-limit 102400 \
       --speed-time 20 \
       --retry 1 \
       --progress-bar \
       -o "$ASSET.tmp" "$u"; then
    got="$(sha_of "$ASSET.tmp")"
    if [ "$got" = "$SHA" ]; then
      mv -f "$ASSET.tmp" "$ASSET"
      chmod 755 "$ASSET"
      echo "[office] officecli $VER ($NAME) -> $ASSET ($(( $(date +%s) - t0 ))s)"
      break
    fi
    echo "[office] sha256 mismatch (got $got, want $SHA), trying next source"
  else
    echo "[office] $(( $(date +%s) - t0 ))s 后失败: $u"
  fi
  rm -f "$ASSET.tmp"
done

if ! verify; then
  echo "[office] 资产获取失败：两个源都没拿到匹配的二进制。稍后重跑本脚本，或手工放置到 $ASSET" >&2
  exit 1
fi
