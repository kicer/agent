#!/usr/bin/env bash
# 容器入口：确保 officecli 二进制就位（命名卷缓存）→ exec 真正的服务命令。
#
# - 二进制不进 git 也不进镜像：首次启动下载到 /opt/officecli（compose 挂命名卷 officecli-bin），
#   之后每次启动只做 sha256 秒级校验，容器重建不重复下载；卷删了（down -v）下次启动自动重拉。
# - 信任锚是镜像里的 pin（本脚本写死版本+sha256；镜像升级=版本升级）：
#   缓存有效性 = 实际 sha256 与 pin 一致——换版本后旧缓存自动作废，无需额外标记文件。
# - 源链（依次尝试，产物一律过 sha256）：OFFICECLI_URL 整URL覆盖 → GitHub → gh-proxy 备源 → OFFICECLI_MIRROR 前缀。
# - 离线兜底：往挂载目录放一份同名二进制即可（sha 对上就认），见 README「离线放置」。
# - 拉取失败：fail fast 非零退出（unless-stopped 重启即重试），日志教手动动作。
set -euo pipefail

VERSION="${OFFICECLI_VERSION:-v1.0.157}"
SHA256="${OFFICECLI_SHA256:-f8eefe88dbfa7464bee421e5421efe57fc26bc3180b30e56eef58594c8245c94}"
ASSET="officecli-linux-x64"
GH_URL="https://github.com/iOfficeAI/OfficeCLI/releases/download/${VERSION}/${ASSET}"

BIN_DIR="${OFFICECLI_DIR:-/opt/officecli}"
BIN="${BIN_DIR}/officecli"

log() { echo "[officecli-fetch] $*"; }

sha_ok() { printf '%s  %s\n' "${SHA256}" "$1" | sha256sum -c --status - >/dev/null 2>&1; }

# 缓存命中 = 可执行 + sha256 与镜像内 pin 一致（顺带覆盖 docker cp / 手工放置的兜底场景）
if [ -x "${BIN}" ] && sha_ok "${BIN}"; then
  log "officecli ${VERSION} in place (${BIN}); skip fetch"
  exec "$@"
fi

urls=()
if [ -n "${OFFICECLI_URL:-}" ]; then urls+=("${OFFICECLI_URL}"); fi
urls+=( "${GH_URL}" "https://gh-proxy.com/${GH_URL}" )
if [ -n "${OFFICECLI_MIRROR:-}" ]; then
  p="${OFFICECLI_MIRROR}"; case "${p}" in */) ;; *) p="${p}/";; esac
  urls+=( "${p}${GH_URL}" )
fi

mkdir -p "${BIN_DIR}"
rm -f "${BIN_DIR}"/.dl.* 2>/dev/null || true    # 清理上次被中断的半成品
tmp="$(mktemp "${BIN_DIR}/.dl.XXXXXX")"          # 与目标同目录：最后 mv 原子就位，中断永远不会留下残缺拷贝
trap 'rm -f "${tmp}"' EXIT

for url in "${urls[@]}"; do
  log "trying ${url} (connect<=10s, speed>=10KB/s, max 300s)"
  t0=$(date +%s)
  if curl -fL \
       --connect-timeout 10 \
       --max-time 300 \
       --speed-limit 102400 \
       --speed-time 20 \
       --retry 1 \
       --progress-bar \
       -o "${tmp}" "${url}"; then
    got="$(sha256sum "${tmp}" | awk '{print $1}')"
    if [ "${got}" = "${SHA256}" ]; then
      chmod +x "${tmp}"
      mv -f "${tmp}" "${BIN}"
      log "officecli ${VERSION} installed -> ${BIN} ($(( $(date +%s) - t0 ))s)"
      exec "$@"
    fi
    log "sha256 mismatch (got ${got}), trying next source"
  else
    log "failed after $(( $(date +%s) - t0 ))s: ${url}"
  fi
  rm -f "${tmp}"
done

log "FATAL: officecli ${VERSION} 所有源都拉不到（或校验不过）。"
log "  asset:  ${GH_URL}"
log "  sha256: ${SHA256}"
log "  手动放置（sha 对上就认）：docker cp <本地二进制> mcp_officecli:${BIN} && docker compose restart mcp_officecli"
log "  或把 compose 里 officecli-bin 卷换成 bind 挂载（./某目录:${BIN_DIR}）离线放置，再 up -d。"
exit 1
