"""内容定位：用列名 + 值找目标行/列。"""
from . import UserError


def is_formula(v) -> bool:
    return isinstance(v, str) and v.startswith('=')


def detect_header_row(ws, scan=10, col_cap=200) -> int:
    """扫描前 scan 行猜表头行（只读不写，纯建议用）。

    候选条件：行内非空值 ≥ 2 且全部是普通字符串（排掉单值标题行和含数字/公式的数据行），行内不重复。
    取非空格数最多的最早候选行；找不到则回退 1。"""
    best_row, best_cnt = 1, 0
    max_c = min(ws.max_column, col_cap)
    for r in range(1, min(scan, ws.max_row) + 1):
        vals = []
        ok = True
        for c in range(1, max_c + 1):
            v = ws.cell(r, c).value
            if v is None or v == '':
                continue
            if isinstance(v, str) and not v.startswith('='):
                vals.append(v.strip())
            else:
                ok = False
                break
        if not ok or len(vals) < 2 or len(set(vals)) != len(vals):
            continue
        if len(vals) > best_cnt:
            best_row, best_cnt = r, len(vals)
    return best_row


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
        suggest = detect_header_row(ws)
        extra = f"；疑似真实表头在第 {suggest} 行，请传 header_row={suggest} 重试" if suggest != header_row else ''
        raise UserError(f"表头行 {header_row} 为空，无法识别列名{extra}")
    if len(col_map) == 1:
        # 典型现场：第 1 行是横跨全行的合并标题，单值被当成唯一列名
        suggest = detect_header_row(ws)
        if suggest != header_row:
            raise UserError(
                f"表头行 {header_row} 只解析出 1 列（'{next(iter(col_map))}'），像标题行；"
                f"疑似真实表头在第 {suggest} 行，请传 header_row={suggest} 重试"
            )
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
