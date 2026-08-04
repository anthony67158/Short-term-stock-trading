"""
每日持续训练编排器（冠军-挑战者，走查式，只升不降）。
=================================================================
目标：让量化打分模型「随时间越训越准」，同时用护栏保证「绝不因某天数据抖动/噪声而退步」。

为什么不是「无脑每天覆盖模型」：
  标签是「未来5日最高价是否触及 ATR 锚定目标」，需要未来5个交易日才能成熟。
  所以「把当天数据纳入训练」的真实含义是——约 5 个交易日前的样本，今天标签才成熟、
  才自动进入训练集。数据集随时间持续增长；每天用最新全量重新拟合，等价于「持续学习」。
  但盘面有噪声，若不设护栏，某天坏数据会让模型变差。故采用冠军/挑战者对拍 + AUC 护栏。

每天凌晨的流程：
  1) 重建数据集：拉最新日线 → 因子 → ATR 锚定 5 日达标标签 → dataset.npz（新成熟样本自动进入）。
  2) 切「保留评测集」：按日期排序取最近 HOLDOUT_FRAC（默认 15%）当样本外测试集。
  3) 冠军评测：加载现役 bundled 模型，在保留集上算 AUC（champ_auc）。
  4) 挑战者：仅用「保留集之前」的数据训练一个新模型，在同一保留集上算 AUC（chall_auc）。
  5) 护栏放行条件（全部满足才晋级）：
        - chall_auc >= champ_auc - TOL           （不明显更差）
        - chall_auc >= AUC_FLOOR                  （高于绝对下限，避免全局退化）
        - 样本量 >= MIN_SAMPLES 且正样本率在 [0.2,0.8]（数据健康）
     放行 → 用「全量数据」重训最终模型（时序CV定迭代数）→ 覆盖 bundled → 上传 OSS（1h 内热更新自动上线）。
     否则 → 保留冠军，当天不改线上，仅记录一次「拒绝」。
  6) 审计：无论晋级/拒绝，都向 retrain_history.jsonl 追加一行留痕（可回溯每天决策）。

线上生效机制：model_lib.py 每 1 小时从 OSS 拉一次模型（TTL 热更新），故上传 OSS 即自动上线，无需重部署 FC。

用法：
  set -a; source ../.env; set +a          # 载入 OSS_* 用于上传（缺失则只更新本地 bundled，不上传）
  python3 retrain_daily.py                 # 全流程
  python3 retrain_daily.py --dry-run       # 只训练+评测+打印决策，不写文件不上传
  python3 retrain_daily.py --pool 600 --bars 400
环境变量护栏可调：RETRAIN_TOL / RETRAIN_AUC_FLOOR / RETRAIN_MIN_SAMPLES / RETRAIN_HOLDOUT_FRAC
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
import lightgbm as lgb
from sklearn.metrics import roc_auc_score

from train_lgb import cv_auc_and_iters, fit_final

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLED_MODEL = os.path.join(HERE, "lgb_score.txt")
BUNDLED_META = os.path.join(HERE, "meta.json")
HISTORY = os.path.join(HERE, "retrain_history.jsonl")
DATASET = os.path.join(HERE, "dataset.npz")

# ---- 护栏阈值（环境变量可覆盖）----
TOL = float(os.environ.get("RETRAIN_TOL", "0.005"))            # 挑战者可比冠军差多少以内仍放行
AUC_FLOOR = float(os.environ.get("RETRAIN_AUC_FLOOR", "0.55")) # 挑战者 AUC 绝对下限
MIN_SAMPLES = int(os.environ.get("RETRAIN_MIN_SAMPLES", "50000"))
HOLDOUT_FRAC = float(os.environ.get("RETRAIN_HOLDOUT_FRAC", "0.15"))


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def append_history(rec):
    rec = {"ts": int(time.time()), "at": time.strftime("%Y-%m-%d %H:%M:%S"), **rec}
    with open(HISTORY, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def build_dataset(pool, bars, horizon):
    """调 build_dataset.py 重建 dataset.npz（拉最新日线，新成熟标签自动进入）。"""
    cmd = [sys.executable, os.path.join(HERE, "build_dataset.py"),
           "--pool", str(pool), "--bars", str(bars),
           "--horizon", str(horizon), "--out", DATASET]
    log("重建数据集:", " ".join(cmd[1:]))
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=1500)
    sys.stdout.write(r.stdout[-1500:] if r.stdout else "")
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-1500:] if r.stderr else "")
        raise RuntimeError(f"build_dataset 失败 rc={r.returncode}")


def load_dataset():
    d = np.load(DATASET, allow_pickle=True)
    X = d["X"].astype(np.float32)
    y = d["y"].astype(int)
    dates = d["dates"].astype(str)
    feat_names = [str(x) for x in d["feat_names"]]
    return X, y, dates, feat_names


def date_holdout_split(dates, frac):
    """按日期排序切分：最近 frac 比例为保留评测集(样本外)，其余为训练集。
    返回 (train_idx, holdout_idx)。用日期阈值切，保证同一天不跨集(避免泄漏)。"""
    order = np.argsort(dates, kind="stable")
    sorted_dates = dates[order]
    cut_pos = int(len(order) * (1 - frac))
    cut_pos = max(1, min(cut_pos, len(order) - 1))
    cut_date = sorted_dates[cut_pos]
    train_idx = order[sorted_dates < cut_date]
    hold_idx = order[sorted_dates >= cut_date]
    # 若某侧为空(日期高度集中)，退化为按位置切
    if len(train_idx) == 0 or len(hold_idx) == 0:
        train_idx, hold_idx = order[:cut_pos], order[cut_pos:]
    return np.asarray(train_idx), np.asarray(hold_idx), str(cut_date)


def align_features(booster, meta, cur_feats, X):
    """把当前数据集的特征列，按冠军 meta 里的 feat_names 顺序对齐，供冠军打分。
    当前训练/推理同源，顺序一般一致；此处做防御式对齐，特征集不兼容则返回 None。"""
    champ_feats = (meta or {}).get("feat_names")
    if not champ_feats:
        return X  # 冠军没记特征顺序，默认同序
    if list(champ_feats) == list(cur_feats):
        return X
    idx = []
    cur_map = {f: i for i, f in enumerate(cur_feats)}
    for f in champ_feats:
        if f not in cur_map:
            return None  # 特征集不兼容，无法公平对拍
        idx.append(cur_map[f])
    return X[:, idx]


def champion_baseline():
    """读取现役冠军「晋级当时的样本外(holdout) AUC」作为对拍基线——这是 leak-free 的比较口径。

    为什么不能「现场用冠军模型给今天的 holdout 打分再比」：冠军是用『全量历史』训练出来的，
    今天切出的最近 15% holdout 恰好落在它的训练集里 → 冠军见过这些样本 → AUC 被泄漏抬高 →
    挑战者永远赢不了 → 模型永不更新，违背「持续变准」的初衷。

    正确做法(walk-forward 晋级门)：比较『挑战者在最近 holdout 上的干净样本外 AUC』
    vs『冠军当年晋级时同样口径记录下来的 holdout AUC』。两者都是「train 段训练 / 最近段样本外评测」，
    口径一致、无泄漏。首个模型没有 holdout_auc 记录时，回落用 cv_auc，再不行用绝对下限。
    返回 (baseline_auc, source)。"""
    if not os.path.exists(BUNDLED_META):
        return None, "none"
    try:
        meta = json.load(open(BUNDLED_META))
    except Exception:  # noqa: BLE001
        return None, "none"
    if meta.get("holdout_auc") is not None and np.isfinite(meta["holdout_auc"]):
        return float(meta["holdout_auc"]), "holdout_auc"
    if meta.get("cv_auc") is not None and np.isfinite(meta["cv_auc"]):
        return float(meta["cv_auc"]), "cv_auc"
    return None, "none"


def train_challenger(X_tr, y_tr, dates_tr, X_hold, y_hold):
    """仅用训练段拟合挑战者，在保留集上评测 AUC。返回 (auc, n_est_for_holdout_fit)。"""
    # 用时序 CV 在训练段内定迭代数(避免过拟合)，再用该迭代数在训练段全量拟合
    _, n_est = cv_auc_and_iters(X_tr, y_tr, dates_tr, n_splits=4, verbose=False)
    booster = fit_final(X_tr, y_tr, n_est)
    p = booster.predict(X_hold)
    auc = roc_auc_score(y_hold, p) if len(set(y_hold)) > 1 else float("nan")
    return float(auc), n_est


def promote(X, y, dates, feat_names, chall_hold_auc, champ_auc):
    """晋级：全量重训最终模型 → 覆盖 bundled → 上传 OSS。返回写入的 meta。"""
    from factors_lib import FEATURE_NAMES  # noqa: F401  (口径一致性引用)
    cv_auc, n_est = cv_auc_and_iters(X, y, dates, n_splits=5, verbose=False)
    final = fit_final(X, y, n_est)
    final.save_model(BUNDLED_MODEL)
    imp = dict(zip(feat_names, [int(x) for x in final.feature_importance()]))
    meta = {
        "feat_names": feat_names,
        "pos_rate": float(y.mean()),
        "cv_auc": cv_auc,
        "holdout_auc": chall_hold_auc,
        "prev_holdout_auc": champ_auc,
        "n_estimators": n_est,
        "n_samples": int(len(y)),
        "horizon": 5,
        "target_rule": "future_max_high >= close*(1+max(0.03, 0.8*ATR14/close))",
        "importance": imp,
        "trained_at": int(time.time()),
        "model_format": "lightgbm_text",
        "trained_by": "retrain_daily",
    }
    json.dump(meta, open(BUNDLED_META, "w"), ensure_ascii=False, indent=2)
    log(f"已覆盖 bundled 模型 (cv_auc={cv_auc:.4f} n_est={n_est})")
    return meta, cv_auc


def upload_oss():
    """把新模型上传 OSS(quantmodel/)。缺 OSS 凭证则跳过(只更新本地 bundled)。"""
    if not (os.environ.get("OSS_ACCESS_KEY_ID") and os.environ.get("OSS_BUCKET")):
        log("未配置 OSS_* 环境变量，跳过上传(本地 bundled 已更新，下次部署随包生效)")
        return False
    cmd = [sys.executable, os.path.join(HERE, "upload_model.py"),
           "--model", BUNDLED_MODEL, "--meta", BUNDLED_META]
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=180)
    sys.stdout.write(r.stdout or "")
    if r.returncode != 0:
        sys.stderr.write(r.stderr or "")
        log("OSS 上传失败(线上暂不热更新，本地 bundled 已更新)")
        return False
    log("已上传 OSS，量化服务将在 1 小时内热更新自动上线")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", type=int, default=600)
    ap.add_argument("--bars", type=int, default=700)  # 与冠军训练同深度(700根)，保证挑战者数据量对等、可公平胜出
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--dry-run", action="store_true", help="只训练评测打印决策，不写文件不上传")
    ap.add_argument("--skip-build", action="store_true", help="复用现有 dataset.npz(调试用)")
    a = ap.parse_args()

    t0 = time.time()
    try:
        if not a.skip_build:
            build_dataset(a.pool, a.bars, a.horizon)
        X, y, dates, feat_names = load_dataset()
    except Exception as e:  # noqa: BLE001
        append_history({"decision": "error", "stage": "build/load", "error": str(e)[:200]})
        log("数据阶段失败:", e); sys.exit(1)

    n = len(y)
    pos_rate = float(y.mean()) if n else 0.0
    log(f"数据集: N={n} pos_rate={pos_rate:.3f} feats={len(feat_names)}")

    # 数据健康护栏
    healthy = (n >= MIN_SAMPLES) and (0.2 <= pos_rate <= 0.8)
    if not healthy:
        rec = {"decision": "reject", "reason": "unhealthy_data",
               "n_samples": n, "pos_rate": pos_rate}
        log("数据不健康，拒绝本次重训:", rec)
        if not a.dry_run:
            append_history(rec)
        sys.exit(0)

    tr_idx, hold_idx, cut_date = date_holdout_split(dates, HOLDOUT_FRAC)
    log(f"保留评测集切分: cut_date={cut_date} train={len(tr_idx)} holdout={len(hold_idx)}")

    # 冠军基线：用「晋级当时记录的样本外 AUC」做 leak-free 对拍(见 champion_baseline 说明)
    champ_auc, champ_src = champion_baseline()
    # 挑战者：只用 train 段拟合，在最近 holdout 段做干净样本外评测
    chall_auc, _ = train_challenger(X[tr_idx], y[tr_idx], dates[tr_idx],
                                    X[hold_idx], y[hold_idx])
    log(f"样本外 AUC → 冠军基线={champ_auc if champ_auc is None else round(champ_auc,4)}"
        f"(来源{champ_src}) 挑战者={round(chall_auc,4)} (容差 {TOL}, 下限 {AUC_FLOOR})")

    # ---- 护栏决策 ----
    above_floor = chall_auc >= AUC_FLOOR
    no_champ = champ_auc is None or not np.isfinite(champ_auc)
    beats_champ = no_champ or (chall_auc >= champ_auc - TOL)
    should_promote = above_floor and beats_champ

    base = {
        "n_samples": n, "pos_rate": round(pos_rate, 4), "cut_date": cut_date,
        "holdout_n": int(len(hold_idx)),
        "champ_baseline_auc": (None if no_champ else round(champ_auc, 4)),
        "champ_baseline_src": champ_src,
        "chall_holdout_auc": round(chall_auc, 4),
        "tol": TOL, "auc_floor": AUC_FLOOR,
        "elapsed_s": round(time.time() - t0, 1),
    }

    if a.dry_run:
        base["decision"] = "promote" if should_promote else "reject"
        base["dry_run"] = True
        log("DRY-RUN 决策:", json.dumps(base, ensure_ascii=False))
        return

    if not should_promote:
        reason = "below_floor" if not above_floor else "not_better_than_champion"
        rec = {**base, "decision": "reject", "reason": reason}
        append_history(rec)
        log("拒绝晋级(保留冠军，线上不变):", reason)
        return

    meta, cv_auc = promote(X, y, dates, feat_names, chall_auc, (None if no_champ else champ_auc))
    uploaded = upload_oss()
    rec = {**base, "decision": "promote", "cv_auc": round(cv_auc, 4),
           "n_estimators": meta["n_estimators"], "oss_uploaded": uploaded}
    append_history(rec)
    log("晋级完成:", json.dumps(rec, ensure_ascii=False))


if __name__ == "__main__":
    main()
