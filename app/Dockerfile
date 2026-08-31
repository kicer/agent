FROM node:20-slim

# 常用命令行工具：Agent 的 terminal 工具经常用到
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 python3-pip python3-venv python3-dev \
    build-essential ripgrep procps unzip wget jq zip tree file \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
    requests beautifulsoup4 lxml pandas numpy openpyxl \
    python-docx reportlab matplotlib Pillow pypdf python-dateutil

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY config.example.yml ./

EXPOSE 8080
ENV AGENT_CONFIG=/app/config.yml

CMD ["node", "server/server.js"]
