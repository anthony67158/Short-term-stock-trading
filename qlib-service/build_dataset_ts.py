"""
从 Tushare 面板缓存(tushare_panel.py 产出) → 训练集 npz。
================================================================
同一批样本、同一套标签口径,产出两份对齐的特征矩阵,供**公平** holdout 对拍:
  dataset_ts_base.npz  —— 仅 36 个原量价因子(FEATURE_NAMES)。用于当「新基线」。
  dataset_ts_ext.npz   —— 36 + 13 个 Tushare 正交因子(FEATURE_NAMES+TS_CANDIDATE_NAMES)。
两份的 X 行严格一一对应(同 code/date/label),差别只在是否含正交因子列 →
AUC 差 = 正交因子的净贡献(排除数据量/池子/标签变化的混淆)。

标签口径与线上完全一致:未来 horizon 日最高价 >= close*(1+max(3%,0.8*ATR/价))。
大盘指数序列(index_closes)取沪深300,与个股按日期对齐(缺失前向填充),
以便 v3 相对因子在 base 侧也能算(虽未纳入 FEATURE_NAMES,但 compute_factors 需要它才不报错)。

用法:
  python3 build_dataset_ts.py --panel panel_cache --horizon 5 \
     --out-base dataset_ts_base.npz --out-ext dataset_ts_ext.npz
"""
import argparse
import glob
import json
import os
import time

import numpy as np

from factors_lib import (compute_factors, feature_vector, target_price,
                         compute_ts_factors, FEATURE_NAMES, TS_CANDIDATE_NAMES)
from tushare_client import TushareClient

HERE = os.path.dirname(os.path.abspath(__file__))


def load_index_map(start, end):
    """拉沪深300指数收盘,返回 {date: close}。失败返回 {}(相对因子归零)。"""
    try:
        ts = TushareClient(max_per_min=135)
        rows = ts.index_daily("000300.SH", start_date=start, end_date=end)
        return {r["trade_date"]: float(r["close"]) for r in rows if r.get("close")}
    except Exception as e:  # noqa: BLE001
        print(f"[index] 拉取失败,相对因子归零: {e}")
        return {}


def make_samples_from_panel(p, idx_map, horizon, min_hist=60):
    """对单只股票面板生成样本。返回 (rows_base, rows_ext, dates, labels)。
    每个 t: 用 [:t+1] 历史算因子,标签= 未来 horizon 日最高价是否达标。"""
    dates = list(p["dates"])
    o, h, l, c, v = p["o"], p["h"], p["l"], p["c"], p["v"]
    n = len(c)
    basic = p.get("basic"); mf = p.get("mf")
    circ = basic.get("circ_mv") if basic else None

    # 大盘序列按本股日期对齐
    idx_series = None
    if idx_map:
        idx_series = np.empty(n, dtype=float)
        lastv = np.nan
        for i, dt in enumerate(dates):
            if dt in idx_map:
                lastv = idx_map[dt]
            idx_series[i] = lastv
        if np.isnan(idx_series).any():
            valid = idx_series[np.isfinite(idx_series)]
            fill = valid[0] if len(valid) else 1.0
            idx_series = np.where(np.isfinite(idx_series), idx_series, fill)

    xb, xe, ds, ys = [], [], [], []
    for t in range(min_hist, n - horizon):
        cc, hh, ll, vv, oo = c[:t + 1], h[:t + 1], l[:t + 1], v[:t + 1], o[:t + 1]
        ic = idx_series[:t + 1] if idx_series is not None else None
        f = compute_factors(cc, hh, ll, vv, opens=oo, index_closes=ic)
        base_vec = feature_vector(f)
        if not np.isfinite(base_vec).all():
            continue
        last = f["_last"]
        tgt = target_price(last, f["_atr"])
        fut_high = float(np.max(h[t + 1:t + 1 + horizon]))
        label = 1 if fut_high >= last * (1 + tgt) else 0
        # Tushare 正交因子
        tf = compute_ts_factors(basic, mf, circ, t)
        ext_extra = [float(tf[k]) for k in TS_CANDIDATE_NAMES]
        xb.append(base_vec)
        xe.append(base_vec + ext_extra)
        ds.append(dates[t]); ys.append(label)
    return xb, xe, ds, ys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--panel", default="panel_cache")
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--min-hist", type=int, default=60)
    ap.add_argument("--out-base", default="dataset_ts_base.npz")
    ap.add_argument("--out-ext", default="dataset_ts_ext.npz")
    a = ap.parse_args()

    pdir = os.path.join(HERE, a.panel)
    files = sorted(glob.glob(os.path.join(pdir, "*_*.npz")))
    files = [f for f in files if not os.path.basename(f).startswith("_")]
    print(f"[panel] {len(files)} stock files in {a.panel}/")

    # 时间范围(用于拉指数)
    idx_map = load_index_map("20211001", "20260805")
    print(f"[index] 000300.SH points={len(idx_map)}")

    Xb, Xe, DATES, CODES, Y = [], [], [], [], []
    ok = fail = 0
    t0 = time.time()
    for i, fp in enumerate(files):
        code = os.path.basename(fp)[:-4].replace("_", ".")
        try:
            d = np.load(fp, allow_pickle=True)
            p = {
                "code": code, "dates": [str(x) for x in d["dates"]],
                "o": d["o"].astype(float), "h": d["h"].astype(float),
                "l": d["l"].astype(float), "c": d["c"].astype(float),
                "v": d["v"].astype(float),
                "basic": {k[2:]: d[k].astype(float) for k in d.files if k.startswith("b_")},
                "mf": {k[2:]: d[k].astype(float) for k in d.files if k.startswith("m_")},
            }
        except Exception as e:  # noqa: BLE001
            fail += 1
            continue
        xb, xe, ds, ys = make_samples_from_panel(p, idx_map, a.horizon, a.min_hist)
        if not xb:
            fail += 1
            continue
        Xb.extend(xb); Xe.extend(xe); DATES.extend(ds)
        CODES.extend([code] * len(xb)); Y.extend(ys)
        ok += 1
        if (i + 1) % 100 == 0:
            pos = np.mean(Y) if Y else 0
            print(f"  {i+1}/{len(files)} ok={ok} fail={fail} samples={len(Xb)} "
                  f"pos_rate={pos:.3f} {time.time()-t0:.0f}s", flush=True)

    Xb = np.array(Xb, dtype=np.float32)
    Xe = np.array(Xe, dtype=np.float32)
    Y = np.array(Y, dtype=np.int8)
    codes = np.array(CODES); dates = np.array(DATES)
    ext_names = FEATURE_NAMES + TS_CANDIDATE_NAMES
    print(f"[done] stocks ok={ok} fail={fail} | samples={len(Xb)} "
          f"pos_rate={Y.mean():.3f} base_feats={Xb.shape[1]} ext_feats={Xe.shape[1]} "
          f"in {time.time()-t0:.0f}s")
    np.savez_compressed(os.path.join(HERE, a.out_base), X=Xb, y=Y, codes=codes,
                        dates=dates, feat_names=np.array(FEATURE_NAMES))
    np.savez_compressed(os.path.join(HERE, a.out_ext), X=Xe, y=Y, codes=codes,
                        dates=dates, feat_names=np.array(ext_names))
    print(f"[saved] {a.out_base} + {a.out_ext}")


if __name__ == "__main__":
    main()
