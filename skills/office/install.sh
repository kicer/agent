#!/bin/bash
# office 技能资产与入口（skills/README 5.2 约定：本脚本在「镜像构建(skills 阶段)」与「启动 init」两处都跑，必须幂等）：
#
# 1) 资产 bin/officecli —— officecli 官方 .NET 单文件二进制（v1.0.157 linux-x64）。
#    不进 git（.gitignore 已排除 skills/office/bin/）、不进镜像：init 阶段写进宿主 ./skills 卷，
#    executor 容器以 :ro 挂到 /workspace/skills —— 运行期只读执行，改动版本=改本文件 pin 重启。
#    构建阶段（$HERE 在 /tmp 下，产物即弃）跳过下载，只烘 PATH 入口。
#    主源 GitHub，备源 gh-proxy（国内网络）；sha256 必须等于 pin，宁缺毋错。
# 2) PATH 入口 /usr/local/bin/office -> <运行期技能根>/scripts/office —— 构建阶段写进镜像层持久；
#    init 阶段根只读，|| true 静默（镜像里已就位）。officecli 二进制刻意不进 PATH：模型只见封装层。
#
# 两个源都拉不到：exit 1（init 不写 marker，下次启动自动重试）；救急可手动放置同名二进制到
# skills/office/bin/officecli（sha 对上即认），再 docker compose up -d 重跑 init。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
VER=v1.0.157
SHA=f8eefe88dbfa7464bee421e5421efe57fc26bc3180b30e56eef58594c8245c94
ASSET="$HERE/bin/officecli"

ln -sfn "${EXECUTOR_SKILLS_DIR:-/workspace/skills}/office/scripts/office" /usr/local/bin/office 2>/dev/null || true

# 构建阶段：PATH 入口已烘，资产交给 init（避免每次 skills 层重建白拉 35MB）
case "$HERE" in
  /tmp/*) echo "[office] build stage: PATH 入口就位；bin/officecli 资产由 init 阶段落到技能卷"; exit 0 ;;
esac

verify() { [ -f "$ASSET" ] && echo "$SHA  $ASSET" | sha256sum -c - >/dev/null 2>&1; }

if verify; then
  echo "[office] 资产已就位（sha 匹配）：$ASSET"
  exit 0
fi

mkdir -p "$HERE/bin"
for u in "https://github.com/iOfficeAI/OfficeCLI/releases/download/$VER/officecli-linux-x64" \
         "https://gh-proxy.com/https://github.com/iOfficeAI/OfficeCLI/releases/download/$VER/officecli-linux-x64"; do
  echo "[office] 拉取 $u"
  if curl -fsSL --retry 2 -o "$ASSET.tmp" "$u" \
     && echo "$SHA  $ASSET.tmp" | sha256sum -c - >/dev/null 2>&1; then
    mv -f "$ASSET.tmp" "$ASSET"
    chmod 755 "$ASSET"
    break
  fi
  rm -f "$ASSET.tmp"
done

if verify; then
  echo "[office] 就绪：$ASSET"
  exit 0
else
  echo "[office] 两个源都拉不到 bin/officecli —— 手动放置 $ASSET（sha 对上即认）后 docker compose up -d 重试" >&2
  exit 1
fi
