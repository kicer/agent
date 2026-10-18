FROM node:22-slim

# 国内构建慢：apt/pip 默认源在国外，apt-get update 能卡十几分钟。默认换成腾讯云镜像。
# 境外构建或想换源：docker compose build --build-arg DEBIAN_MIRROR=deb.debian.org
# 腾讯云 CVM 上想更快可用内网镜像 mirrors.tencentyun.com（仅腾讯云内网可达）。
ARG DEBIAN_MIRROR=mirrors.cloud.tencent.com

# 换 apt 源：bookworm 可能是 /etc/apt/sources.list，也可能是 deb822 的 /etc/apt/sources.list.d/*.sources，
# 直接用 grep 扫一遍、只替换域名，两种格式都盖住（路径 /debian、/debian-security 保持不变）。
RUN set -eux; \
    files="$(grep -rl 'deb.debian.org' /etc/apt/ 2>/dev/null || true)"; \
    if [ -n "$files" ]; then sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" $files; fi; \
    grep -rn "${DEBIAN_MIRROR}" /etc/apt/ | head -5 || true

# TZ=Asia/Shanghai：统一时区。
ENV TZ=Asia/Shanghai

# libssl3: officecli is a .NET self-contained binary and hard-requires libssl.
# ICU is NOT needed: DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 disables globalization.
# curl: the entrypoint fetches the officecli binary at FIRST boot (image intentionally
# does NOT vendor the binary -> nothing to pre-run after clone, `docker compose up` is the whole entry).
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends libssl3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Zero npm deps: node shim (server.js + watch.js + gateway.js).
# scripts/entrypoint.sh downloads the pinned officecli into /opt/officecli (named volume
# `officecli-bin`, cached across restarts; sha256 verified every boot, GitHub -> gh-proxy fallback)
# then execs CMD. /opt/officecli goes first in PATH so the shim still spawns bare `officecli`.
COPY package.json server.js watch.js gateway.js ./
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh

ENV PATH=/opt/officecli:${PATH}
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
ENV OFFICE_WORKSPACE=/workspace/tasks
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["node", "server.js"]
