"""
holdout 科学对拍:一次切分,同时回答两个问题——
  Q1 正交因子(Tushare)是否真的有净增益?     base(36) vs ext(49)  同模型
  Q2 换更强的模型能否再加分?                  多个 LGB 配置 × {base,ext}
================================================================
纪律(与 v3 拒绝 20 因子时完全一致,杜绝自欺):
  - 按日期排序,最近 HOLDOUT_FRAC(默认15%)为**样本外** holdout,绝不参与训练/调参。
  - 每个候选只用 train 段(时序CV定迭代数)拟合,在**同一** holdout 上报 AUC。
  - base 与 ext 的样本行一一对应(同 code/date/label),差异只来自因子列 → 干净归因。
  - 多随机种子取均值,避免单次抖动误判。
  - 判定:某方案相对「当前线上基线(gbdt+base)」的 holdout AUC 提升需 >= PROMOTE_TOL(0.005)
    才算真实增益(与 retrain_daily 的护栏同阈值)。

用法:
  python3 ab_holdout.py --base dataset_ts_base.npz --ext dataset_ts_ext.npz --seeds 3
"""
import argparse
import json
import time

import numpy as np
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

HOLDOUT_FRAC = 0.15
PROMOTE_TOL = 0.005

# 候选模型配置(含当前线上基线,与更强的容量/正则/boosting 变体)
CONFIGS = {
    # 当前线上:train_lgb.PARAMS(基线)
    "gbdt_baseline": dict(
        objective="binary", metric="auc", boosting_type="gbdt",
        num_leaves=63, max_depth=7, learning_rate=0.015, feature_fraction=0.7,
        bagging_fraction=0.8, bagging_freq=1, min_data_in_leaf=150,
        lambda_l1=1.0, lambda_l2=2.0, verbosity=-1, feature_pre_filter=False),
    # 更强 1:更大容量 + 更强正则(更多叶子/更深,配更强 L1L2 + 更小 lr 抗过拟合)
    "gbdt_bigger": dict(
        objective="binary", metric="auc", boosting_type="gbdt",
        num_leaves=127, max_depth=9, learning_rate=0.01, feature_fraction=0.6,
        bagging_fraction=0.8, bagging_freq=1, min_data_in_leaf=200,
        lambda_l1=2.0, lambda_l2=5.0, verbosity=-1, feature_pre_filter=False),
    # 更强 2:中容量 + 强正则(泛化优先,常在金融弱信号上更稳)
    "gbdt_reg": dict(
        objective="binary", metric="auc", boosting_type="gbdt",
        num_leaves=47, max_depth=6, learning_rate=0.012, feature_fraction=0.6,
        bagging_fraction=0.7, bagging_freq=1, min_data_in_leaf=300,
        lambda_l1=3.0, lambda_l2=8.0, min_gain_to_split=0.02,
        verbosity=-1, feature_pre_filter=False),
    # 更强 3:DART(dropout 提升泛化,弱信号常受益)
    "dart": dict(
        objective="binary", metric="auc", boosting_type="dart",
        num_leaves=95, max_depth=8, learning_rate=0.03, feature_fraction=0.7,
        bagging_fraction=0.8, bagging_freq=1, min_data_in_leaf=200,
        lambda_l1=2.0, lambda_l2=5.0, drop_rate=0.1, skip_drop=0.5,
        verbosity=-1, feature_pre_filter=False),
    # 更强 4:GOSS(梯度采样,更关注难样本)
    "goss": dict(
        objective="binary", metric="auc", boosting_type="goss",
        num_leaves=95, max_depth=8, learning_rate=0.015, feature_fraction=0.7,
        top_rate=0.2, other_rate=0.1, min_data_in_leaf=200,
        lambda_l1=2.0, lambda_l2=5.0, verbosity=-1, feature_pre_filter=False),
}


def date_split(dates, frac):
    order = np.argsort(dates, kind="stable")
    sd = dates[order]
    cut = int(len(order) * (1 - frac))
    cut = max(1, min(cut, len(order) - 1))
    cut_date = sd[cut]
    tr = order[sd < cut_date]
    ho = order[sd >= cut_date]
    if len(tr) == 0 or len(ho) == 0:
        tr, ho = order[:cut], order[cut:]
    return np.asarray(tr), np.asarray(ho), str(cut_date)


def ts_folds(dates, n_splits=4):
    order = np.argsort(dates, kind="stable")
    N = len(order); fold = N // (n_splits + 1)
    out = []
    for k in range(1, n_splits + 1):
        tr = order[: fold * k]; va = order[fold * k: fold * (k + 1)]
        if len(tr) and len(va):
            out.append((tr, va))
    return out


def cv_iters(params, X, y, dates, seed, n_splits=4):
    """时序CV定最优迭代数(dart 不支持早停 → 用固定轮数)。"""
    p = dict(params); p["seed"] = seed
    if p.get("boosting_type") == "dart":
        return 400  # dart 无早停,给一个稳健轮数
    iters = []
    for tr, va in ts_folds(dates, n_splits):
        dtr = lgb.Dataset(X[tr], y[tr])
        dva = lgb.Dataset(X[va], y[va], reference=dtr)
        m = lgb.train(p, dtr, num_boost_round=3000, valid_sets=[dva],
                      callbacks=[lgb.early_stopping(120, verbose=False),
                                 lgb.log_evaluation(0)])
        iters.append(m.best_iteration or 300)
    tail = iters[len(iters) // 2:] or iters
    return max(int(np.median(tail)) if tail else 300, 120)


def eval_config(name, params, X, y, dates, tr_idx, ho_idx, seeds):
    aucs = []
    n_est_used = None
    for sd in seeds:
        p = dict(params); p["seed"] = sd
        n_est = cv_iters(params, X[tr_idx], y[tr_idx], dates[tr_idx], sd)
        n_est_used = n_est
        booster = lgb.train(p, lgb.Dataset(X[tr_idx], y[tr_idx]), num_boost_round=n_est)
        pr = booster.predict(X[ho_idx])
        auc = roc_auc_score(y[ho_idx], pr) if len(set(y[ho_idx])) > 1 else float("nan")
        aucs.append(auc)
    return float(np.nanmean(aucs)), float(np.nanstd(aucs)), n_est_used, aucs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="dataset_ts_base.npz")
    ap.add_argument("--ext", default="dataset_ts_ext.npz")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--configs", default="", help="逗号分隔,默认全部")
    a = ap.parse_args()
    seeds = [42, 7, 123, 2024, 99][:a.seeds]

    db = np.load(a.base, allow_pickle=True)
    de = np.load(a.ext, allow_pickle=True)
    yb = db["y"].astype(int); ye = de["y"].astype(int)
    assert len(yb) == len(ye) and (yb == ye).all(), "base/ext 样本未对齐!"
    Xb = db["X"].astype(np.float32); Xe = de["X"].astype(np.float32)
    dates = db["dates"].astype(str)
    print(f"[data] N={len(yb)} pos={yb.mean():.3f} base_dim={Xb.shape[1]} ext_dim={Xe.shape[1]}")

    tr, ho, cut = date_split(dates, HOLDOUT_FRAC)
    print(f"[split] cut_date={cut} train={len(tr)} holdout={len(ho)} "
          f"ho_pos={yb[ho].mean():.3f}")

    cfg_names = [c for c in (a.configs.split(",") if a.configs else CONFIGS.keys())]
    results = []
    t0 = time.time()
    for feat_kind, X in (("base", Xb), ("ext", Xe)):
        for name in cfg_names:
            params = CONFIGS[name]
            mean, std, n_est, aucs = eval_config(
                name, params, X, yb, dates, tr, ho, seeds)
            results.append({"features": feat_kind, "config": name,
                            "holdout_auc": round(mean, 4), "std": round(std, 4),
                            "n_est": n_est, "aucs": [round(x, 4) for x in aucs]})
            print(f"  [{feat_kind:4s}/{name:14s}] holdout_auc={mean:.4f} "
                  f"±{std:.4f} n_est={n_est} ({time.time()-t0:.0f}s)", flush=True)

    baseline = next((r for r in results
                     if r["features"] == "base" and r["config"] == "gbdt_baseline"), None)
    base_auc = baseline["holdout_auc"] if baseline else 0.0
    print(f"\n[baseline] base/gbdt_baseline holdout_auc={base_auc}")
    results.sort(key=lambda r: -r["holdout_auc"])
    print("[ranking] (相对基线 Δ, 越 0.005 护栏才算真增益)")
    for r in results:
        delta = round(r["holdout_auc"] - base_auc, 4)
        flag = "✅越护栏" if delta >= PROMOTE_TOL else ("=持平" if abs(delta) < PROMOTE_TOL else "❌更差")
        print(f"  {r['features']:4s}/{r['config']:14s} auc={r['holdout_auc']:.4f} "
              f"Δ={delta:+.4f} {flag}")

    winner = results[0]
    out = {"cut_date": cut, "n_samples": int(len(yb)), "holdout_n": int(len(ho)),
           "baseline_auc": base_auc, "promote_tol": PROMOTE_TOL,
           "results": results, "winner": winner,
           "winner_beats_baseline": bool(winner["holdout_auc"] - base_auc >= PROMOTE_TOL)}
    json.dump(out, open("ab_holdout_result.json", "w"), ensure_ascii=False, indent=2)
    print(f"\n[winner] {winner['features']}/{winner['config']} "
          f"auc={winner['holdout_auc']} beats_baseline={out['winner_beats_baseline']}")
    print("[saved] ab_holdout_result.json")


if __name__ == "__main__":
    main()
