#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""document-photo-to-pdf 技能入口。

两种用法共用一条出件内核：
  全自动：{"images": [...], "output": "..."}
      只出 PDF，不碰 .app/、不写 data.db。
  半自动：{"images": [...], "review": "always|auto"}
      出 PDF，并把审核页发布到 .app/doc-review/、运行记录写进 data.db。
  重生成：{"batch_id": "dr..."}
      从 data.db 读上次的源图/输出/编辑，覆盖同名 PDF；args 带 edits 时以 edits
      为准，不带时读 doc_review_job.edits，再退化为当前页记录（按现在的角点再渲染）。

stdout 只输出一个 JSON 对象；进度、警告、异常都在字段里，不写 stderr。
失败也返回 exit 0，用 ok=false 表达（平台非 0 会给输出追加 [exit code]，破坏 JSON）。
"""
import io
import json
import os
import statistics
import sys
import time
import traceback

from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "doc_deskew"))

from params import P          # noqa: E402
from auto_quad import detect  # noqa: E402
from validate import validate # noqa: E402
import compose                # noqa: E402
import check                  # noqa: E402
import state                  # noqa: E402
import review_store           # noqa: E402
import review_page            # noqa: E402


# ---------------------------------------------------------------- 基础

def _err(code, message, page=None, hint=None):
    e = {"code": code, "message": message}
    if page is not None:
        e["page"] = int(page)
    if hint:
        e["hint"] = hint
    return e


def _json_default(o):
    try:
        import numpy as np
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
    except Exception:
        pass
    return str(o)


def load_image(path):
    """唯一的读图入口：转正 EXIF、压白透明底、转 RGB。"""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if (im.mode in ("RGBA", "LA")
                or (im.mode == "P" and "transparency" in im.info)):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, "white")
            bg.paste(im, mask=im.split()[-1])
            im = bg
        else:
            im = im.convert("RGB")
        im.load()
        return im


def parse_images(args):
    raw = args.get("images")
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw.strip()] if raw.strip() else []
    if isinstance(raw, (list, tuple)):
        out, seen = [], set()
        for v in raw:
            if not isinstance(v, str) or not v.strip():
                raise ValueError("images 里只能放路径字符串")
            p = v.strip()
            if p not in seen:
                seen.add(p)
                out.append(p)
        return out
    raise ValueError("images 必须是字符串或字符串数组")


def write_state(path, data):
    if not path:
        return False
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- 参数/路径

def _review_mode(args):
    if args.get("batch_id") and "review" not in args:
        return "always"
    v = args.get("review", "off")
    if isinstance(v, bool):
        return "always" if v else "off"
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "on"):
        s = "always"
    if s in ("0", "false", "no", ""):
        s = "off"
    if s not in ("off", "always", "auto"):
        raise ValueError("review 只能是 off/always/auto")
    return s


def _resolve_dpi(v, P):
    if v is None or str(v).strip() == "":
        return int(P["render"]["dpi"])
    s = str(v).strip().lower()
    opts = P["render"]["dpi_options"]
    if s in opts:
        return int(opts[s])
    try:
        n = int(float(s))
    except ValueError:
        raise ValueError("dpi 只能是 standard/high 或 72~600 的数字")
    if not (72 <= n <= 600):
        raise ValueError("dpi 超出范围（72~600）：%s" % v)
    return n


def _dpi_label(v, dpi):
    # 150/300 归一到审核页的两个档名，页面分段控件才能正确高亮；其它数值原样返回。
    if int(dpi) == 150:
        return "standard"
    if int(dpi) == 300:
        return "high"
    return str(dpi)


def _batch_opts(args, ed, P):
    b = (ed or {}).get("batch") or {}
    paper_input = b.get("paper", args.get("paper"))
    if paper_input is None or str(paper_input).strip() == "":
        paper_input = P["render"]["default_paper"]
    paper_input = str(paper_input).strip()
    paper = compose.resolve_paper(paper_input, P)

    orientation = str(b.get("orientation", args.get("orientation") or "auto")).strip().lower()
    if orientation not in ("auto", "none", "portrait", "landscape"):
        raise ValueError("orientation 只能是 auto/none/portrait/landscape")

    enhance = str(b.get("enhance", args.get("enhance") or P["render"]["default_enhance"])).strip().lower()
    if enhance not in P["enhance"]:
        raise ValueError("enhance 只能是 " + "/".join(P["enhance"].keys()))
    P["render"]["enhance"] = enhance

    dpi_arg = b.get("dpi", args.get("dpi"))
    dpi = _resolve_dpi(dpi_arg, P)
    P["render"]["dpi"] = dpi
    return paper_input, paper, orientation, enhance, _dpi_label(dpi_arg, dpi), dpi


def _inside(root, path):
    try:
        rel = os.path.relpath(os.path.abspath(path), os.path.abspath(root))
        return rel != ".." and not rel.startswith(".." + os.sep)
    except Exception:
        return False


def _rel(root, path):
    try:
        rel = os.path.relpath(os.path.abspath(path), os.path.abspath(root))
        if rel == ".." or rel.startswith(".." + os.sep):
            return os.path.abspath(path)
        return rel
    except Exception:
        return path


def _abs(root, path):
    p = str(path or "")
    return p if os.path.isabs(p) else os.path.join(root, p)


def _norm(quad, size):
    w = float(size[0]) or 1.0
    h = float(size[1]) or 1.0
    return [[round(float(p[0]) / w, 4), round(float(p[1]) / h, 4)]
            for p in quad]


def _denorm(norm, size):
    w, h = float(size[0]), float(size[1])
    return [[float(p[0]) * w, float(p[1]) * h] for p in norm]


def _aspect(quad):
    w, h = compose.aspect_of(quad)
    return round(float(w / h), 4)


def _fallback_quad(size, P):
    inset = float(P["gate"]["fallback_inset"])
    w, h = float(size[0]), float(size[1])
    return [[inset * w, inset * h], [(1 - inset) * w, inset * h],
            [(1 - inset) * w, (1 - inset) * h], [inset * w, (1 - inset) * h]]


def _prev_page(rows, idx):
    for r in rows or []:
        try:
            if int(r.get("idx")) == int(idx):
                return r
        except (TypeError, ValueError):
            continue
    return None


def _edits_from_pages(rows, batch):
    pages, deleted, order = [], [], []
    for r in rows or []:
        try:
            idx = int(r.get("idx"))
        except (TypeError, ValueError):
            continue
        if r.get("deleted"):
            deleted.append(idx)
            continue
        c = r.get("corners")
        if c:
            pages.append({"i": idx, "c": c, "r": int(r.get("rotate") or 0)})
        order.append(idx)
    b = {}
    if batch:
        b = {"paper": batch.get("paper"), "enhance": batch.get("enhance"),
             "dpi": batch.get("dpi"), "orientation": batch.get("orientation")}
    return state.load_edits({"schema": "review/1", "batch": b, "pages": pages,
                             "order": order, "deleted": deleted})


def _targets(args, batch_id):
    output_arg = args.get("output")
    if output_arg is not None:
        output_arg = str(output_arg).strip()
    cwd = os.getcwd()
    if batch_id:
        if args.get("db"):
            root = os.path.dirname(os.path.abspath(os.path.expanduser(str(args["db"]))))
        elif output_arg:
            root = os.path.dirname(os.path.abspath(os.path.expanduser(output_arg)))
        else:
            root = cwd
        conn = review_store.connect(root)
        batch = review_store.get_batch(conn, batch_id)
        if not batch:
            conn.close()
            raise ValueError("batch_id 不存在：%s" % batch_id)
        output = _abs(root, batch["output"])
        if not output.lower().endswith(".pdf"):
            output += ".pdf"
        return output, root, conn, batch

    output = os.path.abspath(os.path.expanduser(
        str(output_arg or P["output"]["default_name"])))
    if not output.lower().endswith(".pdf"):
        output += ".pdf"
    # 生产环境 cwd 就是会话目录；输出在会话内时以 cwd 为根，子目录输出也不会把
    # .app/data.db 建到子目录里。本地从别的目录跑时退化为输出目录。
    root = cwd if _inside(cwd, output) else os.path.dirname(output)
    return output, root, None, None


def _mark_error(conn, batch_id, message):
    if not conn or not batch_id:
        return
    try:
        review_store.set_job(conn, batch_id, "error", str(message))
        review_store.finish_batch(conn, batch_id, False, str(message), [], status="error")
    except Exception:
        pass


# ---------------------------------------------------------------- 主流程

def process(args, t0):
    review_mode = _review_mode(args)
    batch_id_arg = args.get("batch_id")
    batch_id_arg = str(batch_id_arg).strip() if batch_id_arg else None

    output, session_root, conn, batch_row = _targets(args, batch_id_arg)
    # 审核页由 core 从会话 .app/ 托管；输出不在会话目录内时页面/下载都不可达。
    if review_mode != "off" and not _inside(os.getcwd(), output):
        raise ValueError("审核页要求 PDF 位于会话目录内（当前工作目录）：%s" % output)

    use_db = bool(batch_id_arg) or review_mode != "off"
    if use_db and conn is None:
        conn = review_store.connect(session_root)

    batch_id = batch_id_arg
    is_new_batch = batch_id is None
    if use_db and not batch_id:
        batch_id = review_store.new_batch_id()

    state_path = os.path.splitext(output)[0] + P["output"]["state_suffix"]

    try:
        old_pages = []
        if batch_id_arg:
            if not batch_row:
                batch_row = review_store.get_batch(conn, batch_id)
            old_pages = review_store.get_pages(conn, batch_id)
            if not old_pages:
                raise ValueError("批次没有页面记录：%s" % batch_id)

        ed = state.load_edits(args.get("edits"))
        job = None
        if ed is None and batch_id:
            job = review_store.get_job(conn, batch_id)
            if job and job.get("edits_obj"):
                ed = state.load_edits(job["edits_obj"])
            else:
                ed = _edits_from_pages(old_pages, batch_row)
        if batch_id:
            if not job:
                job = review_store.get_job(conn, batch_id)
            if job:
                review_store.set_job(conn, batch_id, "running")

        paper_input, paper, orientation, enhance, dpi_label, dpi = \
            _batch_opts(args, ed, P)

        # ---------------- 源图清单
        if batch_id_arg:
            source_map = {}
            for r in old_pages:
                try:
                    source_map[int(r["idx"])] = _abs(session_root, r["source"])
                except (TypeError, ValueError):
                    continue
            all_indices = sorted(source_map)
        else:
            images = parse_images(args)
            if not images:
                raise ValueError("必须提供 images")
            all_indices = list(range(1, len(images) + 1))
            source_map = {i: os.path.abspath(os.path.expanduser(str(images[i - 1])))
                          for i in all_indices}

        deleted = set(ed.get("deleted") or []) if ed else set()
        run_indices = [i for i in all_indices if i not in deleted]
        if not run_indices:
            raise ValueError("所有页面都被删除，没有可处理的页")

        pages = []
        plan = []
        unreadable = []

        for idx in all_indices:
            src = source_map.get(idx)
            meta = {"index": idx, "source_abs": src, "warnings": [],
                    "deleted": idx in deleted}
            if meta["deleted"]:
                meta.update(status="deleted", reason="user_deleted",
                            corners=None, corners_norm=None, auto_corners=None,
                            auto_corners_norm=None, auto_rotate=0, rotated_deg=0)
                pages.append(meta)
                continue

            try:
                img = load_image(src)
            except Exception as e:
                err = _err(
                    "IMAGE_UNREADABLE",
                    "第 %d 页 %s 打不开：%s" % (idx, os.path.basename(src or ""), e),
                    idx,
                    "确认文件存在且是 jpg/png/webp/bmp/tif 等常见格式")
                meta.update(status="failed", reason="unreadable", error=err,
                            corners=None, corners_norm=None,
                            auto_corners=None, auto_corners_norm=None,
                            auto_rotate=0, rotated_deg=0)
                meta["warnings"].append(err["message"])
                unreadable.append(err)
                pages.append(meta)
                continue

            meta["source_size"] = [int(img.width), int(img.height)]
            edit = (ed or {}).get("pages", {}).get(idx) if ed else None
            manual = bool(edit and edit.get("corners_norm"))

            if manual:
                meta["manual"] = True
                meta["corners"] = _denorm(edit["corners_norm"], meta["source_size"])
                meta["corners_norm"] = [[float(x), float(y)]
                                        for x, y in edit["corners_norm"]]
                meta["aspect"] = _aspect(meta["corners"])
                meta["coverage"] = {}
                meta["paper_frac"] = None
                meta["fallback"] = False
                meta["fallback_sides"] = []
                meta["validation"] = {"ok": True, "metrics": {},
                                      "warnings": [], "failures": []}
                prev = _prev_page(old_pages, idx)
                if prev and prev.get("auto_corners"):
                    meta["auto_corners"] = prev["auto_corners"]
                    meta["auto_corners_norm"] = prev.get("auto_corners_norm")
                    meta["auto_rotate"] = int(prev.get("auto_rotate") or 0)
                else:
                    meta["auto_corners"] = [list(map(float, q))
                                            for q in meta["corners"]]
                    meta["auto_corners_norm"] = meta["corners_norm"]
                    meta["auto_rotate"] = 0
                meta["status"] = "ready"
                meta["reason"] = None
            else:
                try:
                    corners, info = detect(img, P)
                except Exception as e:
                    corners, info = [], {"error": str(e)}

                if not corners:
                    corners = _fallback_quad(meta["source_size"], P)
                    info = {"fallback": True, "fallback_sides": [0, 1, 2, 3],
                            "coverage": {}, "paper_frac": None}
                    meta["status"] = "needs_corners"
                    meta["reason"] = "detect_failed"
                else:
                    meta["status"] = "ready"
                    meta["reason"] = None

                meta["corners"] = [[float(x), float(y)] for x, y in corners]
                meta["corners_norm"] = _norm(meta["corners"], meta["source_size"])
                meta["auto_corners"] = [list(map(float, q))
                                        for q in meta["corners"]]
                meta["auto_corners_norm"] = meta["corners_norm"]
                meta["auto_rotate"] = 0
                meta["coverage"] = {k: round(float(v), 3)
                                    for k, v in (info.get("coverage") or {}).items()}
                pf = info.get("paper_frac")
                meta["paper_frac"] = None if pf is None else round(float(pf), 4)
                meta["fallback"] = bool(info.get("fallback", False))
                meta["fallback_sides"] = [int(s)
                                          for s in (info.get("fallback_sides") or [])]
                try:
                    v = validate(img, meta["corners"], P)
                except Exception as e:
                    v = {"ok": False, "metrics": {},
                         "failures": ["校验异常：%s" % e], "warnings": []}
                meta["validation"] = v
                if not v["ok"]:
                    # 检测到了但几何不可信：退回兜底框，交给人补角，而不是让整批失败。
                    # auto_corners 也要跟着换成兜底框，否则“恢复自动”会把无效角点拖回来。
                    meta["detected_corners"] = meta["corners"]
                    meta["corners"] = _fallback_quad(meta["source_size"], P)
                    meta["corners_norm"] = _norm(meta["corners"],
                                                 meta["source_size"])
                    meta["auto_corners"] = [list(map(float, q))
                                            for q in meta["corners"]]
                    meta["auto_corners_norm"] = meta["corners_norm"]
                    meta["status"] = "needs_corners"
                    meta["reason"] = "invalid_quad"
                meta["aspect"] = _aspect(meta["corners"])

            pages.append(meta)
            plan.append((idx, src, meta))
            img.close()

        if not plan:
            failures = unreadable or [
                _err("NO_PAGES", "没有可处理的页面", None,
                     "检查 images 是否都删除了/是否都打不开")]
            res = finish_failure(pages, failures, output, state_path, t0)
            _mark_error(conn, batch_id, res["summary"])
            return res

        # ---------------- 批次方向
        aspects = [m["aspect"] for (_, _, m) in plan]
        batch_orientation, orientation_source, median_aspect = \
            compose.decide_orientation(aspects, orientation, P)
        dead = P["gate"]["aspect_deadband"]
        if batch_orientation in ("portrait", "landscape"):
            same = [m["aspect"] for (_, _, m) in plan
                    if compose.classify(m["aspect"], dead) == batch_orientation]
            batch_median = float(statistics.median(same)) if same else float(median_aspect)
        else:
            batch_median = float(median_aspect)

        batch_ratio = None
        if paper["ratio"] is None and orientation != "none":
            m_class = compose.classify(batch_median, dead)
            if m_class == batch_orientation:
                batch_ratio = batch_median
            elif m_class != "square":
                batch_ratio = 1.0 / batch_median

        # 人工改过的页不再重新评级；自动页按方案表分级后与已有状态取较严重者
        # grade_page 的 ref_ratio 约定是「竖版为正」，横版批次要先折回竖版，否则
        # 所有横页都会被判成 paper_mismatch。
        ref_ratio = paper["ratio"]
        if ref_ratio is None:
            ref_ratio = batch_median
            if ref_ratio > 1.0:
                ref_ratio = 1.0 / ref_ratio
        for (_, _, m) in plan:
            if m.get("manual"):
                continue
            st2, r2 = state.grade_page(m, P, ref_ratio)
            m["status"], m["reason"] = state.escalate(
                m.get("status") or "ready", m.get("reason"), st2, r2)

        # ---------------- 出页
        out_meta = {}
        for (idx, src, meta) in plan:
            page_class = compose.classify(meta["aspect"], dead)
            auto_rotate = 0
            if orientation == "auto":
                if page_class not in ("square", batch_orientation):
                    auto_rotate = 90
            elif orientation in ("portrait", "landscape"):
                if page_class not in ("square", orientation):
                    auto_rotate = 90

            edit = (ed or {}).get("pages", {}).get(idx) if ed else None
            user_r = edit.get("rotate") if edit else None
            applied = int(user_r) if user_r is not None else auto_rotate
            applied = ((applied % 360) + 360) % 360
            if applied not in (0, 90, 180, 270):
                applied = 0

            out_corners = [list(map(float, q)) for q in meta["corners"]]
            for _ in range(applied // 90):
                out_corners = compose.rotate_quad_cw(out_corners)

            meta["rotated_deg"] = applied
            if not meta.get("manual"):
                meta["auto_rotate"] = auto_rotate

            if orientation == "none":
                out_aspect = _aspect(out_corners)
                page_orient = compose.classify(out_aspect, dead)
                if page_orient == "square":
                    page_orient = "portrait"
            elif orientation in ("portrait", "landscape"):
                page_orient = orientation
            else:
                # auto 模式下，用户显式旋转过就按旋转后的有效方向出画布；
                # 否则跟批次统一方向。否则 90° 旋转会把内容塞进反向画布压扁。
                if user_r is not None:
                    page_orient = compose.classify(_aspect(out_corners), dead)
                    if page_orient == "square":
                        page_orient = batch_orientation \
                            if batch_orientation in ("portrait", "landscape") \
                            else "portrait"
                else:
                    page_orient = batch_orientation

            out_ratio = None
            if batch_ratio is not None:
                eff_w, eff_h = compose.aspect_of(out_corners)
                eff = eff_w / eff_h
                if abs(eff - batch_ratio) / batch_ratio \
                        <= P["gate"]["paper_mismatch_pct"] / 100.0:
                    out_ratio = batch_ratio

            tw, th, canvas = compose.target_size(
                out_corners, paper, page_orient, P, out_ratio)

            try:
                img = load_image(src)
                try:
                    page = compose.warp_page(img, out_corners, (tw, th), P)
                finally:
                    img.close()
            except Exception as e:
                err = _err("INTERNAL",
                           "第 %d 页重新读取/透视变换失败：%s" % (idx, e), idx,
                           "重试；若持续出现请反馈")
                meta["status"] = "render_failed"
                meta["reason"] = "render_failed"
                meta["error"] = err
                meta["warnings"].append(err["message"])
                out_meta[idx] = {"page": None, "canvas": None, "error": err}
                continue

            meta["out_size"] = [int(tw), int(th)]
            meta["canvas_size"] = [int(canvas[0]), int(canvas[1])]
            meta["page_orientation"] = page_orient
            out_meta[idx] = {"page": page, "canvas": canvas, "error": None}

            cov = meta.get("coverage") or {}
            if cov:
                cmin = min(float(v) for v in cov.values())
                if cmin < P["gate"]["coverage_warn"]:
                    meta["warnings"].append(
                        "四边覆盖率最低 %.2f（低于 %.2f），角点可能不准"
                        % (cmin, P["gate"]["coverage_warn"]))
            if meta.get("reason") == "detect_failed":
                meta["warnings"].append(
                    "第 %d 页未检测到纸张四角，已用画面内缩兜底框出件；需人工补角"
                    % idx)
            elif meta.get("reason") == "invalid_quad":
                meta["warnings"].append(
                    "第 %d 页角点校验未通过，已用兜底框出件；需人工补角" % idx)
            elif meta.get("fallback"):
                names = ["上", "右", "下", "左"]
                sides = "、".join(names[s] for s in meta.get("fallback_sides", [])
                                  if 0 <= s < 4)
                if sides:
                    meta["warnings"].append(
                        "第 %s 边使用了掩膜回退角点，精度可能略低" % sides)
            for w in (meta.get("validation") or {}).get("warnings", []):
                meta["warnings"].append(w)
            if (not meta.get("manual") and batch_orientation != "mixed"
                    and batch_median > 0 and page_class == batch_orientation):
                dev = abs(meta["aspect"] - batch_median) / batch_median * 100.0
                if dev > P["gate"]["paper_mismatch_pct"]:
                    meta["warnings"].append(
                        "宽高比与批次中位相差 %.0f%%，可能不是同一种纸；"
                        "可改 paper=auto 或单独处理" % dev)
            if applied != 0 and user_r is None:
                meta["warnings"].append(
                    "方向与批次不一致，已旋转 %d°；文字方向需人工确认" % applied)

        # ---------------- 页序 / PDF
        order = []
        if ed and ed.get("order"):
            for v in ed["order"]:
                if v in out_meta and out_meta[v].get("page") is not None \
                        and v not in order:
                    order.append(v)
        for idx in sorted(out_meta.keys()):
            if out_meta[idx].get("page") is not None and idx not in order:
                order.append(idx)

        ordered_pages = [out_meta[i]["page"] for i in order]
        ordered_canvases = [out_meta[i]["canvas"] for i in order]
        if not ordered_pages:
            failures = unreadable or [
                _err("RENDER_FAILED", "所有页面都未能出页", None, "重试或检查原图")]
            res = finish_failure(pages, failures, output, state_path, t0)
            _mark_error(conn, batch_id, res["summary"])
            return res

        try:
            compose.build_pdf(ordered_pages, output, ordered_canvases, P)
        except Exception as e:
            err = _err("PDF_WRITE_FAILED", "写 PDF 失败：%s" % e, None,
                       "确认输出目录可写、磁盘空间足够")
            res = finish_failure(pages, [err], output, state_path, t0)
            _mark_error(conn, batch_id, res["summary"])
            return res

        # ---------------- 检验
        try:
            checks = check.inspect_pdf(output, len(ordered_pages),
                                       P["check"]["dpi"], P)
        except Exception as e:
            checks = {"ok": None, "error": str(e), "pages": [],
                      "page_count": None}

        warnings = []
        for m in pages:
            warnings.extend(m.get("warnings", []))
        if checks.get("ok") is None:
            warnings.append("PDF 自检无法执行：%s" % checks.get("error"))
        else:
            for item in checks.get("pages", []):
                orig = order[item["index"] - 1] if 0 < item["index"] <= len(order) \
                    else item["index"]
                if item.get("box_fallback"):
                    warnings.append(
                        "第 %d 页未能稳定识别纸面区域，边缘检验仅供参考" % orig)
                if not item["short_side_ok"]:
                    warnings.append(
                        "第 %d 页纸面短边 %dpx 偏低，可能分辨率不足"
                        % (orig, item["short_side_px"]))
                if not item["border_ok"]:
                    warnings.append(
                        "第 %d 页边缘有背景残留，角点可能落在背景上" % orig)
                if not item["cut_ok"]:
                    warnings.append(
                        "第 %d 页内容贴边，可能裁到了内容" % orig)
                if (paper["ratio"] is not None
                        and item["ratio_dev_pct"] > P["check"]["ratio_tol"] * 100):
                    warnings.append(
                        "第 %d 页纸面比例与页面相差 %.1f%%"
                        % (orig, item["ratio_dev_pct"]))
            pc = checks.get("page_count") or {}
            if pc and not pc.get("ok"):
                warnings.append(
                    "PDF 页数与出页数不一致（期望 %s，实际 %s）"
                    % (pc.get("expected"), pc.get("actual")))

        # ---------------- 记录顺序 / 审核状态
        sort_map = {idx: pos for pos, idx in enumerate(order)}
        next_sort = len(order)
        for idx in all_indices:
            if idx not in sort_map:
                sort_map[idx] = next_sort
                next_sort += 1

        needs = []
        for m in pages:
            if m.get("status") in ("review", "needs_corners", "needs_orientation",
                                   "render_failed", "failed"):
                needs.append(m)
        ready = sum(1 for m in pages if m.get("status") == "ready")

        # 发布审核页：always 总是发布；auto 只在有页需要人看时发布
        publish = review_mode == "always" or (review_mode == "auto" and bool(needs))
        url = None
        thumbs = {}
        if publish and batch_id:
            url, thumbs = review_page.publish(
                session_root, batch_id,
                [{"idx": m["index"], "source_abs": m.get("source_abs")}
                 for m in pages
                 if not m.get("deleted") and m.get("source_abs")])

        # ---------------- state v2 + 返回体
        order_all = sorted(pages, key=lambda m: (sort_map.get(m["index"], m["index"]),
                                                 m["index"]))
        pages_out = []
        state_pages = []
        for m in order_all:
            src_rel = _rel(session_root, m.get("source_abs") or "")
            applied = int(m.get("rotated_deg") or 0)
            auto_r = int(m.get("auto_rotate") or 0)
            pages_out.append({
                "index": m["index"],
                "source": src_rel,
                "source_size": m.get("source_size"),
                "corners": m.get("corners"),
                "corners_norm": m.get("corners_norm"),
                "auto_corners": m.get("auto_corners"),
                "auto_corners_norm": m.get("auto_corners_norm"),
                "rotate": auto_r,
                "applied_rotate": applied,
                "status": m.get("status"),
                "reason": m.get("reason"),
                "warnings": m.get("warnings") or [],
                "out_size": m.get("out_size"),
                "page_orientation": m.get("page_orientation"),
                "error": m.get("error"),
            })
            state_pages.append({
                "index": m["index"],
                "source": src_rel,
                "source_size": m.get("source_size"),
                "auto_corners": m.get("auto_corners"),
                "corners_norm": m.get("corners_norm"),
                "rotate": auto_r,
                "rotate_source": "manual" if m.get("manual") else "auto",
                "status": m.get("status"),
                "reason": m.get("reason"),
            })

        state_obj = state.build_state({
            "paper": paper_input,
            "enhance": enhance,
            "dpi": int(P["render"]["dpi"]),
            "orientation": orientation,
        }, state_pages)
        state_ok = write_state(state_path, state_obj)
        if not state_ok:
            warnings.append("state 文件写入失败：%s" % state_path)

        canvas_set = {tuple(c) for c in ordered_canvases}
        canvas_px = list(next(iter(canvas_set))) if len(canvas_set) == 1 else None
        batch = {
            "paper": str(paper_input),
            "orientation": "mixed" if orientation == "none" else batch_orientation,
            "orientation_source": orientation_source,
            "median_aspect": round(float(batch_median), 4),
            "rotated_pages": [m["index"] for m in pages
                              if int(m.get("rotated_deg") or 0) != 0],
            "canvas_px": canvas_px,
        }
        if canvas_px:
            margin = int(P["render"]["margin_px"])
            batch["content_px"] = [int(canvas_px[0] - 2 * margin),
                                   int(canvas_px[1] - 2 * margin)]

        if checks.get("ok") is False:
            summary = "%d 页已生成；自检有未通过项，见 warnings" % len(ordered_pages)
        elif needs:
            summary = "%d 页已生成；%d 页需人工确认" % (len(ordered_pages), len(needs))
        elif warnings:
            summary = "%d 页已生成；%d 项提示，请查看 warnings" % (
                len(ordered_pages), len(warnings))
        else:
            summary = "%d 页已生成；自检全部通过" % len(ordered_pages)

        res = {
            "schema": P["schema"],
            "ok": True,
            "summary": summary,
            "output": {
                "path": output,
                "state": state_path,
                "bytes": int(os.path.getsize(output)),
                "pages": len(ordered_pages),
                "dpi": int(P["render"]["dpi"]),
            },
            "batch": batch,
            "pages": pages_out,
            "checks": checks,
            "warnings": warnings,
            "elapsed_ms": int((time.time() - t0) * 1000),
        }
        if use_db:
            res["review"] = {
                "batch_id": batch_id,
                "published": bool(publish),
                "url": url,
                "ready": ready,
                "needs_attention": [
                    {"index": m["index"], "status": m.get("status"),
                     "reason": m.get("reason")} for m in needs
                ],
            }

        # ---------------- 写 data.db
        if use_db:
            output_rel = _rel(session_root, output)
            review_store.upsert_batch(conn, batch_id, output_rel, {
                "paper": paper_input, "enhance": enhance,
                "dpi": dpi_label, "orientation": orientation,
            })
            recs = []
            for m in pages:
                ti = thumbs.get(m["index"])
                size = m.get("source_size") or [None, None]
                rec = {
                    "idx": m["index"],
                    "source": _rel(session_root, m.get("source_abs") or ""),
                    "source_w": size[0], "source_h": size[1],
                    "auto_corners": m.get("auto_corners"),
                    "auto_corners_norm": m.get("auto_corners_norm"),
                    "corners": m.get("corners_norm"),
                    "auto_rotate": int(m.get("auto_rotate") or 0),
                    "rotate": int(m.get("rotated_deg") or 0),
                    "deleted": 1 if m.get("deleted") else 0,
                    "sort": sort_map.get(m["index"], m["index"]),
                    "status": m.get("status"),
                    "reason": m.get("reason"),
                    "thumb": ti[0] if ti else None,
                    "w": ti[1] if ti else (size[0] or None),
                    "h": ti[2] if ti else (size[1] or None),
                    "error": ((m.get("error") or {}).get("message")
                              if isinstance(m.get("error"), dict)
                              else m.get("error")),
                }
                recs.append(rec)
            review_store.replace_pages(conn, batch_id, recs)
            batch_status = "ready" if not needs else "review"
            review_store.finish_batch(conn, batch_id, True, summary,
                                      warnings, status=batch_status)
            if review_store.get_job(conn, batch_id):
                review_store.set_job(conn, batch_id, "done", summary)
            if is_new_batch:
                old, kept = review_store.prune(conn, keep=5, protect=batch_id)
                if old:
                    review_page.prune_dirs(session_root, kept)

        # 重生成路径给模型的回执要短：页面从 data.db 读详情，模型只需摘要/状态
        if batch_id_arg:
            res["pages"] = [{"index": m["index"], "status": m.get("status"),
                             "reason": m.get("reason")} for m in pages_out]
            res.pop("checks", None)
            res["compact"] = True
        return res

    except Exception as e:
        _mark_error(conn, batch_id, e)
        raise
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def finish_failure(pages, failures, output, state_path, t0):
    err = failures[0] if failures else _err("INTERNAL", "未知错误")
    warnings = []
    for m in pages:
        warnings.extend(m.get("warnings", []))
    res = {
        "schema": P["schema"],
        "ok": False,
        "summary": "失败：%s" % err.get("message", "未知错误"),
        "error": err,
        "pages": pages,
        "warnings": warnings,
        "elapsed_ms": int((time.time() - t0) * 1000),
    }
    if output:
        res["output"] = {"path": output, "state": state_path}
    return res


# ---------------------------------------------------------------- 入口

def main():
    t0 = time.time()
    buf = io.StringIO()
    old_stderr = sys.stderr
    sys.stderr = buf
    try:
        if len(sys.argv) != 2:
            raise ValueError(
                '用法：python3 run.py \'{"images": ["图1.jpg"]}\'')
        try:
            args = json.loads(sys.argv[1])
        except json.JSONDecodeError as e:
            raise ValueError("参数不是合法 JSON：%s" % e)
        if not isinstance(args, dict):
            raise ValueError("参数必须是 JSON 对象")
        res = process(args, t0)
    except Exception as e:
        code = "BAD_ARGS" if isinstance(e, ValueError) else "INTERNAL"
        hint = ("检查参数后重试" if code == "BAD_ARGS"
                else "可用 DOC_DESKEW_DEBUG=1 重跑查看堆栈")
        res = {
            "schema": P["schema"],
            "ok": False,
            "summary": "失败：%s" % e,
            "error": _err(code, str(e), None, hint),
            "pages": [],
            "warnings": [],
            "elapsed_ms": int((time.time() - t0) * 1000),
        }
        if os.environ.get("DOC_DESKEW_DEBUG"):
            res["logs"] = traceback.format_exc().splitlines()
    finally:
        sys.stderr = old_stderr

    logs = [line for line in buf.getvalue().splitlines() if line.strip()]
    if logs:
        res["logs"] = (res.get("logs", []) + logs)[:P["output"]["max_logs"]]

    print(json.dumps(res, ensure_ascii=False, separators=(",", ":"),
                     default=_json_default))
    return 0


if __name__ == "__main__":
    sys.exit(main())
