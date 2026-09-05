FROM node:20-slim

# MPLBACKEND=Agg：让 matplotlib 使用非交互式后端，避免缺少显示设备报错。
# PYTHONUNBUFFERED=1：实时输出日志。
# TZ=Asia/Shanghai：统一时区。
ENV MPLBACKEND=Agg \
    PYTHONUNBUFFERED=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    TZ=Asia/Shanghai

# 常用命令行工具：Agent 的 terminal 工具经常用到
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 python3-pip python3-venv python3-dev \
    ripgrep wget jq 7z unzip unar file \
    libreoffice-writer libreoffice-calc libreoffice-impress \
    fonts-noto-cjk fonts-dejavu fonts-stix \
    poppler-utils qpdf ghostscript imagemagick \
    tesseract-ocr tesseract-ocr-chi-sim \
    ffmpeg sqlite3 libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
    requests beautifulsoup4 lxml \
    numpy matplotlib \
    openpyxl python-docx python-pptx xlrd \
    pymupdf pdfplumber pypdf reportlab \
    Pillow python-dateutil python-magic \
    loguru rich fonttools

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY config.example.yml ./

EXPOSE 8080
ENV AGENT_CONFIG=/app/config.yml

CMD ["node", "server/server.js"]
