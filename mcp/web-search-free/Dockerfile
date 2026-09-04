FROM node:22-slim

WORKDIR /app

# 全局安装包
RUN npm install -g @sheep233_/dsh-web-search-free

EXPOSE 3000

# 直接用 node 执行包内的 MCP server 入口，启用 HTTP/SSE 模式，监听 3000 端口
CMD ["node", "/usr/local/lib/node_modules/@sheep233_/dsh-web-search-free/lib/mcp-server.js", "--http", "--port", "3000", "--host", "0.0.0.0"]
