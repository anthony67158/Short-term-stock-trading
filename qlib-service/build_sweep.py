"""
构建「多口径」评测集：每个样本存 特征向量 + 未来若干日的最高涨幅，
以便离线扫描 (horizon, 目标涨幅) × 置信度闸门 的样本外精确率。
产出 sweep.npz: X, fmax{h}, atr_pct, dates, codes
"""
import time, numpy as np
from build_dataset import build_pool, fetch_kline
from factors_lib import compute_factors, feature_vector

HORIZONS = [3, 5, 10, 20]
MINH = 60
POOL = 260
BARS = 640

pool = build_pool(POOL)
print(f"[pool] {len(pool)}")
X=[]; DATES=[]; CODES=[]; ATR=[]
FMAX={h:[] for h in HORIZONS}
t0=time.time(); ok=fail=0
for i,(sym,name) in enumerate(pool):
    kl=fetch_kline(sym,BARS)
    if not kl: fail+=1; continue
    c,h,l,v,dts=kl; n=len(c); ok+=1
    hmax=max(HORIZONS)
    for t in range(MINH, n-hmax):
        f=compute_factors(c[:t+1],h[:t+1],l[:t+1],v[:t+1])
        fv=feature_vector(f)
        if not np.isfinite(fv).all(): continue
        last=f["_last"]
        X.append(fv); DATES.append(dts[t]); CODES.append(sym)
        ATR.append(float(f["_atr"]))
        for hz in HORIZONS:
            fut=float(np.max(h[t+1:t+1+hz]))
            FMAX[hz].append(fut/last - 1.0)
    if (i+1)%40==0:
        print(f"  {i+1}/{len(pool)} ok={ok} fail={fail} samples={len(X)} {time.time()-t0:.0f}s")

X=np.array(X,dtype=np.float32)
out=dict(X=X, dates=np.array(DATES), codes=np.array(CODES), atr_pct=np.array(ATR,dtype=np.float32))
for hz in HORIZONS: out[f"fmax{hz}"]=np.array(FMAX[hz],dtype=np.float32)
np.savez_compressed("sweep.npz", **out)
print(f"[done] samples={len(X)} ok={ok} fail={fail} in {time.time()-t0:.0f}s -> sweep.npz")
