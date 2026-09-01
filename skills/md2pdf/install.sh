#!/bin/bash
set -e

# 创建字体目录
mkdir -p fonts

# 如果已经存在提取好的字体且非空，则跳过（可选）
if [ -s fonts/cjk.ttf ]; then
    echo "字体文件已存在，跳过准备"
    exit 0
fi

# 查找系统字体
FONT_FILE=""
for f in /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc \
         /usr/share/fonts/truetype/wqy/wqy-microhei.ttc \
         /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
         /usr/share/fonts/truetype/source-han-sans/SourceHanSansSC-Regular.otf; do
    if [ -f "$f" ]; then
        FONT_FILE="$f"
        break
    fi
done

# 如果没有找到，尝试安装文泉驿正黑
if [ -z "$FONT_FILE" ]; then
    echo "未找到中文字体，尝试安装 fonts-wqy-zenhei..."
    if [ "$(id -u)" -eq 0 ]; then
        apt-get update -y -qq
        apt-get install -y -qq fonts-wqy-zenhei
        FONT_FILE="/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"
    else
        echo "错误：非 root 用户且系统无中文字体，无法自动安装" >&2
        exit 1
    fi
fi

# 根据字体格式提取/转换为 TTF 到 fonts/cjk.ttf
case "$FONT_FILE" in
    *.ttc)
        echo "从 TTC 提取 TTF..."
        python3 - "$FONT_FILE" <<'PY'
import sys
from fontTools.ttLib import TTCollection
ttc_path = sys.argv[1]
out_path = "fonts/cjk.ttf"
collection = TTCollection(ttc_path)
if not collection.fonts:
    print("TTC 中无字体", file=sys.stderr)
    sys.exit(1)
collection.fonts[0].save(out_path)
print(f"提取完成：{out_path}")
PY
        ;;
    *.otf)
        echo "转换 OTF 为 TTF..."
        python3 - "$FONT_FILE" <<'PY'
import sys
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1])
# 确保输出为 TrueType 轮廓（去除 CFF）
font.flavor = None
font.save("fonts/cjk.ttf")
print("转换完成")
PY
        ;;
    *.ttf)
        echo "复制 TTF 字体..."
        cp "$FONT_FILE" fonts/cjk.ttf
        ;;
    *)
        echo "不支持的字体格式：$FONT_FILE" >&2
        exit 1
        ;;
esac

echo "中文字体准备完成：fonts/cjk.ttf"
