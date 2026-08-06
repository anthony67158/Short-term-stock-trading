"""
Spike A —— regime(大盘状态)因子是否越 0.005 护栏？
================================================================
纪律与 P1 完全一致：同一批样本行(dataset_ts_base.npz 的 codes/dates 固定行序)，
只增加 3 列大盘 regime 因子，做干净的 holdout A/B：
  base = 现役 36 因子
  aug  = 36 + [idx_mom20, idx_pos60, idx_vol20]（口径与 factors_lib 一致）
regime 因子是纯大盘状态，只依赖沪深300指数序列，按 trade_date 广播到所有股票行，
保证 A/B 行序/标签/时序切分完全相同。

用法：
  set -a; . ../.env; set +a
  python3 spike_regime.py --seeds 5
"""
import argparse, os, json
import numpy as np
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

from tushare_client import TushareClient
from train_lgb import PARAMS

HERE = os.path.dirname(os.path.abspath(__file__))
REGIME_NAMES = ["idx_mom20", "idx_pos60", "idx_vol20"]
IDX_CODE = "000300.SH"
IDX_CACHE = os.path.join(HERE, "index_hs300_cache.json")


def fetch_index(start, end):
    """拉沪深300日线 close，返回 {trade_date(YYYYMMDD): close} 升序。带本地缓存。"""
    if os.path.exists(IDX_CACHE):
        try:
            c = json.load(open(IDX_CACHE))
            if c:
                print(f"[idx] loaded {len(c)} bars from cache")
                return {k: float(v) for k, v in c.items()}
        except Exception:
            pass
    ts = TushareClient()
    rows = ts.index_daily(ts_code=IDX_CODE, start_date=start, end_date=end)
    d = {}
    for r in rows:
        td = str(r.get("trade_date"))
        cl = r.get("close")
        if td and cl is not None:
            d[td] = float(cl)
    json.dump(d, open(IDX_CACHE, "w"))
    print(f"[idx] fetched {len(d)} bars {IDX_CODE} {start}~{end}")
    return d


def regime_by_date(idx_map):
    """按交易日计算 regime 因子(与 factors_lib.compute_factors 中 idx_* 口径一致)。
    返回 {trade_date: [idx_mom20, idx_pos60, idx_vol20]}，只用截至当日历史，绝不看未来。"""
    dates = sorted(idx_map.keys())
    ic = np.array([idx_map[d] for d in dates], float)
    out = {}
    ir_all = np.diff(ic) / (ic[:-1] + 1e-9) * 100  # 指数日收益(%)，长度 n-1
    for i, td in enumerate(dates):
        m = 0.0; p = 50.0; v = 0.0
        # idx_mom20: (ic[i]/ic[i-20]-1)*100
        if i >= 20:
            m = (ic[i] / ic[i - 20] - 1) * 100
        # idx_pos60: 60日通道位置
        if i >= 59:
            seg = ic[i - 59:i + 1]
            hi = float(np.max(seg)); lo = float(np.min(seg))
            p = (ic[i] - lo) / (hi - lo) * 100 if hi > lo else 50.0
        # idx_vol20: 近20日指数收益标准差
        if i >= 20:
            v = float(np.std(ir_all[i - 20:i]))
        out[td] = [m, p, v]
    return out


def holdout_split(dates, frac=0.15):
    order = np.argsort(dates, kind="stable")
    sd = dates[order]
    cut = max(1, min(int(len(order) * (1 - frac)), len(order) - 1))
    cut_date = sd[cut]
    tr = order[sd < cut_date]; ho = order[sd >= cut_date]
    if len(tr) == 0 or len(ho) == 0:
        tr, ho = order[:cut], order[cut:]
    return tr, ho, str(cut_date)


def train_eval(Xtr, ytr, Xho, yho, seed):
    params = dict(PARAMS)
    params.update(seed=seed, bagging_seed=seed, feature_fraction_seed=seed)
    n = len(Xtr); icut = int(n * 0.88)
    dtr = lgb.Dataset(Xtr[:icut], ytr[:icut])
    dva = lgb.Dataset(Xtr[icut:], ytr[icut:], reference=dtr)
    m = lgb.train(params, dtr, num_boost_round=3000, valid_sets=[dva],
                  callbacks=[lgb.early_stopping(120, verbose=False),
                             lgb.log_evaluation(0)])
    p = m.predict(Xho, num_iteration=m.best_iteration)
    return roc_auc_score(yho, p), m.best_iteration


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "dataset_ts_base.npz"))
    ap.add_argument("--seeds", type=int, default=5)
    ap.add_argument("--frac", type=float, default=0.15)
    ap.add_argument("--guard", type=float, default=0.005)
    a = ap.parse_args()

    d = np.load(a.data, allow_pickle=True)
    Xbase = d["X"].astype(np.float32)
    y = d["y"].astype(int)
    dates = d["dates"].astype(str)  # YYYYMMDD
    feat_names = [str(x) for x in d["feat_names"]]
    assert Xbase.shape[1] == 36 and feat_names[0] == "mom5"

    u = sorted(set(dates))
    idx_map = fetch_index(u[0], u[-1])
    reg = regime_by_date(idx_map)
    # 广播到每一行；缺失日安全归零(mom/vol=0, pos=50)
    miss = 0
    Xr = np.zeros((len(y), 3), dtype=np.float32)
    for i, td in enumerate(dates):
        r = reg.get(td)
        if r is None:
            Xr[i] = [0.0, 50.0, 0.0]; miss += 1
        else:
            Xr[i] = r
    cov = 1 - miss / len(y)
    print(f"[regime] coverage={cov*100:.1f}% (rows matched to index date: {len(y)-miss}/{len(y)})")
    Xaug = np.concatenate([Xbase, Xr], axis=1)

    tr, ho, cut_date = holdout_split(dates, a.frac)
    print(f"[split] train={len(tr)} holdout={len(ho)} cut_date={cut_date} "
          f"holdout_pos={y[ho].mean():.3f}")

    base_aucs, aug_aucs = [], []
    for s in range(a.seeds):
        seed = 42 + s
        ab, ib = train_eval(Xbase[tr], y[tr], Xbase[ho], y[ho], seed)
        aa, ia = train_eval(Xaug[tr], y[tr], Xaug[ho], y[ho], seed)
        base_aucs.append(ab); aug_aucs.append(aa)
        print(f"  seed={seed}  base={ab:.4f}(it{ib})  aug={aa:.4f}(it{ia})  Δ={aa-ab:+.4f}")

    mb, ma = float(np.mean(base_aucs)), float(np.mean(aug_aucs))
    delta = ma - mb
    wins = sum(1 for x, z in zip(aug_aucs, base_aucs) if x > z)
    print("=" * 60)
    print(f"[result] base_mean={mb:.4f}  aug_mean={ma:.4f}  Δ={delta:+.4f}  "
          f"wins={wins}/{a.seeds}  guard={a.guard}")
    verdict = "ADOPT" if (delta >= a.guard and wins >= (a.seeds + 1) // 2) else "REJECT"
    print(f"[verdict] {verdict}")

    # 诊断:含 regime 的一版特征重要性
    params = dict(PARAMS)
    full = lgb.train(params, lgb.Dataset(Xaug[tr], y[tr]), num_boost_round=300)
    allnames = list(feat_names) + REGIME_NAMES
    imp = sorted(zip(allnames, full.feature_importance()), key=lambda x: -x[1])
    ranks = {nm: i for i, (nm, _) in enumerate(imp)}
    print("[regime因子重要性排名/共%d]" % len(allnames),
          {nm: ranks[nm] for nm in REGIME_NAMES})
    print("[importance top12]", imp[:12])

    json.dump({"base_mean": mb, "aug_mean": ma, "delta": delta,
               "wins": wins, "seeds": a.seeds, "guard": a.guard,
               "verdict": verdict, "cut_date": cut_date,
               "coverage": cov, "regime_names": REGIME_NAMES,
               "n_samples": int(len(y))},
              open(os.path.join(HERE, "spike_regime_result.json"), "w"),
              ensure_ascii=False, indent=2)
    print("[saved] spike_regime_result.json")


if __name__ == "__main__":
    main()
