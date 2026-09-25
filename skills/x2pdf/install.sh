#!/bin/bash
set -e

# x2pdf 系统级依赖:WeasyPrint 运行时需要 Pango/Cairo/HarfBuzz/gdk-pixbuf 等 .so
# (Python 包本身是纯 Python,由 requirements.txt 负责)。
#
# 两处执行(见 skills/README.md §5.2):
#   - skills 构建阶段(root):apt 装库并烘进派生镜像 M';
#   - agent-executor-init(rootfs 只读):apt 必失败 → 全部 || true,
#     靠镜像已就绪的库通过末尾自检。
# 幂等:库已存在立即 exit 0;改动本脚本会触发 init 重新校验。

PKGS="libpango-1.0-0 libpangocairo-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libharfbuzz0b shared-mime-info"

libs_ready() {
    ldconfig -p 2>/dev/null | grep -q 'libpangocairo-' &&
    ldconfig -p 2>/dev/null | grep -q 'libcairo\.so'
}

# 中文字体(打印质量):WeasyPrint 走 fontconfig,缺文泉驿时 Noto CJK 兜底
fonts_ready() {
    fc-list 2>/dev/null | grep -qiE 'wenquanyi|noto sans cjk'
}

if libs_ready && fonts_ready; then
    echo "WeasyPrint 系统库与中文字体已就绪,跳过"
    exit 0
fi

if [ "$(id -u)" -eq 0 ] && command -v apt-get >/dev/null 2>&1; then
    echo "补齐系统依赖:apt 安装 pango/cairo 运行库与中文字体..."
    apt-get update -y -qq || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
        $PKGS fonts-wqy-microhei fonts-wqy-zenhei shared-mime-info || true
    ldconfig || true
fi

if ! libs_ready; then
    echo "错误:缺 Pango/Cairo 运行库,WeasyPrint 无法渲染(请让管理员在镜像补装:$PKGS)" >&2
    exit 1
fi

if ! fonts_ready; then
    # 不算致命:拉丁文文档仍可渲染,仅中文可能出方块,给出强警告
    echo "警告:未找到文泉驿/Noto CJK 字体,含中文文档将缺字" >&2
fi

echo "WeasyPrint 系统依赖就绪"
