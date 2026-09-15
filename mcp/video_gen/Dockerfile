FROM node:22-slim

WORKDIR /app

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm install --omit=dev

# 复制源码
COPY . .

EXPOSE 3000 3001

# 启用 HTTP/SSE 模式：
#   3000 = MCP(/mcp) + POST /upload + GET /uploads/*，容器外不映射（只在 docker 网络内可达）
#   3001 = 公网只读的 GET /uploads/*，由 compose 映射到宿主机给智谱下载（PUBLIC_PORT 开启）
CMD ["node", "src/mcp-server.js", "--http", "--port", "3000", "--host", "0.0.0.0"]