#!/bin/bash
set -e

# 确保存在可用的中文字体（watermark 中文水印需要）。
# 命中即幂等退出；依赖缓存由 Skill Manager 依据本脚本内容哈希管理。
for f in \
    /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc \
    /usr/share/fonts/truetype/wqy/wqy-microhei.ttc \
    /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc; do
    if [ -f "$f" ]; then
        echo "中文字体已存在：$f"
        exit 0
    fi
done

if [ "$(id -u)" -eq 0 ]; then
    echo "未找到中文字体，安装 fonts-wqy-zenhei..."
    apt-get update -y -qq
    apt-get install -y -qq fonts-wqy-zenhei
else
    echo "错误：非 root 用户且系统无中文字体，无法自动安装" >&2
    exit 1
fi

echo "中文字体就绪"
