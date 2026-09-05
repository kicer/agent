FROM node:20-slim

ENV TZ=Asia/Shanghai

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY config.example.yml ./

EXPOSE 8080
ENV AGENT_CONFIG=/app/config.yml

CMD ["node", "server/server.js"]
