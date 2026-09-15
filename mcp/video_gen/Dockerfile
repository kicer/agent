FROM node:22-slim

WORKDIR /app

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm install --omit=dev

# 复制源码
COPY . .

EXPOSE 3000

# HTTP 模式：只提供 MCP（/mcp）与 /health；容器外不映射，只在 my-app-network 内被 agent 访问。
# 本地图片需要公网 URL 时，AI 去 curl agent 的内网签发入口（env PUBLIC_LINK_URL），本服务不搬字节。
CMD ["node", "src/mcp-server.js", "--http", "--port", "3000", "--host", "0.0.0.0"]