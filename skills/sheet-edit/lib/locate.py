"""内容定位：用列名 + 值找目标行/列。"""
from . import UserError


def is_formula(v) -> bool:
    return isinstance(v, str) and v.startswith('=')


def value_eq(a, b) -> bool:
    if a is None and b is None:
        return True
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) < 1e-9
    # 数字↔数字文本（CSV 往返后数值变文本，定位比较要能对上）
    if isinstance(a, str) != isinstance(b, str):
        try:
            return abs(float(a) - float(b)) < 1e-9
        except (TypeError, ValueError):
            return False
    return a == b


def build_col_map(ws, header_row: int) -> dict:
    """从表头行构建 {列名: 列号}。"""
    col_map = {}
    for c in range(1, ws.max_column + 1):
        v = ws.cell(header_row, c).value
        if v is None:
            continue
        name = str(v).strip()
        if not name:
            continue
        if name in col_map:
            raise UserError(f"表头行 {header_row} 存在重复列名: '{name}'")
        col_map[name] = c
    if not col_map:
        raise UserError(f"表头行 {header_row} 为空，无法识别列名")
    return col_map


def find_row(ws, col_map: dict, match: dict, header_row: int) -> int:
    """用 match（列名 → 值）找唯一匹配的行号。"""
    if not isinstance(match, dict) or not match:
        raise UserError("match 必须是非空对象")

    for k in match:
        if k not in col_map:
            raise UserError(
                f"表头无此列: '{k}'（可用: {', '.join(col_map.keys())}）"
            )

    hits = []
    for r in range(header_row + 1, ws.max_row + 1):
        ok = True
        for col_name, want in match.items():
            v = ws.cell(r, col_map[col_name]).value
            if not value_eq(v, want):
                ok = False
                break
        if ok:
            hits.append(r)

    if not hits:
        raise UserError(f"找不到匹配行: {match}")
    if len(hits) > 1:
        raise UserError(f"匹配到 {len(hits)} 行，需增加条件: {match}")
    return hits[0]


def find_col(col_map: dict, name: str) -> int:
    if name not in col_map:
        raise UserError(
            f"表头无此列: '{name}'（可用: {', '.join(col_map.keys())}）"
        )
    return col_map[name]
