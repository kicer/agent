#!/usr/bin/env python3
# data-page 技能入口：把技能自带 templates/*.html 复制到会话任务目录的 app/templates/。
# 目标目录固定（SKILL.md 环境约定：页面必须在 app/ 下才能被 /app/{task_id}/ 访问）。
# 不开 dest 参数：manager 对已是绝对路径的参数不做沙箱校验，开放 dest = 开放任意目录写入；
# 且路径写死在文档流程里，可配置只会造成漂移。
# 已存在的同名文件跳过不覆盖（AI 改过的模板要能经受重跑）；纯 stdlib，无 requirements。
# cwd 契约：远端模式（生产）cwd 即会话任务目录；本地模式 cwd 是技能目录——
# 那会把模板抄进技能家，检测到直接报错拒跑（手动调试请 cd 到任务目录再运行）。
import json
import os
import shutil
import sys
from pathlib import Path


def main():
    if len(sys.argv) >= 2 and sys.argv[1].strip():
        try:
            args = json.loads(sys.argv[1])
            if not isinstance(args, dict):
                raise ValueError('input_args 必须是 JSON 对象')
            if args:
                print('本技能无参数（模板固定复制到任务目录 app/templates/），收到：'
                      + json.dumps(args, ensure_ascii=False), file=sys.stderr)
                return 1
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

    dest = (Path.cwd() / 'app' / 'templates').resolve()
    if str(dest) == str(skill_dir) or str(dest).startswith(str(skill_dir) + os.sep):
        print('当前工作目录不是会话任务目录（本地直跑 cwd=技能目录会污染技能；'
              '生产经 executor 运行天然正确，手动调试请 cd 到任务目录再跑）', file=sys.stderr)
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
