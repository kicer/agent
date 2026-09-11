# =============================================================================
# 基础阶段 M —— 长期不变：node + 系统工具 + 预烘 Python 依赖。
# 只承载“系统层”，不含任何技能专属依赖。构建上下文为仓库根（compose: context: .），
# 故 COPY 路径带 executor/ 前缀。
# =============================================================================
FROM node:20-slim AS base

# MPLBACKEND=Agg：让 matplotlib 使用非交互式后端，避免缺少显示设备报错。
# PYTHONUNBUFFERED=1：实时输出日志。
# PYTHONPYCACHEPREFIX=/tmp/pycache：把 __pycache__ 统一甩到会话私有 tmpfs，绝不回写 skills（已 :ro）。
# PIP_BREAK_SYSTEM_PACKAGES=1：允许在系统环境装包。
# TZ=Asia/Shanghai：统一时区。
ENV MPLBACKEND=Agg \
    PYTHONUNBUFFERED=1 \
    PYTHONPYCACHEPREFIX=/tmp/pycache \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    TZ=Asia/Shanghai

# 常用命令行工具：Agent 的 terminal 工具经常用到
# util-linux 提供 unshare/mount/umount（隔离 wrapper 必需）；sudo 已刻意不装。
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 python3-pip python3-venv python3-dev \
    ripgrep wget jq p7zip-full unzip unar file tree \
    libreoffice-writer libreoffice-calc libreoffice-impress \
    fonts-noto-cjk fonts-dejavu fonts-stix \
    poppler-utils qpdf ghostscript imagemagick \
    tesseract-ocr tesseract-ocr-chi-sim \
    ffmpeg sqlite3 libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖预烘进镜像（W2）：skills 目录改为只读后，运行期不得再 pip install 任何技能依赖。
# 新增技能若需要新包，改这里 rebuild，而不是让 AI 现场装。
RUN pip3 install --no-cache-dir --break-system-packages \
    requests beautifulsoup4 lxml \
    numpy matplotlib pandas \
    openpyxl python-docx python-pptx xlrd \
    pymupdf pdfplumber pypdf reportlab \
    Pillow python-dateutil python-magic \
    loguru rich fonttools

# ---- executor 服务（零依赖单文件，仅 Node 内置 http）----
WORKDIR /app
COPY executor/server.js ./
# 技能依赖准备脚本：由 agent-executor-init 服务在启动前执行（pip/资产，无特权）
COPY executor/init-skills.js ./

# 隔离用的空挂载点：必须存在且为空。
#   /workspace/tasks   —— wrapper 用 tmpfs 遮盖它，再 bind 回当前 session（虚拟任务根）
#   /workspace/scratch —— wrapper 用私有 tmpfs 遮盖它（不给任何真实数据的临时工作区）
# 注意：这两个目录【绝不能】被 compose 挂上宿主机数据卷，否则隔离失效。
# 放在最后一步创建，确保镜像里其它指令不会往这里留文件。
RUN mkdir -p /workspace/tasks /workspace/scratch \
    && chmod 755 /workspace/tasks /workspace/scratch \
    && [ -z "$(ls -A /workspace/tasks)" ] && [ -z "$(ls -A /workspace/scratch)" ]

EXPOSE 9000
# EXECUTOR_LOG_LEVEL：日志等级 debug|info|warn|error|none（默认 info）。
# debug 会把与 core 的完整交互逐条打印（请求、/exec 请求体、每条 SSE 帧、JSON 响应）。
# EXECUTOR_ISOLATION_BASE：宿主机 tasks 在本容器内的真实挂载点，必须与 compose 的 volumes 一致。
ENV PORT=9000 \
    EXECUTOR_ROOTS=/workspace \
    EXECUTOR_CWD=/workspace/tasks \
    EXECUTOR_SCRATCH_ROOT=/workspace/scratch \
    EXECUTOR_SKILLS_DIR=/workspace/skills \
    EXECUTOR_ISOLATION_BASE=/mnt/host-tasks \
    EXECUTOR_LOG_LEVEL=info

CMD ["node", "server.js"]

# =============================================================================
# 派生阶段 M' = M + 技能的“系统层”依赖（管理员增删/改动 skills 后重建这一层，M 不动）。
#
# 只取 install.sh 对系统层（/usr、/var）的作用——这部分必须烘进镜像才持久、
# 且对命令只读（会话之间互不影响）。pip 依赖与技能资产（如字体提取）写出的文件
# 随构建层丢弃，它们由 agent-executor-init 落到宿主 ./skills（重启不丢）。
#
# install.sh 属“管理员审核过的资产”；构建期以 root 执行，故仍需保持其最小化。
# compose 通过 build.target: skills 选用本阶段。
# =============================================================================
FROM base AS skills
ENV DEBIAN_FRONTEND=noninteractive
COPY skills /tmp/skills
RUN for d in /tmp/skills/*/; do \
      if [ -f "$d/install.sh" ]; then \
        echo "[skills] install.sh: $d"; \
        ( cd "$d" && bash install.sh ) || echo "[skills][WARN] install.sh 失败（系统依赖可能缺失）：$d"; \
      fi; \
    done; \
    rm -rf /tmp/skills
