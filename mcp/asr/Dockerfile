FROM node:22-slim

# 国内构建慢：apt 默认源在国外，apt-get update 能卡十几分钟。默认换成腾讯云镜像。
# 境外构建或想换源：docker compose build --build-arg DEBIAN_MIRROR=deb.debian.org mcp_asr
# 腾讯云 CVM 上想更快可用内网镜像 mirrors.tencentyun.com（仅腾讯云内网可达）。
ARG DEBIAN_MIRROR=mirrors.cloud.tencent.com

# 换 apt 源：bookworm/trixie 可能是 /etc/apt/sources.list，也可能是 deb822 的
# /etc/apt/sources.list.d/*.sources，直接用 grep 扫一遍、只替换域名，两种格式都盖住
#（路径 /debian、/debian-security 保持不变）。与 executor/Dockerfile 同一套做法。
RUN set -eux; \
    files="$(grep -rl 'deb.debian.org' /etc/apt/ 2>/dev/null || true)"; \
    if [ -n "$files" ]; then sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" $files; fi; \
    grep -rn "${DEBIAN_MIRROR}" /etc/apt/ | head -5 || true

ENV DEBIAN_FRONTEND=noninteractive

# ffmpeg 只装在这里（core 镜像保持干净）：WebView 录出来是 webm/opus，iOS 是 mp4/aac，
# 云端只认 wav/mp3——统一在容器内转成 16k 单声道 wav，前端与引擎两头都不用关心格式。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 零依赖：不需要 npm install（也就没有 registry 慢/被墙的问题）
COPY package.json ./
COPY src ./src

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
