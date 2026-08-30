FROM node:20-slim

# 常用命令行工具：Agent 的 terminal 工具经常用到
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 ripgrep procps\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY config.example.yaml ./

EXPOSE 8080
ENV AGENT_CONFIG=/app/config.yaml

CMD ["node", "server/server.js"]
