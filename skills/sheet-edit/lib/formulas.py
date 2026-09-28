"""调整 Excel 公式中的单元格引用（插入/删除行列）。

基于 openpyxl 官方 Tokenizer 逐 token 重写，只动 RANGE——裸正则会犯的经典错误这里都不存在：
- 函数名（LOG10(、ATAN2(）是 OPEN token、字符串字面量是 TEXT token，永不触碰；
- RANGE token 值自带 sheet 前缀（OTHER!D3:D9、'My Sheet'!A1），可以精确判断引用指向**哪张表**。

调整规则（对齐 Excel）：
- 无 sheet 前缀：公式所在表 == 目标表才动；
- 有前缀：前缀 == 目标表才动；目标表公式引用其他表 → 不动（Excel 同样不动）。
- 插入（delete=False）：端点 >= at → +count（区间两端独立移动 = Excel 的区间扩张）。
- 删除（count 行/列从 at 起）：端点 >= at+count → -count；单引用落在删除区间内 → #REF!；
  区间端点落在删除区间内 → 收缩（起点→at、终点→at-1），与 Excel 行为一致；区间整体被删 → #REF!。
- 绝对引用（$A$1）同样移动——Excel 的插删会改写绝对引用（区别于复制填充）。

不静默改坏（遇到即 UserError 拒绝）：
- 外部簿引用（[Book.xlsx]Sheet!A1）；
- 解析不了的结构化引用（Table1[金额] 之类）。
不调整（保持原样，SKILL.md 有说明）：
- 命名范围（Tokenizer 归为非 RANGE token，天然不动）。
"""
import re

from openpyxl.formula.tokenizer import Tokenizer
from openpyxl.utils import column_index_from_string, get_column_letter

from . import UserError

# RANGE 端点形态：$?COL$?ROW / $ROW / $COL
_CELL_EP = re.compile(r'^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$')
_ROW_EP = re.compile(r'^(\$?)(\d+)$')
_COL_EP = re.compile(r'^(\$?)([A-Za-z]{1,3})$')
# 带引号的 sheet 前缀：'My Sheet'!A1
_QUOTED_PREFIX = re.compile(r"^'([^']*)'!(.+)$", re.S)


def _norm_sheet(name):
    return str(name).strip().lower()


def _split_ref(value):
    """'OTHER!D3:D9' → ('OTHER', 'D3:D9')；'D3' → (None, 'D3')。"""
    if value.startswith("'"):
        m = _QUOTED_PREFIX.match(value)
        if m:
            return m.group(1), m.group(2)
        raise UserError(f"不支持的引用语法：{value!r}")
    if '!' in value:
        sheet, rest = value.split('!', 1)
        if sheet.startswith('[') or '[' in sheet:
            raise UserError(f"不支持外部工作簿引用：{value!r}（请先把跨簿公式改成本表/本簿引用）")
        return sheet, rest
    return None, value


def _endpoint_axis_shape(ep):
    """返回 (kind, col_letters_or_None, row_num_or_None, col_abs, row_abs)。"""
    m = _CELL_EP.match(ep)
    if m:
        col_abs, col, row_abs, row = m.groups()
        return 'cell', col.upper(), int(row), col_abs, row_abs
    m = _ROW_EP.match(ep)
    if m:
        return 'row', None, int(m.group(2)), '', m.group(1)
    m = _COL_EP.match(ep)
    if m:
        return 'col', m.group(2).upper(), None, m.group(1), ''
    raise UserError(f"不支持的引用语法（结构化引用/特殊形式）：{ep!r}")


def _shift_pair(nums, at, count, delete):
    """区间两端点在同一轴上的数值移动；返回 None 表示整体失效（#REF!）。"""
    out = []
    for i, v in enumerate(nums):
        if not delete:
            out.append(v + count if v >= at else v)
        elif v < at:
            out.append(v)
        elif v < at + count:
            if len(nums) == 1:
                return [None]
            out.append(at if i == 0 else at - 1)
        else:
            out.append(v - count)
    if len(out) == 2 and out[1] < out[0]:
        return [None, None]
    return out


def _shift_endpoint_set(eps, axis, at, count, delete):
    """移动一组端点（1 个=单引用，2 个=区间），返回新端点字符串列表。"""
    shapes = [_endpoint_axis_shape(e) for e in eps]
    nums = []
    for kind, col, row, col_abs, row_abs in shapes:
        if kind == 'cell':
            nums.append(row if axis == 'row' else column_index_from_string(col))
        elif kind == 'row':
            nums.append(row if axis == 'row' else None)
        else:  # col
            nums.append(None if axis == 'row' else column_index_from_string(col))
    if any(n is None for n in nums):
        return eps  # 本轴不涉及的引用（整列引用遇行操作等）原样返回
    moved = _shift_pair(nums, at, count, delete)
    if moved[0] is None:
        return ['#REF!'] if len(eps) == 1 else ['#REF!', '#REF!']
    new_eps = []
    for (kind, col, row, col_abs, row_abs), v in zip(shapes, moved):
        if kind == 'cell':
            if axis == 'row':
                new_eps.append(f'{col_abs}{col}{row_abs}{v}')
            else:
                new_eps.append(f'{col_abs}{get_column_letter(v)}{row_abs}{row}')
        elif kind == 'row':
            new_eps.append(f'{row_abs}{v}')
        else:
            new_eps.append(f'{col_abs}{get_column_letter(v)}')
    return new_eps


def shift_formula(formula, owner_sheet, target_sheet, axis, at, count, delete=False):
    """重写一条公式中所有指向 target_sheet 的引用。

    owner_sheet: 公式所在表的表名；axis: 'row' | 'col'；at: 1-based 起始行/列。
    未被命中的公式原串返回（不经 Tokenizer 重组，零副作用）。
    """
    if not isinstance(formula, str) or not formula.startswith('='):
        return formula
    try:
        items = Tokenizer(formula).items
    except UserError:
        raise
    except Exception:
        raise UserError(f"公式语法解析失败（不支持的公式形式）：{formula!r}")
    items = Tokenizer(formula).items
    touched = False
    for tok in items:
        # openpyxl 3.1：引用格的判别是 type='OPERAND' + subtype='RANGE'（type 只到大类）
        if getattr(tok, 'subtype', None) != 'RANGE':
            continue
        if '#REF' in tok.value:
            continue  # 已失效引用：Excel 不会再调整它，原样保留
        sheet, body = _split_ref(tok.value)
        if sheet is None:
            points_target = _norm_sheet(owner_sheet) == _norm_sheet(target_sheet)
        else:
            points_target = _norm_sheet(sheet) == _norm_sheet(target_sheet)
        if not points_target:
            continue
        prefix_raw = tok.value[: len(tok.value) - len(body)]
        eps = body.split(':') if ':' in body else [body]
        if len(eps) > 2:
            raise UserError(f"不支持 3D/多段引用：{tok.value!r}")
        new_val = prefix_raw + ':'.join(_shift_endpoint_set(eps, axis, at, count, delete))
        if new_val != tok.value:
            tok.value = new_val
            touched = True
    if not touched:
        return formula
    return '=' + ''.join(t.value for t in items)
