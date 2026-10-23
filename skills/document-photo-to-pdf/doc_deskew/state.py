# -*- coding: utf-8 -*-
"""state.json v2 与 edits.json：归一化坐标、页面状态分级、编辑覆盖。

坐标约定
--------
corners_norm / edits 里的 "c" 一律是归一化 0~1，相对 exif_transpose 之后的
**原图**：[[x_tl,y_tl],[x_tr,y_tr],[x_br,y_br],[x_bl,y_bl]]。
原图像素坐标只在检测、渲染时用；进出 state 一律换成归一化，
换预览分辨率、换 UI 画布都不会错位。

页面状态（取代"整批失败"）
--------------------------
ready             已就绪，无需人看
review            建议看一眼（掩膜回退角点、覆盖率低、纸型存疑）
needs_orientation 宽高比接近正方形，横竖判不出来，需要人点旋转
needs_corners     必须补角（检测为空、框内纸面占比过低）
render_failed     出页失败，已用白页占位（极少见）
failed            原图打不开，本页已跳过（传错文件）
deleted           人主动删掉的页，不进出件

严重度只用来决定"一页命中多条规则时记哪一条"，不参与任何几何计算。
"""
import json
import os

STATE_SCHEMA = "document-photo-to-pdf/2"
EDITS_SCHEMA = "review/1"

# 顺序即严重度，越靠后越需要人介入
STATUS_ORDER = ["ready", "review", "needs_orientation",
                "needs_corners", "render_failed", "failed", "deleted"]
_SEV = {s: i for i, s in enumerate(STATUS_ORDER)}


# ---------------------------------------------------------------- 坐标

def norm_quad(quad, size):
    """原图像素坐标 -> 归一化 0~1（4 位小数，300dpi 往返误差远小于 1px）。"""
    w = float(size[0]) or 1.0
    h = float(size[1]) or 1.0
    return [[round(float(p[0]) / w, 4), round(float(p[1]) / h, 4)]
            for p in quad]


def denorm_quad(norm, size):
    """归一化 0~1 -> 原图像素坐标。"""
    w, h = float(size[0]), float(size[1])
    return [[float(p[0]) * w, float(p[1]) * h] for p in norm]


# ---------------------------------------------------------------- 状态

def escalate(status, reason, cand, cand_reason):
    """取更严重的一对 (status, reason)；同级保留先到的。"""
    if _SEV.get(cand, 0) > _SEV.get(status, 0):
        return cand, cand_reason
    return status, reason


def grade_page(meta, P, ref_ratio=None):
    """按方案第 6 节的表，把一页的检测数字转成"要不要人看"。

    纯路由：不重新检测、不改数字，只决定这一页在审核页上标不标 `!`。
    ref_ratio 是这张纸应有的宽高比（竖版为正）；None 表示未知，跳过纸型判断。
    """
    g = P["gate"]
    dead = g["aspect_deadband"]
    status, reason = "ready", None

    if meta.get("fallback"):
        status, reason = escalate(status, reason, "review", "mask_fallback")

    cov = meta.get("coverage") or {}
    if cov and min(float(v) for v in cov.values()) < g["coverage_warn"]:
        status, reason = escalate(status, reason, "review", "low_coverage")

    metrics = (meta.get("validation") or {}).get("metrics") or {}
    frac = metrics.get("inner_paper_frac")
    if frac is not None and float(frac) <= g["inner_paper_min"]:
        status, reason = escalate(status, reason,
                                  "needs_corners", "inner_paper_low")

    aspect = meta.get("aspect")
    if aspect:
        if abs(float(aspect) - 1.0) <= dead:
            # 横竖看不出来：不猜，交给人点旋转
            status, reason = escalate(status, reason,
                                      "needs_orientation", "aspect_ambiguous")
        elif ref_ratio:
            # 同向折算后再比：横放的 A4 不该被判成异形纸
            r = float(ref_ratio)
            if float(aspect) > 1.0:
                r = 1.0 / r if r > 0 else r
            dev = abs(float(aspect) - r) / r if r > 0 else 0.0
            if dev > g["paper_mismatch_pct"] / 100.0:
                status, reason = escalate(status, reason,
                                          "review", "paper_mismatch")
    return status, reason


# ---------------------------------------------------------------- edits

def _quad_ok(c):
    """校验归一化四边形：4 点、每点 2 数、范围放宽到 -1~2（角点允许拖出画面）。"""
    if not isinstance(c, (list, tuple)) or len(c) != 4:
        return None
    out = []
    for p in c:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            return None
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            return None
        # 方案第 11 节：纸被切掉一块时角点必须能拖到画面外，所以下限放到 -1
        if not (-1.0 <= x <= 2.0 and -1.0 <= y <= 2.0):
            return None
        out.append([x, y])
    return out


def _rot_ok(v):
    """旋转角归一到 0/90/180/270，认不出来按 0（不转）处理。"""
    try:
        r = int(round(float(v))) % 360
    except (TypeError, ValueError):
        return 0
    return r if r in (0, 90, 180, 270) else 0


def load_edits(value):
    """把 edits.json 读成内部结构；value 是路径、dict 或 None。

    只校验结构与范围，不认识的多余字段一律忽略——前端的版本总比后端快，
    不该因为多了一个字段就拒绝出件。
    """
    if value is None or value == "" or value == {}:
        return None
    if isinstance(value, str):
        path = os.path.abspath(os.path.expanduser(value.strip()))
        if not os.path.isfile(path):
            raise ValueError("edits 文件不存在：%s" % path)
        with open(path, "r", encoding="utf-8") as f:
            value = json.load(f)
    if not isinstance(value, dict):
        raise ValueError("edits 必须是 JSON 对象或 edits.json 路径")

    batch = value.get("batch")
    batch = dict(batch) if isinstance(batch, dict) else {}

    pages = {}
    for item in (value.get("pages") or []):
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("i"))
        except (TypeError, ValueError):
            continue
        if idx < 1:
            continue
        rec = {}
        q = _quad_ok(item.get("c"))
        if q:
            rec["corners_norm"] = q
        if item.get("r") is not None:
            rec["rotate"] = _rot_ok(item.get("r"))
        if rec:
            pages[idx] = rec

    order = []
    for v in (value.get("order") or []):
        try:
            order.append(int(v))
        except (TypeError, ValueError):
            continue
    # order 缺省/为空 = 按 images 传入顺序出件，调用方自己兜底

    deleted = set()
    for v in (value.get("deleted") or []):
        try:
            deleted.add(int(v))
        except (TypeError, ValueError):
            continue

    return {"schema": EDITS_SCHEMA, "batch": batch, "pages": pages,
            "order": order, "deleted": deleted}


# ---------------------------------------------------------------- state v2

_STATE_PAGE_KEYS = ("index", "source", "source_size", "auto_corners",
                    "corners_norm", "rotate", "rotate_source",
                    "status", "reason")


def build_state(batch, pages):
    """state.json v2：只放重建这次结果需要的东西，不放 PDF 检验数据。

    pages 项由调用方组装好，这里只裁字段、保顺序，不再做判断。
    """
    return {
        "schema": STATE_SCHEMA,
        "batch": {
            "doc_type": batch.get("doc_type"),
            "paper": batch.get("paper"),
            "enhance": batch.get("enhance"),
            "dpi": batch.get("dpi"),
            "orientation": batch.get("orientation"),
        },
        "pages": [{k: p.get(k) for k in _STATE_PAGE_KEYS} for p in pages],
    }


def load_state(value):
    """读上一份 state v2（可选输入）：按 index 取 auto_corners，供"恢复自动"。

    缺文件、旧 schema、字段不全都当成没传——state 是参考，不是契约。
    """
    if value in (None, ""):
        return {}
    try:
        if isinstance(value, str):
            path = os.path.abspath(os.path.expanduser(value.strip()))
            if not os.path.isfile(path):
                return {}
            with open(path, "r", encoding="utf-8") as f:
                value = json.load(f)
        if not isinstance(value, dict) or value.get("schema") != STATE_SCHEMA:
            return {}
        out = {}
        for item in (value.get("pages") or []):
            if isinstance(item, dict) and item.get("index") is not None:
                out[int(item["index"])] = item
        return out
    except Exception:
        return {}
