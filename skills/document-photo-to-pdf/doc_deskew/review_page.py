# -*- coding: utf-8 -*-
"""审核页发布：模板链接 + 每批缩略图，落会话 .app/doc-review/。

模板的单一事实源在 skill 目录的 web/；会话里的 index.html 只是指向它的符号链接，
不含任何数据注入。core 的 /app 静态托管放行指向技能根目录的链接（其余位置 404），
所以改一次模板就对所有会话生效，不用重新生成。页面运行时通过 /api/db 读 doc_review_*
表，因此同一份 HTML 可服务所有批次。缩略图是每会话的数据，仍写真目录。
"""
import os
import shutil

from PIL import Image, ImageOps

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
APP_SUBDIR = os.path.join(".app", "doc-review")
THUMB_LONG = 1200
THUMB_Q = 80


def _link(src, dst):
    """把技能里的静态文件以符号链接发布到会话目录。

    旧版本是复制副本，模板改动到不了已有会话；改链接后技能就是唯一真源。
    链接目标用绝对路径：executor 与 core 都把技能挂在同一位置，两边都能解析。
    """
    src = os.path.abspath(src)
    if os.path.islink(dst):
        try:
            if os.path.realpath(dst) == os.path.realpath(src):
                return
        except OSError:
            pass
        os.unlink(dst)
    elif os.path.exists(dst):
        os.unlink(dst)  # 旧会话的实体副本：删掉换成链接
    os.symlink(src, dst)


def publish(session_root, batch_id, pages):
    """发布模板与缩略图。

    pages: [{idx, source_abs}]；返回 (url, thumbs)，thumbs[idx] = (相对路径, w, h)。
    """
    app_dir = os.path.join(session_root, APP_SUBDIR)
    os.makedirs(app_dir, exist_ok=True)
    for name in sorted(os.listdir(WEB_DIR)):
        src = os.path.join(WEB_DIR, name)
        if os.path.isfile(src):
            _link(src, os.path.join(app_dir, name))

    thumb_dir = os.path.join(app_dir, batch_id)
    os.makedirs(thumb_dir, exist_ok=True)
    thumbs = {}
    for p in pages:
        src = p.get("source_abs")
        idx = p.get("idx")
        if not src or idx is None or not os.path.isfile(src):
            continue
        try:
            with Image.open(src) as raw:
                im = ImageOps.exif_transpose(raw).convert("RGB")
            w, h = im.size
            s = min(1.0, float(THUMB_LONG) / max(w, h))
            if s < 1.0:
                im = im.resize((max(1, int(round(w * s))), max(1, int(round(h * s)))),
                               Image.LANCZOS)
            name = "p%d.jpg" % int(idx)
            im.save(os.path.join(thumb_dir, name), "JPEG", quality=THUMB_Q, optimize=True)
            thumbs[int(idx)] = (batch_id + "/" + name, im.width, im.height)
        except Exception:
            continue
    task_id = os.path.basename(os.path.abspath(session_root))
    return ("/app/%s/doc-review/?b=%s" % (task_id, batch_id), thumbs)


def prune_dirs(session_root, keep_ids):
    """删除不在 keep_ids 里的旧批次缩略图目录（模板文件不动）。"""
    root = os.path.join(session_root, APP_SUBDIR)
    if not os.path.isdir(root):
        return
    keep = set(keep_ids)
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if os.path.isdir(path) and name not in keep:
            shutil.rmtree(path, ignore_errors=True)
