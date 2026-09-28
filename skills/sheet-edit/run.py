#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sheet-edit 技能入口。接收一个 JSON 参数，分发到对应 op。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import UserError, ops


HANDLERS = {
    'inspect': ops.inspect,
    'apply': ops.apply,
    'insert_rows': ops.insert_rows,
    'delete_rows': ops.delete_rows,
    'insert_cols': ops.insert_cols,
    'delete_cols': ops.delete_cols,
}


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        _err("用法: run.py '<json>'")
        return 1
    try:
        args = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        _err(f"input_args JSON 解析失败: {e}")
        return 1
    if not isinstance(args, dict):
        _err("input_args 必须是 JSON 对象")
        return 1

    op = args.get('op')
    handler = HANDLERS.get(op)
    if not handler:
        _err(f"未知 op: {op!r}（支持: {', '.join(HANDLERS.keys())}）")
        return 1

    try:
        result = handler(args)
        # default=str 兕底：任何漏网的不可序列化值降级为字符串，不让整次运行因输出崩掉
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 0
    except UserError as e:
        _err(str(e))
        return 1
    except Exception as e:
        _err(f"内部错误: {type(e).__name__}: {e}")
        return 1


def _err(msg):
    print(json.dumps({'ok': False, 'error': msg}, ensure_ascii=False))


if __name__ == '__main__':
    sys.exit(main())
