FROM node:20-slim

ENV TZ=Asia/Shanghai

WORKDIR /app

# 国内构建慢：npm 默认源在国外。默认换成腾讯云 npm 镜像（与宿主机 ~/.npmrc 一致）。
# 想换回官方：docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/

# better-sqlite3 的预编译二进制默认从 GitHub Releases 拉，国内经常拉挂。
# npm 会把 npm_config_ 开头的环境变量当配置项；prebuild-install 读到这个键后，
# 下载地址变成它拼 /v<版本>/<文件名>，和 npmmirror 的 binary 镜像布局一致（Node 20 的
# node-v115-linux-x64 在架），不再走源码编译，也就无需在 slim 镜像里装编译工具链。
ENV npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3

COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
    && npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY config.example.yml ./

EXPOSE 8090
ENV AGENT_CONFIG=/app/config.yml

CMD ["node", "server/server.js"]
