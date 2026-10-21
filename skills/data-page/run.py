#!/usr/bin/env python3
# data-page 技能入口：把技能自带 templates/ 下的文件复制到会话任务目录的 .app/。
# 目标目录固定为 <任务目录>/.app/（不带 dest 参数：manager 对绝对路径参数不做沙箱
# 校验，开放 dest 等于开放任意目录写入；路径也已写死在文档流程里，可配置只会造成漂移）。
# 复制内容：
#   *.html / base.css → .app/   页面模板与共用样式（每次覆盖刷新）
#   config-*.js       → .app/   配置骨架（仅缺失时补，AI 只改这些）
# 复制语义按资产所有权分流：
#   *.html / *.css → .app/  模板与共用样式——每次运行覆盖刷新（SKILL 契约禁止改这些文件，
#                          覆盖无副作用；不覆盖则旧会话永远吃不到模板修复）。index.html 不在复制清单，永不碰。
#   config-*.js    → .app/  配置骨架——仅缺失时补默认，不覆盖 AI 已写好的配置。
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
                raise ValueError('技能参数必须是 JSON 对象')
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

    assets = sorted(list(src.glob('*.html')) + list(src.glob('*.css')))
    cfgs = sorted(src.glob('config-*.js'))
    if not assets:
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

    # ── 模板/样式：无条件覆盖刷新；config：仅补缺 ────────────
    refreshed = []
    for f in assets:
        shutil.copy2(f, app_dir / f.name)
        refreshed.append(f.name)
    created, kept = [], []
    for f in cfgs:
        target = app_dir / f.name
        if target.exists():
            kept.append(f.name)
        else:
            shutil.copy2(f, target)
            created.append(f.name)

    # ── 输出结果 ────────────────────────────────────
    print('页面目录：' + str(app_dir))
    print('刷新模板/样式 ' + str(len(refreshed)) + ' 个：' + ', '.join(refreshed))
    print('新建 config ' + str(len(created)) + ' 个：' + (', '.join(created) if created else '无')
          + '；沿用已有 config ' + str(len(kept)) + ' 个：' + (', '.join(kept) if kept else '无'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
