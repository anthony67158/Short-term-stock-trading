"""
共享因子库 —— 训练管道与线上推理服务(app.py)使用同一套因子，保证一致。
仅依赖 numpy。所有函数纯计算，无 IO。

v2（扩充版）：因子从 11 → 36，参考微软 qlib Alpha158 的量价/波动/位置/量能/统计风格，
全部纯 numpy 手算，线上 deploy_pkg 无需新增依赖。
兼容性：**只做加法**——原 11 个因子键(mom5/mom10/mom20/vs_ma20/ma_bull/vol20/rsi/
vol_ratio/vol_price_sync/pos60/mean_rev)与内部字段(_atr/_ma20/_last/_rets)全部保留，
因为 app.py 的规则兜底 score_from_factors / forecast / decide 直接引用它们。

v3（扩品类版）：因子 36 → 56，新增两类**正交**信息，突破"全是单股日线价量同源"的瓶颈：
  A) 大盘相对/市场状态（8 个）：超额动量、相对强弱斜率、beta、与大盘相关性、
     大盘动量/位置/波动率 regime。需传入 index_closes（与个股按日期对齐的大盘指数收盘序列）。
  B) 单股高阶价量（12 个）：隔夜跳空、日内强弱、上下影线、Chaikin 资金流(CMF)、
     资金流指标(MFI)、波动率的波动率、动量加速度、距60日低点、成交量 z 分、Amihud 非流动性。
     其中跳空/日内/影线需传入 opens（开盘价序列）。
设计约束：opens / index_closes 均为**可选**参数，缺失时对应因子取 0（优雅降级），
从而训练、线上 /predict、规则兜底三处口径永远一致，且任何一方缺数据都绝不报错。
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
# 注：compute_factors 内部仍会计算 v3 试验因子(大盘相对/单股高阶)，但经同一样本外
# holdout 科学对拍，这 20 个新因子净损害泛化(0.5966 vs 0.6140)，故不纳入 FEATURE_NAMES、
# 不进入模型输入。保留计算代码仅为可追溯，线上向量维度始终 36，与所部署模型严格一致。


def _finite(x, default=0.0):
    """把 nan/inf 归一到 default。"""
    x = float(x)
    return x if np.isfinite(x) else float(default)


def compute_factors(closes, highs, lows, vols, opens=None, index_closes=None):
    """给定截至某日的历史序列，计算当日因子快照。
    返回 dict，含 FEATURE_NAMES 全部键，外加内部字段 _ma20/_last/_rets/_atr。

    可选参数（v3）：
      opens         —— 开盘价序列（与 closes 等长、同步）。用于跳空/日内/影线因子；缺失取 0。
      index_closes  —— 大盘指数收盘序列（与个股按日期对齐、等长）。用于相对/市场状态因子；缺失取 0。
    两者缺失时对应因子安全归零，训练/线上/兜底口径一致，绝不报错。"""
    c = np.asarray(closes, float)
    h = np.asarray(highs, float)
    l = np.asarray(lows, float)
    v = np.asarray(vols, float)
    o = np.asarray(opens, float) if opens is not None and len(opens) == len(c) else None
    idx = np.asarray(index_closes, float) if index_closes is not None and len(index_closes) >= 2 else None
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

    # ========== v3 A：大盘相对 / 市场状态（index_closes 缺失 → 全 0）==========
    # 默认 0，仅在有对齐大盘序列时覆盖，保证缺数据也不报错。
    for kk in ("exc_mom5", "exc_mom20", "rs_slope20", "beta60", "corr_idx60",
               "idx_mom20", "idx_pos60", "idx_vol20"):
        f[kk] = 0.0
    if idx is not None:
        ic = idx
        m_len = min(len(ic), n)
        cc_al = c[-m_len:]; ic_al = ic[-m_len:]
        # 超额动量：个股涨幅 - 大盘涨幅（短线强弱本质是相对概念）
        if m_len > 5:
            stk5 = (cc_al[-1] / cc_al[-6] - 1) * 100
            idx5 = (ic_al[-1] / ic_al[-6] - 1) * 100
            f["exc_mom5"] = stk5 - idx5
        if m_len > 20:
            stk20 = (cc_al[-1] / cc_al[-21] - 1) * 100
            idx20 = (ic_al[-1] / ic_al[-21] - 1) * 100
            f["exc_mom20"] = stk20 - idx20
        # 相对强弱(RS = 个股/大盘 比值)的20日斜率：捕捉"跑赢/跑输大盘"的趋势
        if m_len >= 20:
            rs = cc_al / np.where(ic_al == 0, np.nan, ic_al)
            rs = rs[np.isfinite(rs)]
            if len(rs) >= 20:
                seg = rs[-20:]
                xs = np.arange(len(seg))
                base = np.mean(seg) + 1e-9
                f["rs_slope20"] = float(np.polyfit(xs, seg, 1)[0] / base * 100)
        # beta / 相关性（60日日收益回归）
        if m_len >= 30:
            sr = np.diff(cc_al) / (cc_al[:-1] + 1e-9)
            ir = np.diff(ic_al) / (ic_al[:-1] + 1e-9)
            k60 = min(60, len(sr), len(ir))
            sr60 = sr[-k60:]; ir60 = ir[-k60:]
            if k60 >= 10 and np.std(ir60) > 1e-12:
                var_i = float(np.var(ir60))
                cov = float(np.mean((sr60 - sr60.mean()) * (ir60 - ir60.mean())))
                f["beta60"] = cov / (var_i + 1e-12)
                if np.std(sr60) > 1e-12:
                    f["corr_idx60"] = float(np.corrcoef(sr60, ir60)[0, 1])
        # 大盘自身状态（regime）：动量 / 位置 / 波动，让模型知道"当前市场环境"
        if len(ic) > 20:
            f["idx_mom20"] = (ic[-1] / ic[-21] - 1) * 100
        if len(ic) >= 60:
            hi = float(np.max(ic[-60:])); lo = float(np.min(ic[-60:]))
            f["idx_pos60"] = (ic[-1] - lo) / (hi - lo) * 100 if hi > lo else 50.0
        ir_all = np.diff(ic) / (ic[:-1] + 1e-9) * 100
        if len(ir_all) >= 20:
            f["idx_vol20"] = float(np.std(ir_all[-20:]))

    # ========== v3 B：单股高阶价量 ==========
    # 隔夜跳空均值(近5日)：(open_t - close_{t-1})/close_{t-1}，需要 opens
    f["gap_mean5"] = 0.0
    f["intraday_str"] = 0.0
    f["up_shadow"] = 0.0
    f["dn_shadow"] = 0.0
    if o is not None and n >= 6:
        gaps = (o[1:] - c[:-1]) / (c[:-1] + 1e-9) * 100
        gaps = gaps[np.isfinite(gaps)]
        f["gap_mean5"] = float(np.mean(gaps[-5:])) if len(gaps) >= 1 else 0.0
        # 日内强弱：(close-open)/(high-low)，近5日均值，衡量多空盘中掌控力
        rng = (h - l)
        intr = (c - o) / np.where(rng == 0, np.nan, rng)
        intr = intr[np.isfinite(intr)]
        f["intraday_str"] = float(np.mean(intr[-5:])) if len(intr) >= 1 else 0.0
        # 上/下影线占比(近10日均值)：上影长=抛压，下影长=承接
        body_hi = np.maximum(o, c); body_lo = np.minimum(o, c)
        us = (h - body_hi) / np.where(rng == 0, np.nan, rng)
        ds = (body_lo - l) / np.where(rng == 0, np.nan, rng)
        us = us[np.isfinite(us)]; ds = ds[np.isfinite(ds)]
        f["up_shadow"] = float(np.mean(us[-10:])) if len(us) >= 1 else 0.0
        f["dn_shadow"] = float(np.mean(ds[-10:])) if len(ds) >= 1 else 0.0
    # Chaikin Money Flow(20)：((C-L)-(H-C))/(H-L) * 量，20日资金流向（主力吸筹/派发代理）
    if n >= 20:
        rng2 = (h - l)
        mfm = ((c - l) - (h - c)) / np.where(rng2 == 0, np.nan, rng2)
        mfv = np.where(np.isfinite(mfm), mfm, 0.0) * v
        f["cmf20"] = float(np.sum(mfv[-20:]) / (np.sum(v[-20:]) + 1e-9))
    else:
        f["cmf20"] = 0.0
    # Money Flow Index(14)：带量的 RSI，0..100，衡量资金推动的超买超卖
    if n >= 15:
        tp2 = (h + l + c) / 3.0
        rmf = tp2 * v
        dtp = np.diff(tp2)
        pos_mf = float(np.sum(rmf[1:][dtp > 0][-14:])) if np.any(dtp > 0) else 0.0
        neg_mf = float(np.sum(rmf[1:][dtp < 0][-14:])) if np.any(dtp < 0) else 0.0
        f["mfi14"] = 100.0 if neg_mf == 0 else 100 - 100 / (1 + pos_mf / (neg_mf + 1e-9))
    else:
        f["mfi14"] = 50.0
    # 波动率的波动率(vol-of-vol)：20日 滚动10日波动 的标准差，捕捉波动放大/收敛
    if len(rets) >= 30:
        roll = np.array([np.std(rets[i - 10:i]) for i in range(len(rets) - 20, len(rets))])
        f["vov20"] = float(np.std(roll)) if len(roll) else 0.0
    else:
        f["vov20"] = 0.0
    # 动量加速度：mom5 - 上一期 mom5(5日前)，>0 表示上涨在提速
    if n > 10:
        prev_mom5 = (c[-6] / c[-11] - 1) * 100
        f["mom_accel"] = f["mom5"] - prev_mom5
    else:
        f["mom_accel"] = 0.0
    # 距60日最低点涨幅(%)：越大越远离底部
    lo60_l = float(np.min(l[-60:])) if n >= 1 else last
    f["dist_low60"] = (last / lo60_l - 1) * 100 if lo60_l else 0.0
    # 成交量 z 分(近20日)：今日量相对20日均值的标准分，异常放量检测
    if n >= 20 and np.std(v[-20:]) > 1e-9:
        f["vol_z20"] = float((v[-1] - np.mean(v[-20:])) / np.std(v[-20:]))
    else:
        f["vol_z20"] = 0.0
    # Amihud 非流动性(近20日)：|日收益| / 成交量 的均值 ×1e6，越高越不流动（冲击成本高）
    if len(rets) >= 20 and n >= 21:
        illiq = np.abs(rets[-20:]) / (v[-20:] + 1e-9)
        f["amihud20"] = float(np.mean(illiq) * 1e6)
    else:
        f["amihud20"] = 0.0
    # 量能加速度：近5日均量 / 前5日均量 - 1，量能是否在放大
    if n >= 10:
        v_now = float(np.mean(v[-5:])); v_prev = float(np.mean(v[-10:-5]))
        f["turn_accel"] = (v_now / (v_prev + 1e-9) - 1) * 100
    else:
        f["turn_accel"] = 0.0

    # ========== 统一清洗：FEATURE_NAMES 内的 nan/inf → 0 ==========
    for name in FEATURE_NAMES:
        f[name] = _finite(f.get(name, 0.0), 0.0)

    # ATR(14) —— 用于目标价锚定（标签口径与线上建议一致）
    f["_atr"] = atr
    f["_ma20"] = ma20
    f["_last"] = last
    f["_rets"] = rets
    return f


# ========================================================================
# P1 正交因子(来自 Tushare daily_basic + moneyflow)——与上面 36 个纯量价因子
# 信息源不同、结构正交。先作为 CANDIDATE 名单单独评测(holdout 对拍越 0.005
# 护栏才并入 FEATURE_NAMES),严格复用 v3 的科学纪律,绝不无脑加特征。
# 三类:估值(基本面锚) / 换手(真实自由流通) / 资金流(主力大单订单流)。
# 全部纯计算、可选、缺失优雅降级归零。
# ========================================================================
TS_CANDIDATE_NAMES = [
    # --- 估值(财报锚,与价量正交)---
    "earnings_yield",   # 1/pe_ttm(盈利收益率,比 pe 线性、稳健)
    "pe_pctl250",       # pe_ttm 在本股近250日的分位(高=相对贵)
    "pb_pctl250",       # pb 分位
    "ps_pctl250",       # ps_ttm 分位
    "div_yield",        # dv_ttm 股息率
    "log_circ_mv",      # ln(流通市值)(规模因子)
    # --- 流动性/换手(需流通股本,OHLCV 无法得到)---
    "turnover_f",       # turnover_rate_f 当日自由流通换手率
    "turnover_z20",     # 换手率20日 z 分(异常换手)
    "vol_ratio_ts",     # volume_ratio 量比(Tushare 官方口径)
    # --- 主力资金流(逐笔分类订单流,OHLCV 无此维度)---
    "net_mf_mv5",       # 近5日主力净额 / 流通市值(主力净流入强度)
    "elg_net_mv5",      # 近5日超大单净额 / 流通市值(机构/主力动向)
    "lg_net_mv5",       # 近5日大单净额 / 流通市值
    "mf_pos_frac10",    # 近10日净流入为正的天数占比(资金流持续性)
]


def _pctl(arr, x):
    """x 在 arr(1维)中的分位(0..1),空则 0.5。"""
    a = arr[np.isfinite(arr)]
    if len(a) < 5 or not np.isfinite(x):
        return 0.5
    return float(np.mean(a <= x))


def compute_ts_factors(basic, mf, circ_mv_series, upto):
    """计算 Tushare 正交因子快照(截至索引 upto,含)。

    参数(均为与个股价格序列**已对齐**的等长 np 数组,由 tushare_panel 产出):
      basic         —— dict{turnover_rate_f, volume_ratio, pe_ttm, pb, ps_ttm, dv_ttm, total_mv, circ_mv}
      mf            —— dict{buy_lg_amount, sell_lg_amount, buy_elg_amount, sell_elg_amount, net_mf_amount}
      circ_mv_series—— 流通市值序列(万元),用于把资金流额归一化
      upto          —— 当前时点索引(用 [:upto+1] 的历史,绝不看未来)
    返回 dict,含 TS_CANDIDATE_NAMES 全部键;任何缺失/nan → 0(优雅降级)。"""
    f = {k: 0.0 for k in TS_CANDIDATE_NAMES}
    if basic is None or mf is None:
        return f
    s = slice(0, upto + 1)

    def _last(d, key):
        a = d.get(key)
        if a is None or upto >= len(a):
            return np.nan
        return float(a[upto])

    def _win(d, key, k):
        a = d.get(key)
        if a is None:
            return np.array([])
        seg = a[s][-k:]
        return seg[np.isfinite(seg)]

    # --- 估值 ---
    pe = _last(basic, "pe_ttm")
    if np.isfinite(pe) and pe > 0:
        f["earnings_yield"] = 1.0 / pe
    pe_hist = _win(basic, "pe_ttm", 250)
    f["pe_pctl250"] = _pctl(pe_hist, pe) if len(pe_hist) else 0.5
    pb = _last(basic, "pb")
    f["pb_pctl250"] = _pctl(_win(basic, "pb", 250), pb)
    ps = _last(basic, "ps_ttm")
    f["ps_pctl250"] = _pctl(_win(basic, "ps_ttm", 250), ps)
    dv = _last(basic, "dv_ttm")
    f["div_yield"] = dv if np.isfinite(dv) else 0.0
    cmv = _last(basic, "circ_mv")
    f["log_circ_mv"] = float(np.log(cmv)) if np.isfinite(cmv) and cmv > 0 else 0.0

    # --- 换手/流动性 ---
    tf = _last(basic, "turnover_rate_f")
    f["turnover_f"] = tf if np.isfinite(tf) else 0.0
    tf20 = _win(basic, "turnover_rate_f", 20)
    if len(tf20) >= 5 and np.std(tf20) > 1e-9 and np.isfinite(tf):
        f["turnover_z20"] = float((tf - np.mean(tf20)) / np.std(tf20))
    vr = _last(basic, "volume_ratio")
    f["vol_ratio_ts"] = vr if np.isfinite(vr) else 0.0

    # --- 主力资金流(归一化到流通市值,量纲一致、跨股可比)---
    cmv_now = cmv if (np.isfinite(cmv) and cmv > 0) else np.nan
    if np.isfinite(cmv_now):
        net5 = _win(mf, "net_mf_amount", 5)
        f["net_mf_mv5"] = float(np.sum(net5) / cmv_now) if len(net5) else 0.0
        be = _win(mf, "buy_elg_amount", 5); se = _win(mf, "sell_elg_amount", 5)
        if len(be) and len(se):
            f["elg_net_mv5"] = float((np.sum(be) - np.sum(se)) / cmv_now)
        bl = _win(mf, "buy_lg_amount", 5); sl = _win(mf, "sell_lg_amount", 5)
        if len(bl) and len(sl):
            f["lg_net_mv5"] = float((np.sum(bl) - np.sum(sl)) / cmv_now)
    net10 = _win(mf, "net_mf_amount", 10)
    if len(net10):
        f["mf_pos_frac10"] = float(np.mean(net10 > 0))

    for k in TS_CANDIDATE_NAMES:
        f[k] = _finite(f.get(k, 0.0), 0.0)
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
