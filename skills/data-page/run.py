#!/usr/bin/env python3
# data-page 技能入口：把技能自带 templates/*.html 复制到会话任务目录的 app/templates/。
# 已存在的同名文件跳过不覆盖（AI 改过的模板要能经受重跑）；纯 stdlib，无 requirements。
import json
import os
import shutil
import sys
from pathlib import Path


def main():
    try:
        args = json.loads(sys.argv[1]) if len(sys.argv) >= 2 and sys.argv[1].strip() else {}
        if not isinstance(args, dict):
            raise ValueError('input_args 必须是 JSON 对象')
    except (ValueError, json.JSONDecodeError) as e:
        print('参数解析失败：' + str(e), file=sys.stderr)
        return 1

    skill_dir = Path(__file__).resolve().parent
    src = skill_dir / 'templates'
    if not src.is_dir():
        print('技能自身缺少 templates/ 目录：' + str(src), file=sys.stderr)
        return 1
    tpl = sorted(src.glob('*.html'))
    if not tpl:
        print('templates/ 下没有 .html 模板', file=sys.stderr)
        return 1

    # dest 建议显式传入（key 含 "dest"，skill manager 会按会话目录预转绝对路径）。
    # 缺省退回 cwd：远端模式 cwd 即会话目录；若退到技能目录内则明确报错，避免污染技能。
    dest = Path(args.get('dest') or os.path.join(os.getcwd(), 'app', 'templates'))
    if not dest.is_absolute():
        dest = dest.resolve()
    if str(dest) == str(skill_dir) or str(dest).startswith(str(skill_dir) + os.sep):
        print('dest 必须落在会话任务目录（请传 input_args {"dest": "app/templates"}）', file=sys.stderr)
        return 1

    dest.mkdir(parents=True, exist_ok=True)
    copied, skipped = [], []
    for f in tpl:
        target = dest / f.name
        if target.exists():
            skipped.append(f.name)
        else:
            shutil.copy2(f, target)
            copied.append(f.name)

    print('模板目录：' + str(dest))
    print('新复制 ' + str(len(copied)) + ' 个：' + (', '.join(copied) if copied else '无'))
    print('跳过（已存在，不覆盖）' + str(len(skipped)) + ' 个：' + (', '.join(skipped) if skipped else '无'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
