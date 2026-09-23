FROM node:22-slim

WORKDIR /app

# 国内构建慢：npm 默认源在国外（web_search 零依赖不需要，这个要）。
# 想换回官方：docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org/ mcp_image_task
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm install --omit=dev

# 复制源码
COPY . .

EXPOSE 3000

# 启用 HTTP/SSE 模式，监听 3000 端口
CMD ["node", "src/mcp-server.js", "--http", "--port", "3000", "--host", "0.0.0.0"]
