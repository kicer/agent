#!/bin/bash
set -e

# 准备中文字体 fonts/cjk.ttf。
# 关键约束：reportlab 的 TTFont 只支持 TrueType(glyf) 轮廓，
# Noto Sans CJK / Source Han Sans 均为 OTTO(CFF) 轮廓，提取/改名后依然注册失败，
# 因此候选只保留文泉驿（wqy，glyf 轮廓），缺失时用 apt 安装。
FONT_TARGET="fonts/cjk.ttf"

mkdir -p fonts

# sfnt magic 必须是 TrueType（00010000 / true / typ1）才算有效；
# 旧版本曾用 Noto(CFF) 提取出魔数为 OTTO 的假 .ttf，这里检测并自愈重建。
is_valid_ttf() {
    [ -s "$1" ] || return 1
    local magic
    magic=$(od -An -N4 -tx1 "$1" | tr -d ' \n')
    case "$magic" in
        00010000|74727565|74797031) return 0 ;;
        *) return 1 ;;
    esac
}

if is_valid_ttf "$FONT_TARGET"; then
    echo "字体文件已存在且为有效 TrueType，跳过准备"
    exit 0
fi

if [ -s "$FONT_TARGET" ]; then
    echo "现有 $FONT_TARGET 非 TrueType 轮廓（可能是旧版提取的 CFF 字体），删除重建"
    rm -f "$FONT_TARGET"
fi

# 查找系统中的文泉驿字体（仅 glyf 轮廓字体可被 reportlab 使用）
FONT_FILE=""
for f in /usr/share/fonts/truetype/wqy/wqy-microhei.ttc \
         /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc; do
    if [ -f "$f" ]; then
        FONT_FILE="$f"
        break
    fi
done

# 没有则安装文泉驿
if [ -z "$FONT_FILE" ]; then
    echo "未找到文泉驿字体，尝试安装 fonts-wqy-microhei fonts-wqy-zenhei..."
    if [ "$(id -u)" -eq 0 ]; then
        apt-get update -y -qq
        apt-get install -y -qq fonts-wqy-microhei fonts-wqy-zenhei
        for f in /usr/share/fonts/truetype/wqy/wqy-microhei.ttc \
                 /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc; do
            if [ -f "$f" ]; then
                FONT_FILE="$f"
                break
            fi
        done
    fi
    if [ -z "$FONT_FILE" ]; then
        echo "错误：无中文字体可用（非 root 且系统未装文泉驿）" >&2
        exit 1
    fi
fi

echo "从 TTC 提取第一个字型到 $FONT_TARGET：$FONT_FILE"
python3 - "$FONT_FILE" <<'PY'
import sys
from fontTools.ttLib import TTCollection

ttc_path = sys.argv[1]
out_path = "fonts/cjk.ttf"
collection = TTCollection(ttc_path)
if not collection.fonts:
    print("TTC 中无字体", file=sys.stderr)
    sys.exit(1)
font = collection.fonts[0]
if "glyf" not in font:
    print(f"字体 {font['name'].getDebugName(4)} 不是 TrueType 轮廓，reportlab 无法使用", file=sys.stderr)
    sys.exit(1)
font.save(out_path)
print(f"提取完成：{out_path}（{font['name'].getDebugName(4)}）")
PY

# 兜底校验：产出的必须又是有效 TrueType
if ! is_valid_ttf "$FONT_TARGET"; then
    echo "错误：提取结果不是有效 TrueType 字体" >&2
    exit 1
fi

echo "中文字体准备完成：$FONT_TARGET"
