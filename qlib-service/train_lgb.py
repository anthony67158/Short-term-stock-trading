"""
训练 LightGBM 达标概率模型（Plan A）。
输入：build_dataset.py 产出的 dataset.npz
输出：
  lgb_score.txt  —— LightGBM 模型（Booster.save_model 文本格式，纯文本、体积小、加载快）
  meta.json      —— 特征顺序、正样本率、CV AUC、目标口径等元信息
口径：标签= 未来5日最高价触及 close*(1+max(3%,0.8*ATR/价))。
CV：按时间排序做 5 折“前训练后验证”滚动切分（避免未来信息泄漏）。
用法：python3 train_lgb.py --data dataset.npz --out-model lgb_score.txt --out-meta meta.json
"""
import argparse
import json
import time
import numpy as np
import lightgbm as lgb
from sklearn.metrics import roc_auc_score


def time_series_folds(dates, n_splits=5):
    """按日期排序后做扩张窗口切分，返回 (train_idx, val_idx) 列表。"""
    order = np.argsort(dates, kind="stable")
    N = len(order)
    fold = N // (n_splits + 1)
    splits = []
    for k in range(1, n_splits + 1):
        tr = order[: fold * k]
        va = order[fold * k: fold * (k + 1)]
        if len(va) > 0 and len(tr) > 0:
            splits.append((tr, va))
    return splits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="dataset.npz")
    ap.add_argument("--out-model", default="lgb_score.txt")
    ap.add_argument("--out-meta", default="meta.json")
    a = ap.parse_args()

    d = np.load(a.data, allow_pickle=True)
    X, y = d["X"].astype(np.float32), d["y"].astype(int)
    dates = d["dates"].astype(str)
    feat_names = [str(x) for x in d["feat_names"]]
    print(f"[data] X={X.shape} pos_rate={y.mean():.3f} feats={feat_names}")

    params = dict(
        objective="binary", metric="auc", boosting_type="gbdt",
        num_leaves=31, learning_rate=0.03, feature_fraction=0.8,
        bagging_fraction=0.8, bagging_freq=1, min_data_in_leaf=200,
        lambda_l1=0.5, lambda_l2=1.0, verbosity=-1, seed=42,
    )

    # 时序 CV 估计泛化 AUC
    aucs, best_iters = [], []
    for i, (tr, va) in enumerate(time_series_folds(dates, 5)):
        dtr = lgb.Dataset(X[tr], y[tr])
        dva = lgb.Dataset(X[va], y[va], reference=dtr)
        m = lgb.train(params, dtr, num_boost_round=800, valid_sets=[dva],
                      callbacks=[lgb.early_stopping(50, verbose=False),
                                 lgb.log_evaluation(0)])
        p = m.predict(X[va], num_iteration=m.best_iteration)
        auc = roc_auc_score(y[va], p) if len(set(y[va])) > 1 else float("nan")
        aucs.append(auc); best_iters.append(m.best_iteration or 300)
        print(f"  fold{i+1} val_auc={auc:.4f} best_iter={m.best_iteration}")

    cv_auc = float(np.nanmean(aucs))
    n_est = int(np.median(best_iters)) or 300
    print(f"[cv] mean_auc={cv_auc:.4f} n_estimators={n_est}")

    # 全量重训最终模型
    dall = lgb.Dataset(X, y)
    final = lgb.train(params, dall, num_boost_round=n_est)
    final.save_model(a.out_model)
    imp = dict(zip(feat_names, [int(x) for x in final.feature_importance()]))
    print(f"[importance] {sorted(imp.items(), key=lambda x:-x[1])}")

    meta = {
        "feat_names": feat_names,
        "pos_rate": float(y.mean()),
        "cv_auc": cv_auc,
        "n_estimators": n_est,
        "n_samples": int(len(y)),
        "horizon": 5,
        "target_rule": "future_max_high >= close*(1+max(0.03, 0.8*ATR14/close))",
        "importance": imp,
        "trained_at": int(time.time()),
        "model_format": "lightgbm_text",
    }
    json.dump(meta, open(a.out_meta, "w"), ensure_ascii=False, indent=2)
    print(f"[saved] {a.out_model} + {a.out_meta}")


if __name__ == "__main__":
    main()
