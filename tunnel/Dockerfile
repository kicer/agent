FROM node:20-slim

ENV TZ=Asia/Shanghai

WORKDIR /app

# 国内构建慢：npm 默认源在国外。默认换成腾讯云镜像（与 app/Dockerfile 同源）。
# 境外构建或想换源：docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/

# 只依赖 ws（纯 JS，无预编译二进制，不需要 better-sqlite3 那套 binary mirror 配置）
# 基础镜像与 app/Dockerfile 同版本（node:20-slim）：服务器上已有，构建时不用再拉一遍
COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
    && npm install --omit=dev --no-audit --no-fund

COPY server.js ./

EXPOSE 19000
CMD ["node", "server.js"]
