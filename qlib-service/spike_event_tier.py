"""
P2 —— 事件确认高把握层(event-confirmed high-conviction tier)是否有产品价值?
========================================================================
背景(来自 Spike B / spike_event.py 已成结论):
  - E1「事件作为模型特征列」: Δ AUC = +0.0011 < 0.005 护栏 → 已拒绝(且事件无法进
    线上 /predict 的 OHLCV 向量,天然不可 serving)。
  - E2「事件子集 base-rate」: 命中事件的行正样本率远高于全样本
    (连板>=2 → 87.5%, 涨停 → 79.4%, 龙虎榜 → 67.8% vs 全样本 49%)。
  结论指向: 事件不是"更好的连续特征",而是"高精度筛子"。

本实验(唯一未做的一步): 把事件构建成叠加在信号头之上的「确认层」,回答产品问题——
  在维持 >=85% 样本外精确率的前提下, 能否比"只用信号头 gate"覆盖更多高把握买点?

口径与 train_signal.py 完全一致(同一 sweep.npz、同 fit/cal/holdout 切分、同 isotonic 校准、
同在校准集选 gate),只在 holdout 上比较三种出信号策略的 precision / coverage / n:
  S0 基线   : 信号头 prob >= gate                      (现网行为)
  S1 OR并联 : prob>=gate  OR  事件确认命中              (扩 coverage)
  S2 事件门槛: 各事件子集自身的样本外精确率(纯筛子价值)

事件确认命中 evt_hit 的定义(全部 T 日盘后可知,不构成未来函数):
  连板>=2  OR  (涨停 AND 封单强度 ev_fd_z>0)  OR  (龙虎榜 AND 净买>0)
  —— 取 Spike B 中 base-rate 明显 >=85%/接近的高纯度子集组合。

关键护栏(不降可信度): S1 只有在 holdout precision 仍 >= TARGET_PREC 时才算"可采纳",
  否则维持 S0(纯信号头)。事件确认层只做"扩面且不掉精度",绝不牺牲可信度。

serving 说明: 事件数据(limit_list_d/top_list)仅盘后可离线拿到,不改 /predict 的 OHLCV
  入参。落地形态 = 离线批处理阶段(每日重训/建议生成侧)对命中事件的票追加"事件确认"标记,
  在线打分向量维持 36 维不变。

用法:
  set -a; . ../.env; set +a
  python3 spike_event_tier.py
"""
import argparse, os, json
import numpy as np
import lightgbm as lgb
from sklearn.metrics import roc_auc_score
from sklearn.isotonic import IsotonicRegression

from train_lgb import PARAMS
from spike_event import build_event_cols   # 复用同一事件对齐逻辑(T日盘后可知)

HERE = os.path.dirname(os.path.abspath(__file__))
EV_CACHE = os.path.join(HERE, "events_cache.json")
TARGET_PCT = 0.02
HORIZON = 5
TARGET_PREC = 0.85
MIN_GATE_N = 50
HOLDOUT_FRAC = 0.15
CAL_FRAC = 0.12


def fit_calibrator(raw, y):
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(raw, y)
    return iso.X_thresholds_.astype(float).tolist(), iso.y_thresholds_.astype(float).tolist()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "sweep.npz"))
    ap.add_argument("--target-prec", type=float, default=TARGET_PREC)
    a = ap.parse_args()

    d = np.load(a.data, allow_pickle=True)
    X = d["X"].astype(np.float32)
    dates = d["dates"].astype(str)
    codes = d["codes"].astype(str)
    fmax = d[f"fmax{HORIZON}"].astype(float)
    y = (fmax >= TARGET_PCT).astype(int)

    # ---- 与 train_signal.py 完全相同的时序切分 ----
    order = np.argsort(dates, kind="stable"); N = len(order)
    cut = int(N * (1 - HOLDOUT_FRAC)); tr_all, ho = order[:cut], order[cut:]
    icut = int(len(tr_all) * (1 - CAL_FRAC)); fit_idx, cal_idx = tr_all[:icut], tr_all[icut:]
    cut_date = dates[order[cut]]
    print(f"[split] fit={len(fit_idx)} cal={len(cal_idx)} holdout={len(ho)} "
          f"cut_date={cut_date} base_rate={y.mean():.3f}")

    # ---- 训练信号头(同 PARAMS/早停) ----
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

    # gate: 校准集上达标的最低阈值(不看 holdout)
    gate = None
    for thr in np.arange(0.50, 0.981, 0.005):
        sel = pc >= thr; ns = int(sel.sum())
        if ns < MIN_GATE_N:
            continue
        if float(y[cal_idx][sel].mean()) >= a.target_prec:
            gate = round(float(thr), 3); break
    if gate is None:
        gate = 0.90
    print(f"[signal] holdout_AUC={auc:.4f} gate={gate} iters={it}")

    # ---- 事件确认命中(holdout 行) ----
    cache = json.load(open(EV_CACHE))
    Xe_all, hit_lu_all, hit_lhb_all = build_event_cols(codes, dates, cache)
    Xe = Xe_all[ho]; hit_lu = hit_lu_all[ho]; hit_lhb = hit_lhb_all[ho]
    limit_times = Xe[:, 1]; open_times = Xe[:, 2]; fd_z = Xe[:, 3]
    lhb_net_z = Xe[:, 5]
    # 高纯度事件确认: 连板>=2  OR  (涨停 & 封单强度>0)  OR  (龙虎榜 & 净买>0)
    evt_hit = (limit_times >= 2) | (hit_lu & (fd_z > 0)) | (hit_lhb & (lhb_net_z > 0))

    yh = y[ho]
    base_rate_ho = float(yh.mean())

    def report(mask, label):
        n = int(mask.sum())
        prec = float(yh[mask].mean()) if n else float("nan")
        cov = n / len(yh) if len(yh) else 0.0
        print(f"  [{label}] n={n}  precision={prec*100:.2f}%  coverage={cov*100:.3f}%")
        return {"n": n, "precision": (None if np.isnan(prec) else round(prec, 4)),
                "coverage": round(cov, 5)}

    print(f"[holdout] N={len(yh)} base_rate={base_rate_ho*100:.2f}%")
    print("=" * 64)
    sel_sig = ph >= gate
    r_s0 = report(sel_sig, "S0 信号头 gate")
    r_evt = report(evt_hit, "事件确认命中(纯筛子)")
    sel_or = sel_sig | evt_hit
    r_s1 = report(sel_or, "S1 OR并联(信号头 OR 事件确认)")
    # 增量: S1 相对 S0 净增的信号(仅事件带来的)
    only_evt = evt_hit & (~sel_sig)
    r_inc = report(only_evt, "S1 增量(仅事件新增的信号)")

    # 各细分事件子集(产品可解释)
    print("-" * 64)
    subs = {
        "连板>=2": limit_times >= 2,
        "连板>=3": limit_times >= 3,
        "涨停&封单>0": hit_lu & (fd_z > 0),
        "龙虎榜&净买>0": hit_lhb & (lhb_net_z > 0),
    }
    e_sub = {k: report(v, k) for k, v in subs.items()}

    # ---- 采纳判定 ----
    s0_prec = r_s0["precision"]; s1_prec = r_s1["precision"]
    adopt = (s1_prec is not None and s1_prec >= a.target_prec
             and r_s1["n"] > r_s0["n"])
    verdict = "ADOPT" if adopt else "REJECT"
    print("=" * 64)
    if s0_prec is not None and s1_prec is not None:
        print(f"[verdict] {verdict}  S0(prec={s0_prec*100:.2f}%,n={r_s0['n']}) "
              f"→ S1(prec={s1_prec*100:.2f}%,n={r_s1['n']})  "
              f"Δcoverage={(r_s1['coverage']-r_s0['coverage'])*100:+.3f}pp  "
              f"新增高把握信号 +{r_inc['n']}")
    else:
        print(f"[verdict] {verdict} (S0 gate 在 holdout 上无命中,信息不足)")

    out = {"gate": gate, "signal_auc": round(float(auc), 4), "cut_date": cut_date,
           "holdout_n": len(yh), "holdout_base_rate": round(base_rate_ho, 4),
           "target_prec": a.target_prec,
           "S0_signal_gate": r_s0, "event_confirm_pure": r_evt,
           "S1_or": r_s1, "S1_incremental_only_event": r_inc,
           "event_subsets": e_sub, "verdict": verdict,
           "evt_hit_rule": "limit_times>=2 OR (涨停&fd_z>0) OR (龙虎榜&net>0)"}
    json.dump(out, open(os.path.join(HERE, "spike_event_tier_result.json"), "w"),
              ensure_ascii=False, indent=2)
    print("[saved] spike_event_tier_result.json")


if __name__ == "__main__":
    main()
