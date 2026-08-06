"""
Spike B —— 事件驱动因子(涨停/连板/炸板/龙虎榜净买)是否越 0.005 护栏?
==================================================================
纪律与 P1 / Spike A 完全一致:同一批样本行(dataset_ts_base.npz 固定行序),
只增加事件列,做干净的 holdout A/B。事件在 T 日收盘后可知,喂给 T 日样本行(标签为前向收益),
不构成未来函数。

两类实验:
  E1 全样本 A/B: base=36 vs aug=36+事件列。检验"事件因子对全体样本预测力的净增量"。
  E2 事件子集 base-rate 与可分性: 只看命中事件的行,看其正样本率是否显著高于全样本,
     以及在事件子集内 base 模型 AUC —— 判断"事件本身是否是高精度筛子"(这才是产品价值:coverage@precision)。

事件列(全部 T 日盘后可知):
  ev_lu       : T 日是否涨停(1/0)
  ev_limit_times: 连板数(0 表示未涨停)
  ev_open_times : 炸板次数
  ev_fd_z     : 封单额 / 当日涨停封单额中位数 的对数(封单强度), 缺失0
  ev_lhb      : T 日是否上龙虎榜(1/0)
  ev_lhb_net_z: 龙虎榜净买额(亿)符号*log1p, 缺失0

关键约束(servable): 线上 /predict 只收 OHLCV。事件因子无法在线serving,
  因此即便 E1 越护栏,也只能作为"离线事件信号头"或需改 payload 才能上线 —— 结论里必须说明。

用法:
  set -a; . ../.env; set +a
  python3 spike_event.py --seeds 5
"""
import argparse, os, json
import numpy as np
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

from train_lgb import PARAMS

HERE = os.path.dirname(os.path.abspath(__file__))
EV_CACHE = os.path.join(HERE, "events_cache.json")
EV_NAMES = ["ev_lu", "ev_limit_times", "ev_open_times", "ev_fd_z", "ev_lhb", "ev_lhb_net_z"]


def build_event_cols(codes, dates, cache):
    """按 (code, date) 精确对齐事件, 只用 T 日盘后可知信息。返回 (N,6) float32。"""
    n = len(codes)
    Xe = np.zeros((n, len(EV_NAMES)), dtype=np.float32)
    hit_lu = np.zeros(n, dtype=bool)
    hit_lhb = np.zeros(n, dtype=bool)
    # 预先算每日涨停封单额中位数用于标准化
    day_fd_med = {}
    for td, rec in cache.items():
        fds = [v.get("fd", 0.0) for v in rec.get("lu", {}).values()
               if v.get("limit") == "U" and v.get("fd")]
        day_fd_med[td] = float(np.median(fds)) if fds else 0.0
    for i in range(n):
        td = dates[i]; code = codes[i]
        rec = cache.get(td)
        if not rec:
            continue
        lu = rec.get("lu", {}).get(code)
        if lu and lu.get("limit") == "U":
            hit_lu[i] = True
            Xe[i, 0] = 1.0
            Xe[i, 1] = float(lu.get("limit_times") or 0)
            Xe[i, 2] = float(lu.get("open_times") or 0)
            med = day_fd_med.get(td, 0.0)
            fd = float(lu.get("fd") or 0.0)
            Xe[i, 3] = np.log1p(fd / med) if med > 0 else 0.0
        lhb = rec.get("lhb", {}).get(code)
        if lhb:
            hit_lhb[i] = True
            Xe[i, 4] = 1.0
            net_yi = float(lhb.get("net", 0.0)) / 1e8
            Xe[i, 5] = np.sign(net_yi) * np.log1p(abs(net_yi))
    return Xe, hit_lu, hit_lhb


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
    return roc_auc_score(yho, p), m.best_iteration, m, p


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
    codes = d["codes"].astype(str)
    dates = d["dates"].astype(str)
    feat_names = [str(x) for x in d["feat_names"]]
    assert Xbase.shape[1] == 36 and feat_names[0] == "mom5"

    cache = json.load(open(EV_CACHE))
    Xe, hit_lu, hit_lhb = build_event_cols(codes, dates, cache)
    Xaug = np.concatenate([Xbase, Xe], axis=1)

    n = len(y)
    hit_any = hit_lu | hit_lhb
    print(f"[events] rows total={n}")
    print(f"[events] 涨停行={hit_lu.sum()} ({hit_lu.mean()*100:.2f}%)  "
          f"龙虎榜行={hit_lhb.sum()} ({hit_lhb.mean()*100:.2f}%)  "
          f"任一事件={hit_any.sum()} ({hit_any.mean()*100:.2f}%)")
    print(f"[base-rate] 全样本正样本率={y.mean()*100:.2f}%  "
          f"涨停行={y[hit_lu].mean()*100:.2f}%  "
          f"龙虎榜行={y[hit_lhb].mean()*100:.2f}%  "
          f"任一事件行={y[hit_any].mean()*100:.2f}%")

    tr, ho, cut_date = holdout_split(dates, a.frac)
    print(f"[split] train={len(tr)} holdout={len(ho)} cut_date={cut_date} "
          f"holdout_pos={y[ho].mean():.3f}")

    # ---- E1 全样本 A/B ----
    base_aucs, aug_aucs = [], []
    last_aug_model = None; last_aug_pred = None
    for s in range(a.seeds):
        seed = 42 + s
        ab, ib, _, _ = train_eval(Xbase[tr], y[tr], Xbase[ho], y[ho], seed)
        aa, ia, ma, pa = train_eval(Xaug[tr], y[tr], Xaug[ho], y[ho], seed)
        base_aucs.append(ab); aug_aucs.append(aa)
        last_aug_model = ma; last_aug_pred = pa
        print(f"  seed={seed}  base={ab:.4f}(it{ib})  aug={aa:.4f}(it{ia})  Δ={aa-ab:+.4f}")

    mb, ma_ = float(np.mean(base_aucs)), float(np.mean(aug_aucs))
    delta = ma_ - mb
    wins = sum(1 for x, z in zip(aug_aucs, base_aucs) if x > z)
    print("=" * 62)
    print(f"[E1 result] base_mean={mb:.4f}  aug_mean={ma_:.4f}  Δ={delta:+.4f}  "
          f"wins={wins}/{a.seeds}  guard={a.guard}")
    e1_verdict = "ADOPT" if (delta >= a.guard and wins >= (a.seeds + 1) // 2) else "REJECT"
    print(f"[E1 verdict] {e1_verdict}")

    # ---- E2 事件子集 coverage@precision(产品价值视角) ----
    # 在 holdout 上, 只看命中事件的行, 用现役 base 模型打分能否得到高精度子集
    ho_hit_lu = hit_lu[ho]; ho_hit_lhb = hit_lhb[ho]; ho_hit_any = hit_any[ho]
    e2 = {}
    def subset_stats(mask, label):
        cnt = int(mask.sum())
        pos = float(y[ho][mask].mean()) if cnt else 0.0
        print(f"  [E2] holdout {label}: n={cnt}  正样本率={pos*100:.2f}% "
              f"(全holdout={y[ho].mean()*100:.2f}%)")
        e2[label] = {"n": cnt, "pos_rate": pos}
    subset_stats(np.ones(len(ho), bool), "全holdout")
    subset_stats(ho_hit_lu, "涨停行")
    subset_stats(ho_hit_lhb, "龙虎榜行")
    subset_stats(ho_hit_any, "任一事件行")
    # 连板细分
    lt = Xe[ho, 1]
    for k in [1, 2, 3]:
        m = lt >= k
        subset_stats(m, f"连板>={k}")

    # ---- 事件因子重要性 ----
    params = dict(PARAMS)
    full = lgb.train(params, lgb.Dataset(Xaug[tr], y[tr]), num_boost_round=300)
    allnames = list(feat_names) + EV_NAMES
    imp = sorted(zip(allnames, full.feature_importance()), key=lambda x: -x[1])
    ranks = {nm: i for i, (nm, _) in enumerate(imp)}
    print("[事件因子重要性排名/共%d]" % len(allnames),
          {nm: ranks[nm] for nm in EV_NAMES})
    print("[importance top12]", imp[:12])

    json.dump({"e1": {"base_mean": mb, "aug_mean": ma_, "delta": delta,
                      "wins": wins, "seeds": a.seeds, "guard": a.guard,
                      "verdict": e1_verdict},
               "e2": e2,
               "cut_date": cut_date, "n_samples": n,
               "hit_lu": int(hit_lu.sum()), "hit_lhb": int(hit_lhb.sum()),
               "event_names": EV_NAMES},
              open(os.path.join(HERE, "spike_event_result.json"), "w"),
              ensure_ascii=False, indent=2)
    print("[saved] spike_event_result.json")


if __name__ == "__main__":
    main()
