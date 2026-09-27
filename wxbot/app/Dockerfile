FROM node:22-slim

WORKDIR /app

# 国内构建慢：npm 默认源在国外。想换回官方：
# docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org/ wxbot
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm install --omit=dev

# 复制源码与页面
COPY . .

EXPOSE 8093

# 微信 iLink 多实例调制解调器（agent 栈私有组件，根 compose 的 wxbot 服务），监听 8093；
# 零配置文件：接线全靠 compose 注入的 WXBOT_TOKEN/CORE_URL（见 wxbot/README）；
# iLink 登录凭证持久化在 /data（每绑定一个子目录，compose 挂 ./wxbot/data）
CMD ["node", "src/server.js"]
