FROM node:22-slim

WORKDIR /app

# 复制 package.json 并安装依赖
COPY package.json ./
RUN npm install --omit=dev

# 复制源码
COPY . .

EXPOSE 3000

# 启用 HTTP/SSE 模式，监听 3000 端口
CMD ["node", "src/mcp-server.js", "--http", "--port", "3000", "--host", "0.0.0.0"]
