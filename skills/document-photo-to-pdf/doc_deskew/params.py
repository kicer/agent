# -*- coding: utf-8 -*-
"""document-photo-to-pdf 的全部可调参数。

改这里之前先读这段：
  - 这些值大多沿用旧流程（人工读网格图）的经验值，**没有用真实样张重新标定**。
    没有样张时只改行为开关，不要凭感觉调阈值。
  - 像素类的值默认指“检测处理图”坐标（检测会先缩到 detect.max_side），不是原图像素；
    带 _frac / _pct / _div 的是比例。少数原图/画布坐标的值会在字段名里写明 _px。
  - 纸张尺寸用毫米，画布像素由 render.dpi 换算，避免 1240/1754 这类数字散落各处。
"""
P = {
    "schema": "document-photo-to-pdf/2",

    # ---------------------------------------------------------------- 检测
    "detect": {
        "max_side": 1600,              # 检测降采样长边；越大越准越慢
        "min_edge_points": 40,         # 单边拟合所需最少点数，低于则回退掩膜线
        "group_tol_px": 22.0,          # 边线点归属容差（处理图像素）
        "robust_px": 2.0,              # 稳健拟合的残差基准（处理图像素）
        "mask_erode_kernel": 3,        # 掩膜内收核；3 = 半径 1 像素
        "paper_otsu_floor": 0.50,      # 纸面阈值下限，防止亮桌面被并入
        "paper_v_min": 0.50,           # 纸面亮度硬下限
        "paper_s_max": 0.45,           # 纸面饱和度上限
        "paper_mask_factor_div": 400,  # 掩膜降采样倍数 = min(H,W)//该值
        "paper_close_div": 60,         # 第一次闭运算核 = min(H,W)//该值
        "paper_close_min": 5,          # 形态学核最小值
        "paper_close2_div": 80,        # 第二次闭运算核 = min(H,W)//该值
        "band_div": 45,                # 搜索环带宽度 = H//该值
        "band_min": 15,                # 环带宽度下限
        "edge_local_gain": 1.55,       # 边缘图局部阈值增益
        "edge_low": 0.035,             # 边缘图绝对下限
        "edge_sigma_div": 800,         # 高斯模糊 sigma = H//该值
        "edge_box_div": 50,            # 局部均值窗口 = H//该值
        "step_r_small": 10,            # 阶跃检测小窗半径
        "step_r_big": 24,              # 阶跃检测大窗半径
        "step_th": 0.055,              # 跨纸边亮度阶跃阈值
        "cand_close_div": 160,         # 候选边线闭运算 = H//该值
        "cand_close_min": 5,
        "cand_open_div": 500,          # 候选边线开运算 = H//该值
        "cand_open_min": 3,
        "coverage_tol_div": 110,       # 覆盖率检测容差 = H//该值
        "coverage_tol_min": 10,
        "corner_oob_frac": 0.15,       # 角点越界允许幅度（相对画面长边）
        "boundary_side_margin": 0.10,  # 拟合单边时排除两端各 10%，避开角点
    },

    # ---------------------------------------------------------------- 几何门槛
    "gate": {
        "oob_max_pct": 15.0,           # 越界超过此值判失败
        "inner_paper_min": 0.60,       # 框内纸面占比下限
        "inner_edge_min": 0.75,        # 每边内侧纸面占比下限
        "outer_dark_min": 0.35,        # 外侧暗像素占比低于此值只告警
        "coverage_warn": 0.40,         # 四边覆盖率低于此值告警（未标定）
        "aspect_deadband": 0.10,       # 0.9~1.1 视为接近正方形，不参与方向投票
        "paper_mismatch_pct": 20.0,    # 与批次中位宽高比偏差超过此值告警
        "sample_n": 60,                # 校验采样网格边长
        "sample_shrink": 0.88,         # 框内采样内收比例
        "fallback_inset": 0.03,        # 检测为空时的兜底矩形：画面短边向内缩的比例
    },

    # ---------------------------------------------------------------- 调色档
    # 全局四档，对应审核页的“图像处理”。都是“整体等比映射 + 可选灰度”：
    # 不做二值化——二值化会吃拮抗锯齿，笔画变胖变瘦，等于重绘文字。
    "enhance": {
        "original": None,                            # 原样：不提亮
        "normal":   {"target": 245, "pct": 97},      # 标准
        "strong":   {"target": 252, "pct": 90},      # 加强：背景白得更彻底
        "bw":       {"target": 252, "pct": 60, "gray": True},  # 黑白（保留灰阶）
    },

    # ---------------------------------------------------------------- 出页
    "render": {
        "dpi": 150,                    # PDF 输出 dpi
        "margin_px": 40,               # PDF 页面四周留白（150dpi 下的像素）
        "brighten_target": 245,        # 提亮目标：97 分位映射到该亮度
        "brighten_pct": 97,
        "warp_chunk_rows": 256,        # 透视变换分块行数，控制峰值内存
        "default_paper": "auto",       # auto=按批次中位比例统一版式，A4 画布内留白
        "default_enhance": "normal",    # 调色档默认值，可选 key 见 P["enhance"]
        "enhance": "normal",           # 本次生效的调色档（run.py 按参数覆写副本）
        "dpi_options": {"standard": 150, "high": 300},  # 清晰度档名 -> dpi
        "papers_mm": {
            "a4": (210.0, 297.0),
            "letter": (215.9, 279.4),
            "16k": (185.0, 260.0),
            "b5": (176.0, 250.0),
        },
    },

    # ---------------------------------------------------------------- PDF 检验
    "check": {
        "dpi": 100,                    # 检验渲染 dpi
        "min_short": 800,              # 纸面短边下限（按 150dpi 基准，随 dpi 换算）
        "ratio_tol": 0.08,             # 纸面比例偏差提示阈值（仅提示）
        "border_ratio": 0.80,          # 边带亮度 / 纸面亮度 下限
        "edge_warnings": False,       # 边缘背景残留/内容贴边是否升为 warning
                                       # （启发式、未标定，误报多；默认只留在 checks）
        "edge_dark_ratio": 0.60,       # 边带“暗像素”亮度 / 纸面亮度
        "edge_dark_frac": 0.35,        # 边带暗像素占比上限
        "cut_frac": 0.05,              # 最外带内文字级暗像素占比上限
        "cut_mean_ratio": 0.70,        # 贴边带均值低于纸面该比例才算成片暗
        "edge_inset_frac": 0.002,      # 纸面框内缩比例，避开透视采样毛边
        "border_band_frac": 0.012,     # 边带宽度 = 纸面短边 * 该值
        "cut_band_frac": 0.003,        # 贴边检测带宽度 = 纸面短边 * 该值
        "paper_pct": 80,               # 纸面亮度分位
        "back_pct": 2,                 # 背景亮度分位
        "ink_ratio": 0.80,             # 墨色阈值上限 = 纸面亮度 * 该值
        "flat_pct": 99.5,              # 页面纯白分位
        "nonwhite_delta": 8.0,         # 低于纯白该值视为非白（用于找纸面框）
        "paper_row_frac": 0.05,        # 行列非白占比阈值
        "tmp_dir": ".tmp/pdfcheck",    # 检验渲染临时目录（相对输出目录，检验完即删）
    },

    # ---------------------------------------------------------------- 输出
    "output": {
        "default_name": "文档照片_校正.pdf",
        "state_suffix": ".state.json",
        "max_logs": 20,
    },
}
