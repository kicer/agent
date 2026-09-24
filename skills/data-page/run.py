#!/usr/bin/env python3
# data-page 技能入口：把技能自带 templates/ 下的文件复制到会话任务目录的 .app/。
# 目标目录固定为 <任务目录>/.app/（不带 dest 参数：manager 对绝对路径参数不做沙箱
# 校验，开放 dest 等于开放任意目录写入；路径也已写死在文档流程里，可配置只会造成漂移）。
# 复制内容：
#   *.html        → .app/   页面模板（table / dashboard / kanban / nav 导航首页）
#   base.css      → .app/   共用样式
#   config-*.js   → .app/   配置骨架（AI 只改这些）
# 已存在的同名文件跳过不覆盖（重跑幂等，AI 改过的 config 不会被覆盖回默认）。
# 纯 stdlib，无 requirements。
# cwd 契约：生产模式下 cwd 即会话任务目录；本地直跑时 cwd 是技能目录——
# 那会把模板抄进技能家，检测到直接报错拒跑（手动调试请 cd 到任务目录再跑）。
import json
import os
import shutil
import sys
from pathlib import Path


def main():
    # ── 参数校验：本技能无参数 ─────────────────────────────
    if len(sys.argv) >= 2 and sys.argv[1].strip():
        try:
            args = json.loads(sys.argv[1])
            if not isinstance(args, dict):
                raise ValueError('input_args 必须是 JSON 对象')
            if args:
                print('本技能无参数，收到：' + json.dumps(args, ensure_ascii=False),
                      file=sys.stderr)
                return 1
        except (ValueError, json.JSONDecodeError) as e:
            print('参数解析失败：' + str(e), file=sys.stderr)
            return 1

    # ── 源目录：技能自带的 templates/ ──────────────────────
    skill_dir = Path(__file__).resolve().parent
    src = skill_dir / 'templates'
    if not src.is_dir():
        print('技能自身缺少 templates/ 目录：' + str(src), file=sys.stderr)
        return 1

    files = sorted(
        list(src.glob('*.html')) +
        list(src.glob('*.css')) +
        list(src.glob('config-*.js'))
    )
    if not files:
        print('templates/ 下没有可复制的文件', file=sys.stderr)
        return 1

    # ── 目标目录：<任务目录>/.app/ ─────────────────────────
    app_dir = (Path.cwd() / '.app').resolve()
    if str(app_dir) == str(skill_dir) or str(app_dir).startswith(str(skill_dir) + os.sep):
        print('当前工作目录不是会话任务目录（本地直跑 cwd=技能目录会污染技能；'
              '生产经 executor 运行天然正确，手动调试请 cd 到任务目录再跑）',
              file=sys.stderr)
        return 1

    app_dir.mkdir(parents=True, exist_ok=True)

    # ── 逐个复制，已存在则跳过 ─────────────────────────────
    copied, skipped = [], []
    for f in files:
        target = app_dir / f.name
        if target.exists():
            skipped.append(f.name)
        else:
            shutil.copy2(f, target)
            copied.append(f.name)

    # ── 输出结果 ───────────────────────────────────────────
    print('页面目录：' + str(app_dir))
    print('新复制 ' + str(len(copied)) + ' 个：'
          + (', '.join(copied) if copied else '无'))
    print('跳过（已存在，不覆盖）' + str(len(skipped)) + ' 个：'
          + (', '.join(skipped) if skipped else '无'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
