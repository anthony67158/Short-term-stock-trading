"""
共享因子库 —— 训练管道与线上推理服务(app.py)使用同一套因子，保证一致。
仅依赖 numpy。所有函数纯计算，无 IO。

v2（扩充版）：因子从 11 → 36，参考微软 qlib Alpha158 的量价/波动/位置/量能/统计风格，
全部纯 numpy 手算，线上 deploy_pkg 无需新增依赖。
兼容性：**只做加法**——原 11 个因子键(mom5/mom10/mom20/vs_ma20/ma_bull/vol20/rsi/
vol_ratio/vol_price_sync/pos60/mean_rev)与内部字段(_atr/_ma20/_last/_rets)全部保留，
因为 app.py 的规则兜底 score_from_factors / forecast / decide 直接引用它们。
"""
import numpy as np

# 线上模型使用的因子顺序（训练/推理必须完全一致；顺序变了也没关系，二者都从这里读）
FEATURE_NAMES = [
    # --- 原 11 个（保留，位置不动，兜底逻辑依赖）---
    "mom5", "mom10", "mom20", "vs_ma20", "ma_bull",
    "vol20", "rsi", "vol_ratio", "vol_price_sync", "pos60", "mean_rev",
    # --- 新增：多周期动量 ---
    "mom3", "mom60",
    # --- 新增：均线偏离 & 斜率 ---
    "vs_ma5", "vs_ma10", "vs_ma60", "ma_slope20",
    # --- 新增：多周期波动 & 振幅 & ATR ---
    "vol5", "vol60", "amp20", "atr_pct",
    # --- 新增：多周期 RSI & 位置 ---
    "rsi6", "pos20", "pos120", "dist_high60",
    # --- 新增：量能 & 价量关系 ---
    "vol_trend", "corr_pv", "obv_slope",
    # --- 新增：收益分布统计 ---
    "skew20", "kurt20", "win20", "streak",
    # --- 新增：经典技术指标 ---
    "max_dd60", "cci14", "wr14", "boll_pct",
]


def _finite(x, default=0.0):
    """把 nan/inf 归一到 default。"""
    x = float(x)
    return x if np.isfinite(x) else float(default)


def compute_factors(closes, highs, lows, vols):
    """给定截至某日的历史序列，计算当日因子快照。
    返回 dict，含 FEATURE_NAMES 全部键，外加内部字段 _ma20/_last/_rets/_atr。"""
    c = np.asarray(closes, float)
    h = np.asarray(highs, float)
    l = np.asarray(lows, float)
    v = np.asarray(vols, float)
    n = len(c)
    last = c[-1]
    f = {}

    def sma(a, k):
        return float(np.mean(a[-k:])) if len(a) >= k else float(np.mean(a))

    def std_tail(a, k):
        return float(np.std(a[-k:])) if len(a) >= k else (float(np.std(a)) if len(a) else 0.0)

    # ========== 原 11 个因子（逐字保留，兜底逻辑依赖）==========
    f["mom5"] = (last / c[-6] - 1) * 100 if n > 5 else 0.0
    f["mom10"] = (last / c[-11] - 1) * 100 if n > 10 else 0.0
    f["mom20"] = (last / c[-21] - 1) * 100 if n > 20 else 0.0
    ma5, ma10, ma20 = sma(c, 5), sma(c, 10), sma(c, 20)
    f["vs_ma20"] = (last / ma20 - 1) * 100 if ma20 else 0.0
    f["ma_bull"] = 1.0 if (ma5 >= ma10 >= ma20) else (-1.0 if (ma5 <= ma10 <= ma20) else 0.0)
    rets = np.diff(c) / c[:-1] * 100
    f["vol20"] = float(np.std(rets[-20:])) if len(rets) >= 20 else (float(np.std(rets)) if len(rets) else 1.0)
    gain = float(np.sum(np.clip(rets[-14:], 0, None)))
    loss = float(-np.sum(np.clip(rets[-14:], None, 0)))
    f["rsi"] = 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)
    f["vol_ratio"] = float(np.mean(v[-5:]) / (np.mean(v[-20:]) + 1e-9)) if n >= 20 else 1.0
    up_vol = sum(1 for i in range(max(1, n - 20), n) if rets[i - 1] > 0 and v[i] > np.mean(v[-20:]))
    f["vol_price_sync"] = up_vol / max(1, min(20, n - 1))
    hi60, lo60 = float(np.max(h[-60:])), float(np.min(l[-60:]))
    f["pos60"] = (last - lo60) / (hi60 - lo60) * 100 if hi60 > lo60 else 50.0
    up_rev = up_cnt = dn_rev = dn_cnt = 0
    for i in range(len(rets) - 1):
        if rets[i] > 3:
            up_cnt += 1; up_rev += 1 if rets[i + 1] < 0 else 0
        if rets[i] < -3:
            dn_cnt += 1; dn_rev += 1 if rets[i + 1] > 0 else 0
    f["mean_rev"] = ((up_rev / up_cnt if up_cnt else 0.5) + (dn_rev / dn_cnt if dn_cnt else 0.5)) / 2

    # ========== 新增因子 ==========
    ma60 = sma(c, 60)

    # --- 多周期动量 ---
    f["mom3"] = (last / c[-4] - 1) * 100 if n > 3 else 0.0
    if n > 60:
        f["mom60"] = (last / c[-61] - 1) * 100
    elif n > 1:
        f["mom60"] = (last / c[0] - 1) * 100
    else:
        f["mom60"] = 0.0

    # --- 均线偏离 & 斜率 ---
    f["vs_ma5"] = (last / ma5 - 1) * 100 if ma5 else 0.0
    f["vs_ma10"] = (last / ma10 - 1) * 100 if ma10 else 0.0
    f["vs_ma60"] = (last / ma60 - 1) * 100 if ma60 else 0.0
    # 20日均线相对5日前的斜率(%)：捕捉趋势拐头
    if n >= 25:
        ma20_prev = float(np.mean(c[-25:-5]))
        f["ma_slope20"] = (ma20 - ma20_prev) / ma20 * 100 if ma20 else 0.0
    else:
        f["ma_slope20"] = 0.0

    # --- 多周期波动 & 振幅 & ATR ---
    f["vol5"] = std_tail(rets, 5)
    f["vol60"] = std_tail(rets, 60) if len(rets) >= 60 else f["vol20"]
    # 日内振幅均值(近20日)：(high-low)/close
    amp = (h - l) / np.where(c == 0, np.nan, c) * 100
    amp = amp[np.isfinite(amp)]
    f["amp20"] = float(np.mean(amp[-20:])) if len(amp) >= 1 else 0.0
    atr = atr14(c, h, l)
    f["atr_pct"] = (atr / last) * 100 if last else 0.0

    # --- 多周期 RSI ---
    gain6 = float(np.sum(np.clip(rets[-6:], 0, None)))
    loss6 = float(-np.sum(np.clip(rets[-6:], None, 0)))
    f["rsi6"] = 100.0 if loss6 == 0 else 100 - 100 / (1 + gain6 / loss6)

    # --- 位置类 ---
    def pos_k(k):
        hik = float(np.max(h[-k:])) if n >= 1 else last
        lok = float(np.min(l[-k:])) if n >= 1 else last
        return (last - lok) / (hik - lok) * 100 if hik > lok else 50.0
    f["pos20"] = pos_k(20)
    f["pos120"] = pos_k(120)
    hi60_h = float(np.max(h[-60:]))
    f["dist_high60"] = (last / hi60_h - 1) * 100 if hi60_h else 0.0

    # --- 量能 & 价量关系 ---
    f["vol_trend"] = float(np.mean(v[-5:]) / (np.mean(v[-60:]) + 1e-9)) if n >= 60 else f["vol_ratio"]
    # 价量相关系数(近20日 收益 vs 量变化)
    if len(rets) >= 20 and n >= 21:
        vch = np.diff(v) / (v[:-1] + 1e-9)  # 量变化率，与 rets 同长
        r20 = rets[-20:]; q20 = vch[-20:]
        if np.std(r20) > 1e-9 and np.std(q20) > 1e-9:
            f["corr_pv"] = float(np.corrcoef(r20, q20)[0, 1])
        else:
            f["corr_pv"] = 0.0
    else:
        f["corr_pv"] = 0.0
    # OBV 斜率(近20日)：方向量能累积的归一化斜率
    if n >= 21:
        sign = np.sign(np.diff(c[-21:]))
        obv = np.cumsum(sign * v[-20:])
        xs = np.arange(len(obv))
        denom = (np.mean(v[-20:]) + 1e-9)
        slope = np.polyfit(xs, obv, 1)[0] if len(obv) >= 2 else 0.0
        f["obv_slope"] = float(slope / denom)
    else:
        f["obv_slope"] = 0.0

    # --- 收益分布统计（近20日）---
    r = rets[-20:] if len(rets) >= 20 else rets
    if len(r) >= 3 and np.std(r) > 1e-9:
        z = (r - np.mean(r)) / np.std(r)
        f["skew20"] = float(np.mean(z ** 3))
        f["kurt20"] = float(np.mean(z ** 4) - 3.0)
    else:
        f["skew20"] = 0.0; f["kurt20"] = 0.0
    f["win20"] = float(np.mean(r > 0)) if len(r) else 0.5
    # 连涨/连跌天数(带符号，tanh 归一到 -1..1)
    streak = 0
    if len(rets) >= 1:
        s = 1 if rets[-1] > 0 else (-1 if rets[-1] < 0 else 0)
        i = len(rets) - 1
        while i >= 0 and ((rets[i] > 0 and s > 0) or (rets[i] < 0 and s < 0)):
            streak += s; i -= 1
    f["streak"] = float(np.tanh(streak / 3.0))

    # --- 经典技术指标 ---
    # 近60日最大回撤(%)
    win = c[-60:] if n >= 60 else c
    if len(win) >= 2:
        peak = np.maximum.accumulate(win)
        dd = (win - peak) / peak
        f["max_dd60"] = float(np.min(dd) * 100)
    else:
        f["max_dd60"] = 0.0
    # CCI(14)
    tp = (h + l + c) / 3.0
    k = min(14, n)
    if k >= 2:
        tp_k = tp[-k:]
        sma_tp = float(np.mean(tp_k))
        md = float(np.mean(np.abs(tp_k - sma_tp)))
        f["cci14"] = float((tp[-1] - sma_tp) / (0.015 * md)) if md > 1e-9 else 0.0
    else:
        f["cci14"] = 0.0
    # Williams %R(14)：-100..0
    kk = min(14, n)
    hh = float(np.max(h[-kk:])); ll = float(np.min(l[-kk:]))
    f["wr14"] = (hh - last) / (hh - ll) * -100 if hh > ll else -50.0
    # 布林带 %b(20,2)
    if n >= 20:
        m = float(np.mean(c[-20:])); sd = float(np.std(c[-20:]))
        upper, lower = m + 2 * sd, m - 2 * sd
        f["boll_pct"] = (last - lower) / (upper - lower) * 100 if upper > lower else 50.0
    else:
        f["boll_pct"] = 50.0

    # ========== 统一清洗：FEATURE_NAMES 内的 nan/inf → 0 ==========
    for name in FEATURE_NAMES:
        f[name] = _finite(f.get(name, 0.0), 0.0)

    # ATR(14) —— 用于目标价锚定（标签口径与线上建议一致）
    f["_atr"] = atr
    f["_ma20"] = ma20
    f["_last"] = last
    f["_rets"] = rets
    return f


def atr14(closes, highs, lows, k=14):
    c = np.asarray(closes, float)
    h = np.asarray(highs, float)
    l = np.asarray(lows, float)
    if len(c) < 2:
        return 0.0
    prev_c = c[:-1]
    tr = np.maximum(h[1:] - l[1:], np.maximum(np.abs(h[1:] - prev_c), np.abs(l[1:] - prev_c)))
    kk = min(k, len(tr))
    return float(np.mean(tr[-kk:])) if kk else 0.0


def feature_vector(f):
    """把因子 dict 转成模型输入向量（顺序= FEATURE_NAMES）。"""
    return [float(f[name]) for name in FEATURE_NAMES]


def target_price(last, atr):
    """ATR 锚定的目标涨幅：max(3%, 0.8*ATR/价)。与线上建议口径一致。"""
    atr_pct = (atr / last) if last else 0.0
    return max(0.03, 0.8 * atr_pct)
