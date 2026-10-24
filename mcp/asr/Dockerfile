FROM node:22-slim

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
