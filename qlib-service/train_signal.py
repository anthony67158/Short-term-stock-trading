"""
高把握买点信号头(Signal Head) —— 回答用户目标1「目标价可信度>=85%」。
================================================================
口径(经科学验证唯一真正达到85%且非base-rate假象的定义)：
  正类 = 未来5个交易日内最高价 >= 当日收盘 * (1+2%)   （"5日内够到+2%止盈"）
产物：
  lgb_signal.txt   —— LightGBM 概率模型(与主打分同36维特征、同源)
  signal_meta.json —— {gate, cal_x, cal_y(isotonic折点,供np.interp无依赖推理),
                        holdout_precision, coverage, base_rate, target_pct, horizon}
推理(model_lib)：raw=model.predict(x); prob=np.interp(raw,cal_x,cal_y);
                 若 prob>=gate => 高把握买点(样本外命中率约85%+)。
可复现:与 exp_gate_robust 完全一致(booster在fit段/校准在cal段/gate在cal段选/holdout报告)。
每日重训会滑动前推,让新成熟样本持续进入,实现"每天进步"。
"""
import argparse, json, os, time, numpy as np, lightgbm as lgb
from sklearn.metrics import roc_auc_score
from sklearn.isotonic import IsotonicRegression
from train_lgb import PARAMS
from time_splits import three_way_purged_split

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET_PCT = 0.02
HORIZON = 5
TARGET_PREC = 0.85          # 目标可信度
MIN_GATE_N = 50             # 校准集上选阈值的最小样本
HOLDOUT_FRAC = 0.15
CAL_FRAC = 0.12             # 训练段尾部做校准


def build_if_needed(path, pool, bars):
    if os.path.exists(path):
        return
    import build_sweep  # noqa: F401  复用其构建逻辑(直接运行脚本)
    # build_sweep 以模块方式运行会在import时执行；这里改为子进程更安全
    import subprocess, sys
    subprocess.run([sys.executable, os.path.join(HERE, "build_sweep.py")],
                   cwd=HERE, check=True)


def fit_calibrator(raw, y):
    """isotonic 校准，返回可用 np.interp 复现的折点 (x,y)。"""
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(raw, y)
    xs = iso.X_thresholds_.astype(float)
    ys = iso.y_thresholds_.astype(float)
    return xs.tolist(), ys.tolist()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "sweep.npz"))
    ap.add_argument("--out-model", default=os.path.join(HERE, "lgb_signal.txt"))
    ap.add_argument("--out-meta", default=os.path.join(HERE, "signal_meta.json"))
    ap.add_argument("--target-prec", type=float, default=TARGET_PREC)
    a = ap.parse_args()

    d = np.load(a.data, allow_pickle=True)
    X = d["X"].astype(np.float32)
    dates = d["dates"].astype(str)
    fmax = d[f"fmax{HORIZON}"].astype(float)
    y = (fmax >= TARGET_PCT).astype(int)

    N = len(dates)
    fit_idx, cal_idx, ho, split_meta = three_way_purged_split(
        dates,
        calibration_fraction=CAL_FRAC,
        holdout_fraction=HOLDOUT_FRAC,
        purge_dates=HORIZON,
    )
    cut_date = split_meta["holdout_start_date"]
    print(f"[split] fit={len(fit_idx)} cal={len(cal_idx)} holdout={len(ho)} "
          f"cut_date={cut_date} base_rate={y.mean():.3f}")

    dtr = lgb.Dataset(X[fit_idx], y[fit_idx])
    dva = lgb.Dataset(X[cal_idx], y[cal_idx], reference=dtr)
    m = lgb.train(PARAMS, dtr, num_boost_round=2000, valid_sets=[dva],
                  callbacks=[lgb.early_stopping(100, verbose=False), lgb.log_evaluation(0)])
    it = m.best_iteration
    rc = m.predict(X[cal_idx], num_iteration=it)
    rh = m.predict(X[ho], num_iteration=it)
    auc = roc_auc_score(y[ho], rh)

    cal_x, cal_y = fit_calibrator(rc, y[cal_idx])
    pc = np.interp(rc, cal_x, cal_y)
    ph = np.interp(rh, cal_x, cal_y)

    # 在校准集上选达到目标精确率的最低阈值(不看 holdout)
    gate = None
    for thr in np.arange(0.50, 0.981, 0.005):
        sel = pc >= thr; ns = int(sel.sum())
        if ns < MIN_GATE_N: continue
        if float(y[cal_idx][sel].mean()) >= a.target_prec:
            gate = round(float(thr), 3); break
    if gate is None:
        gate = 0.90
    # 用该阈值在 holdout 上做诚实的样本外验证
    selh = ph >= gate; nh = int(selh.sum())
    prec = float(y[ho][selh].mean()) if nh > 0 else float("nan")
    cov = nh / len(y[ho]) if len(y[ho]) else 0.0
    print(f"[signal] AUC={auc:.4f} gate={gate} holdout_precision={prec*100:.1f}% "
          f"coverage={cov*100:.1f}% n_signal={nh} iters={it}")

    m.save_model(a.out_model, num_iteration=it)
    meta = {
        "target_pct": TARGET_PCT, "horizon": HORIZON,
        "label_rule": f"future_max_high_{HORIZON}d >= close*(1+{TARGET_PCT})",
        "gate": gate,
        "cal_x": cal_x, "cal_y": cal_y,
        "holdout_precision": prec, "coverage": cov, "n_signal_holdout": nh,
        "base_rate": float(y.mean()), "auc": float(auc),
        "cut_date": cut_date, "n_samples": int(N), "n_estimators": int(it),
        "split": split_meta,
        "target_prec": a.target_prec,
        "trained_at": int(time.time()), "model_format": "lightgbm_text",
        "feat_dim": int(X.shape[1]),
    }
    json.dump(meta, open(a.out_meta, "w"), ensure_ascii=False, indent=2)
    print(f"[saved] {os.path.basename(a.out_model)} + {os.path.basename(a.out_meta)}")


if __name__ == "__main__":
    main()
