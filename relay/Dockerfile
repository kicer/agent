FROM node:22-alpine
WORKDIR /app
COPY src/ ./src/
# 镜像内只放模板；真身部署时用 volume 挂进来
COPY config.example.json ./config.json
CMD ["node", "src/server.js"]
