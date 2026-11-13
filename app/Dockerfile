FROM node:20-slim

ENV TZ=Asia/Shanghai

# git：Git 面板（提交历史 / 未提交改动）要读仓库，本机与容器共用同一条代码路径。
# 国内构建慢：apt 默认源在国外，apt-get update 能卡十几分钟。默认换成腾讯云镜像（与 executor 同源）。
# 境外构建或想换源：docker compose build --build-arg DEBIAN_MIRROR=deb.debian.org
ARG DEBIAN_MIRROR=mirrors.cloud.tencent.com

# 换 apt 源：bookworm 可能是 /etc/apt/sources.list，也可能是 deb822 的 /etc/apt/sources.list.d/*.sources，
# 直接 grep 扫一遍、只替换域名，两种格式都盖住（路径 /debian、/debian-security 保持不变）。
RUN set -eux; \
    files="$(grep -rl 'deb.debian.org' /etc/apt/ 2>/dev/null || true)"; \
    if [ -n "$files" ]; then sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" $files; fi

# 装完清 apt 列表，不给镜像多留几十 MB。
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

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
