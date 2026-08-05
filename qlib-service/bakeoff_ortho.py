"""
P1-3 holdout 科学对拍 —— 正交因子(Tushare)是否真能提升样本外 AUC？
================================================================
纪律（沿用上一轮 v3 被拒的同一标准）：
  - 用**完全相同**的样本/标签/时序 holdout 切分，只比较特征列不同：
      基线 = 现役 36 因子(FEATURE_NAMES)
      挑战 = 36 因子 + 10 正交因子(ORTHO_NAMES)
  - 多随机种子重复，看均值 holdout AUC 提升是否越过 0.005 护栏。
  - 只有稳定越线才建议纳入；否则如实报告并放弃（不硬上）。

用法：
  python3 bakeoff_ortho.py --data dataset.npz --ortho ortho.npz --seeds 5
"""
import argparse
import os
import numpy as np
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

from factors_lib import FEATURE_NAMES
from train_lgb import PARAMS

HERE = os.path.dirname(os.path.abspath(__file__))


def holdout_split(dates, frac=0.15):
    order = np.argsort(dates, kind="stable")
    sd = dates[order]
    cut = int(len(order) * (1 - frac))
    cut = max(1, min(cut, len(order) - 1))
    cut_date = sd[cut]
    tr = order[sd < cut_date]
    ho = order[sd >= cut_date]
    if len(tr) == 0 or len(ho) == 0:
        tr, ho = order[:cut], order[cut:]
    return tr, ho, str(cut_date)


def train_eval(Xtr, ytr, Xho, yho, seed):
    params = dict(PARAMS)
    params["seed"] = seed
    params["bagging_seed"] = seed
    params["feature_fraction_seed"] = seed
    # 用训练段尾部 12% 做早停验证，避免看 holdout 选迭代数（防泄漏）
    n = len(Xtr)
    icut = int(n * 0.88)
    dtr = lgb.Dataset(Xtr[:icut], ytr[:icut])
    dva = lgb.Dataset(Xtr[icut:], ytr[icut:], reference=dtr)
    m = lgb.train(params, dtr, num_boost_round=3000, valid_sets=[dva],
                  callbacks=[lgb.early_stopping(120, verbose=False),
                             lgb.log_evaluation(0)])
    p = m.predict(Xho, num_iteration=m.best_iteration)
    return roc_auc_score(yho, p), m.best_iteration


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "dataset.npz"))
    ap.add_argument("--ortho", default=os.path.join(HERE, "ortho.npz"))
    ap.add_argument("--seeds", type=int, default=5)
    ap.add_argument("--frac", type=float, default=0.15)
    ap.add_argument("--guard", type=float, default=0.005)
    a = ap.parse_args()

    d = np.load(a.data, allow_pickle=True)
    Xfull = d["X"].astype(np.float32)
    y = d["y"].astype(int)
    dates = d["dates"].astype(str)
    npz_feats = [str(x) for x in d["feat_names"]]

    # 只取现役 36 因子作为基线（dataset.npz 里存了 56 列，含被拒的 v3 试验因子）
    base_idx = [npz_feats.index(nm) for nm in FEATURE_NAMES]
    Xbase = Xfull[:, base_idx]

    o = np.load(a.ortho, allow_pickle=True)
    Xo = o["Xo"].astype(np.float32)
    onames = [str(x) for x in o["names"]]
    cov = float(o["coverage"][0])
    assert Xo.shape[0] == Xbase.shape[0], "ortho 行数与 dataset 不一致"
    Xaug = np.concatenate([Xbase, Xo], axis=1)

    tr, ho, cut_date = holdout_split(dates, a.frac)
    print(f"[bakeoff] rows={len(y)} base_feats={len(FEATURE_NAMES)} "
          f"ortho_feats={len(onames)} ortho_coverage={cov*100:.1f}%")
    print(f"[split] train={len(tr)} holdout={len(ho)} cut_date={cut_date} "
          f"holdout_pos={y[ho].mean():.3f}")

    base_aucs, aug_aucs = [], []
    for s in range(a.seeds):
        seed = 42 + s
        ab, ib = train_eval(Xbase[tr], y[tr], Xbase[ho], y[ho], seed)
        aa, ia = train_eval(Xaug[tr], y[tr], Xaug[ho], y[ho], seed)
        base_aucs.append(ab); aug_aucs.append(aa)
        print(f"  seed={seed}  base={ab:.4f}(it{ib})  aug={aa:.4f}(it{ia})  "
              f"Δ={aa-ab:+.4f}")

    mb, ma = float(np.mean(base_aucs)), float(np.mean(aug_aucs))
    delta = ma - mb
    wins = sum(1 for x, z in zip(aug_aucs, base_aucs) if x > z)
    print("=" * 60)
    print(f"[result] base_mean={mb:.4f}  aug_mean={ma:.4f}  Δ={delta:+.4f}  "
          f"wins={wins}/{a.seeds}  guard={a.guard}")
    verdict = "ADOPT" if (delta >= a.guard and wins >= (a.seeds + 1) // 2) else "REJECT"
    print(f"[verdict] {verdict}  "
          f"({'越过护栏且多数种子获胜→建议纳入' if verdict=='ADOPT' else '未稳定越线→按纪律放弃,不纳入'})")

    # 训练一版含正交的模型看特征重要性(仅诊断，不落盘为线上模型)
    if verdict == "ADOPT":
        params = dict(PARAMS)
        full = lgb.train(params, lgb.Dataset(Xaug[tr], y[tr]),
                         num_boost_round=300)
        allnames = list(FEATURE_NAMES) + onames
        imp = sorted(zip(allnames, full.feature_importance()),
                     key=lambda x: -x[1])
        print("[importance top15]", imp[:15])
        ortho_ranks = {nm: i for i, (nm, _) in enumerate(imp)}
        print("[ortho因子重要性排名]",
              {nm: ortho_ranks[nm] for nm in onames})


if __name__ == "__main__":
    main()
