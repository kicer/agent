FROM node:20-slim

ENV TZ=Asia/Shanghai

WORKDIR /app

# 国内构建慢：npm 默认源在国外。默认换成腾讯云 npm 镜像（与宿主机 ~/.npmrc 一致）。
# 想换回官方：docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/

COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
    && npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY config.example.yml ./

EXPOSE 8090
ENV AGENT_CONFIG=/app/config.yml

CMD ["node", "server/server.js"]
