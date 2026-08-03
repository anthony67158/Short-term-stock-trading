"""
共享因子库 —— 训练管道与线上推理服务(app.py)使用同一套因子，保证一致。
仅依赖 numpy。所有函数纯计算，无 IO。
"""
import numpy as np

# 线上模型使用的因子顺序（训练/推理必须完全一致）
FEATURE_NAMES = [
    "mom5", "mom10", "mom20", "vs_ma20", "ma_bull",
    "vol20", "rsi", "vol_ratio", "vol_price_sync", "pos60", "mean_rev",
]


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

    # ATR(14) —— 用于目标价锚定（标签口径与线上建议一致）
    f["_atr"] = atr14(c, h, l)
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
