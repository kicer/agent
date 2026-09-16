#!/bin/bash
set -e

# 确保存在可用的中文字体（watermark 中文水印需要），Pillow 读字体无 reportlab 的 CFF 限制，
# 但 NotoSansCJK ttc 的默认字型（索引 0）是 JP，中文水印会出日式字形，
# 因此就绪判定只认文泉驿（系统 wqy 或同仓 md2pdf 提取的 fonts/cjk.ttf），Noto 仅作兜底。
# 命中即幂等退出；依赖缓存由 Skill Manager 依据本脚本内容哈希管理。

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MD2PDF_FONT="$SKILL_DIR/../md2pdf/fonts/cjk.ttf"

has_wqy() {
    for f in /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc \
             /usr/share/fonts/truetype/wqy/wqy-microhei.ttc; do
        [ -f "$f" ] && return 0
    done
    return 1
}

if has_wqy; then
    echo "文泉驿字体已存在"
    exit 0
fi

if [ -s "$MD2PDF_FONT" ]; then
    echo "使用同仓 md2pdf 准备的中文字体：$MD2PDF_FONT"
    exit 0
fi

if [ "$(id -u)" -eq 0 ]; then
    echo "未找到中文字体，安装 fonts-wqy-zenhei..."
    # best-effort：apt 失败不直接报错，交给下面的就绪判定兜底
    apt-get update -y -qq || true
    apt-get install -y -qq fonts-wqy-zenhei || true
fi

if has_wqy || [ -s "$MD2PDF_FONT" ]; then
    echo "中文字体就绪"
elif [ -f /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc ]; then
    # Noto 兜底：中文能显示，只是默认字型偏日式；不算失败
    echo "警告：仅有 Noto CJK 字体（中文水印将使用其默认 JP 字型），建议安装文泉驿"
else
    echo "错误：无中文字体可用（非 root 且系统未装文泉驿/Noto）" >&2
    exit 1
fi
