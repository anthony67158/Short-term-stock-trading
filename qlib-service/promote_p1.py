"""
用新的 Tushare 数据(dataset_ts_base.npz, 36因子, 与线上口径完全一致)重训生产模型。
纪律:先在最近15% holdout 上报干净样本外 AUC(写入 meta.holdout_auc,供每日冠军-挑战者
leak-free 对拍),再用全量重训最终模型覆盖 bundled。
"""
import json, os, time
import numpy as np
from train_lgb import cv_auc_and_iters, fit_final, PARAMS
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

HERE = os.path.dirname(os.path.abspath(__file__))
D = np.load("dataset_ts_base.npz", allow_pickle=True)
X = D["X"].astype(np.float32); y = D["y"].astype(int)
dates = D["dates"].astype(str); feat_names = [str(x) for x in D["feat_names"]]
print(f"[data] N={len(y)} pos={y.mean():.3f} feats={len(feat_names)}")

# holdout 干净样本外 AUC(与 ab/retrain 同口径)
order = np.argsort(dates, kind="stable"); sd = dates[order]
cut = max(1, min(int(len(order)*0.85), len(order)-1)); cut_date = sd[cut]
tr = order[sd < cut_date]; ho = order[sd >= cut_date]
_, n_est_tr = cv_auc_and_iters(X[tr], y[tr], dates[tr], n_splits=4, verbose=False)
b = fit_final(X[tr], y[tr], n_est_tr)
ho_auc = float(roc_auc_score(y[ho], b.predict(X[ho])))
print(f"[holdout] cut={cut_date} train={len(tr)} ho={len(ho)} holdout_auc={ho_auc:.4f}")

# 全量重训最终模型
cv_auc, n_est = cv_auc_and_iters(X, y, dates, n_splits=5, verbose=True)
final = fit_final(X, y, n_est)
final.save_model("lgb_score.txt")
imp = dict(zip(feat_names, [int(x) for x in final.feature_importance()]))
meta = {
    "feat_names": feat_names, "pos_rate": float(y.mean()),
    "cv_auc": cv_auc, "holdout_auc": ho_auc, "prev_holdout_auc": None,
    "n_estimators": n_est, "n_samples": int(len(y)), "horizon": 5,
    "target_rule": "future_max_high >= close*(1+max(0.03, 0.8*ATR14/close))",
    "importance": imp, "trained_at": int(time.time()),
    "model_format": "lightgbm_text", "trained_by": "tushare_rebuild_P1",
    "data_source": "tushare_qfq_477stocks_2022-2026",
    "note": "P1: 数据源升级为Tushare全市场清洗前复权; 36因子口径不变, 线上兼容; "
            "holdout对拍显示正交因子(ext)+0.0044(<0.005护栏)已验证并暂存,未纳入线上热路径",
}
json.dump(meta, open("meta.json", "w"), ensure_ascii=False, indent=2)
print(f"[saved] lgb_score.txt + meta.json cv_auc={cv_auc:.4f} holdout_auc={ho_auc:.4f} n_est={n_est}")
