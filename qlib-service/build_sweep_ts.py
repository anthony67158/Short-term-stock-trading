"""
从 Tushare 面板缓存(panel_cache/)构建信号头评测集 sweep.npz。
================================================================
与 build_sweep.py 口径一致(X=36维量价因子, fmax{h}=未来h日最高涨幅),
但数据源升级为 Tushare 全市场 qfq 面板(477股), 与主打分头(promote_p1)同源同口径,
两个头一起重训、一起上线, 保证线上兼容(向量仍 36 维)。

用法:
  python3 build_sweep_ts.py --panel panel_cache --out sweep.npz
"""
import argparse, glob, os, time
import numpy as np
from factors_lib import compute_factors, feature_vector

HERE = os.path.dirname(os.path.abspath(__file__))
HORIZONS = [3, 5, 10, 20]
MINH = 60


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--panel", default="panel_cache")
    ap.add_argument("--out", default="sweep.npz")
    a = ap.parse_args()

    pdir = os.path.join(HERE, a.panel)
    files = sorted(f for f in glob.glob(os.path.join(pdir, "*_*.npz"))
                   if not os.path.basename(f).startswith("_"))
    print(f"[panel] {len(files)} stock files")

    X = []; DATES = []; CODES = []; ATR = []
    FMAX = {h: [] for h in HORIZONS}
    hmax = max(HORIZONS)
    t0 = time.time(); ok = fail = 0
    for i, fp in enumerate(files):
        code = os.path.basename(fp)[:-4].replace("_", ".")
        try:
            d = np.load(fp, allow_pickle=True)
            c = d["c"].astype(float); h = d["h"].astype(float)
            l = d["l"].astype(float); v = d["v"].astype(float)
            o = d["o"].astype(float); dts = [str(x) for x in d["dates"]]
        except Exception:
            fail += 1; continue
        n = len(c)
        if n < MINH + hmax + 1:
            fail += 1; continue
        ok += 1
        for t in range(MINH, n - hmax):
            f = compute_factors(c[:t+1], h[:t+1], l[:t+1], v[:t+1], opens=o[:t+1])
            fv = feature_vector(f)
            if not np.isfinite(fv).all():
                continue
            last = f["_last"]
            X.append(fv); DATES.append(dts[t]); CODES.append(code)
            ATR.append(float(f["_atr"]))
            for hz in HORIZONS:
                fut = float(np.max(h[t+1:t+1+hz]))
                FMAX[hz].append(fut / last - 1.0)
        if (i+1) % 50 == 0:
            print(f"  {i+1}/{len(files)} ok={ok} fail={fail} samples={len(X)} "
                  f"{time.time()-t0:.0f}s", flush=True)

    X = np.array(X, dtype=np.float32)
    out = dict(X=X, dates=np.array(DATES), codes=np.array(CODES),
               atr_pct=np.array(ATR, dtype=np.float32))
    for hz in HORIZONS:
        out[f"fmax{hz}"] = np.array(FMAX[hz], dtype=np.float32)
    np.savez_compressed(os.path.join(HERE, a.out), **out)
    print(f"[done] samples={len(X)} ok={ok} fail={fail} in {time.time()-t0:.0f}s "
          f"-> {a.out}")


if __name__ == "__main__":
    main()
