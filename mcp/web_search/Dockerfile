FROM node:22-slim

WORKDIR /app

# 零运行时依赖：直接拷贝本地重构的源码，无需 npm install
COPY package.json server.js mcp.js core.js ./

EXPOSE 3000

# HTTP/SSE 模式监听 3000 端口（stdio 模式见 package.json 的 start:stdio）
CMD ["node", "server.js", "--http", "--port", "3000", "--host", "0.0.0.0"]
