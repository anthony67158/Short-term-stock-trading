"""
每日增量适配训练编排器（冠军-挑战者，走查式，只升不降）。
=================================================================
目标：让量化打分模型「随时间越训越准」，同时用护栏保证「绝不因某天数据抖动/噪声而退步」。

为什么不是「无脑每天覆盖模型」：
  标签是「未来5日最高价是否触及 ATR 锚定目标」，需要未来5个交易日才能成熟。
  所以「把当天数据纳入训练」的真实含义是——约 5 个交易日前的样本，今天标签才成熟、
  才自动进入训练集。数据集随时间持续增长；每天用最新全量重新拟合，等价于「持续学习」。
  但盘面有噪声，若不设护栏，某天坏数据会让模型变差。故采用冠军/挑战者对拍 + AUC 护栏。

每天凌晨的流程：
  1) 重建数据集：拉最新日线 → 因子 → ATR 锚定 5 日达标标签 → dataset.npz（新成熟样本自动进入）。
  2) 从 OSS 同步现役冠军及其训练数据截止日（CI runner 本身无状态）。
  3) 将冠军截止日之后的新成熟样本切成「适配窗 + 最新盲测窗」：
     挑战者吸收适配窗，最新日期完全不参与训练。
  4) 训练时对近期和新增样本加权，避免新市场状态被长期历史样本淹没；36维特征口径不变。
  5) 冠军与挑战者在同一最新盲测窗比较 AUC、LogLoss 和 Top10% 精度。
  6) 护栏放行条件（全部满足才晋级）：
        - AUC / LogLoss / Top10% 精度均不得明显退化
        - AUC 或 Top10% 精度至少一项达到最小真实增益
        - chall_auc >= AUC_FLOOR                  （高于绝对下限，避免全局退化）
        - 样本量 >= MIN_SAMPLES 且正样本率在 [0.2,0.8]（数据健康）
     放行 → 用「全量数据」重训最终模型（时序CV定迭代数）→ 覆盖 bundled → 上传 OSS（1h 内热更新自动上线）。
     否则 → 保留冠军，当天不改线上，仅记录一次「拒绝」。
  7) 审计：无论晋级/拒绝，都向 retrain_history.jsonl 追加一行留痕（可回溯每天决策）。

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
from sklearn.metrics import log_loss, roc_auc_score

from production_backtest import (
    evaluate_production_model,
    upload_production_accuracy,
)
from train_lgb import cv_auc_and_iters, fit_final

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLED_MODEL = os.path.join(HERE, "lgb_score.txt")
BUNDLED_META = os.path.join(HERE, "meta.json")
BUNDLED_SIGNAL = os.path.join(HERE, "lgb_signal.txt")
BUNDLED_SIGNAL_META = os.path.join(HERE, "signal_meta.json")
SWEEP = os.path.join(HERE, "sweep.npz")
HISTORY = os.path.join(HERE, "retrain_history.jsonl")
DATASET = os.path.join(HERE, "dataset.npz")

# ---- 护栏阈值（环境变量可覆盖）----
TOL = float(os.environ.get("RETRAIN_TOL", "0.005"))            # 挑战者可比冠军差多少以内仍放行
AUC_FLOOR = float(os.environ.get("RETRAIN_AUC_FLOOR", "0.55")) # 挑战者 AUC 绝对下限
MIN_SAMPLES = int(os.environ.get("RETRAIN_MIN_SAMPLES", "50000"))
HOLDOUT_FRAC = float(os.environ.get("RETRAIN_HOLDOUT_FRAC", "0.15"))
# ---- 信号头(高把握买点)护栏：只在样本外精确率达标时才更新，绝不降低可信度 ----
SIGNAL_PREC_FLOOR = float(os.environ.get("RETRAIN_SIGNAL_PREC_FLOOR", "0.83"))  # 样本外精确率下限
SIGNAL_MIN_N = int(os.environ.get("RETRAIN_SIGNAL_MIN_N", "100"))               # holdout 上最少信号数
FORWARD_MIN_SAMPLES = int(os.environ.get("RETRAIN_FORWARD_MIN_SAMPLES", "1000"))
FORWARD_MIN_DATES = int(os.environ.get("RETRAIN_FORWARD_MIN_DATES", "3"))
ADAPT_MIN_SAMPLES = int(os.environ.get("RETRAIN_ADAPT_MIN_SAMPLES", "1000"))
ADAPT_MIN_DATES = int(os.environ.get("RETRAIN_ADAPT_MIN_DATES", "3"))
BLIND_MIN_SAMPLES = int(os.environ.get("RETRAIN_BLIND_MIN_SAMPLES", "1000"))
BLIND_MIN_DATES = int(os.environ.get("RETRAIN_BLIND_MIN_DATES", "3"))
RECENCY_HALF_LIFE_DATES = int(
    os.environ.get("RETRAIN_RECENCY_HALF_LIFE_DATES", "120")
)
NEW_SAMPLE_BOOST = float(os.environ.get("RETRAIN_NEW_SAMPLE_BOOST", "2.0"))
MIN_AUC_GAIN = float(os.environ.get("RETRAIN_MIN_AUC_GAIN", "0.002"))
MIN_TOP_PREC_GAIN = float(
    os.environ.get("RETRAIN_MIN_TOP_PREC_GAIN", "0.01")
)
MAX_AUC_REGRESSION = float(
    os.environ.get("RETRAIN_MAX_AUC_REGRESSION", "0.001")
)
MAX_LOGLOSS_REGRESSION = float(
    os.environ.get("RETRAIN_MAX_LOGLOSS_REGRESSION", "0.005")
)
MAX_TOP_PREC_REGRESSION = float(
    os.environ.get("RETRAIN_MAX_TOP_PREC_REGRESSION", "0.01")
)


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


class DataUnavailable(RuntimeError):
    """行情数据源不可达/被限流(非代码错误)。上游据此「跳过当日重训」并正常退出(exit 0),
    避免海外 CI 出口 IP 拉不到 CN 行情时把每日任务判红报警。"""


def append_history(rec):
    rec = {"ts": int(time.time()), "at": time.strftime("%Y-%m-%d %H:%M:%S"), **rec}
    with open(HISTORY, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def merge_champion_metadata(remote_meta, bundled_meta):
    """同一冠军首次迁移时，保留仓库补充的前向评测元数据。"""
    merged = dict(remote_meta or {})
    if merged.get("trained_at") != (bundled_meta or {}).get("trained_at"):
        return merged
    for key in ("data_end_date", "evaluation_protocol"):
        if key not in merged and bundled_meta.get(key) is not None:
            merged[key] = bundled_meta[key]
    return merged


def sync_champion_from_oss():
    """CI runner 是无状态的，训练前必须从 OSS 拉取真正的现役冠军。

    仓库内 bundled 仅是冷启动兜底。如果不做同步，某次晋级上传 OSS 后，下一次
    Actions 仍会读取仓库旧模型，冠军-挑战者状态无法延续。
    """
    if not (os.environ.get("OSS_ACCESS_KEY_ID") and os.environ.get("OSS_BUCKET")):
        log("未配置 OSS_*，使用仓库 bundled 冠军")
        return False
    try:
        from upload_model import bucket
        b = bucket()
    except Exception as e:  # noqa: BLE001
        log("OSS 冠军同步初始化失败，使用 bundled:", str(e)[:160])
        return False

    def download_pair(model_key, meta_key, model_path, meta_path, preserve_migration=False):
        model_tmp, meta_tmp = model_path + ".sync", meta_path + ".sync"
        try:
            bundled_meta = {}
            if preserve_migration and os.path.exists(meta_path):
                bundled_meta = json.load(open(meta_path, encoding="utf-8"))
            with open(model_tmp, "wb") as fh:
                fh.write(b.get_object(model_key).read())
            with open(meta_tmp, "wb") as fh:
                fh.write(b.get_object(meta_key).read())
            lgb.Booster(model_file=model_tmp)
            remote_meta = json.load(open(meta_tmp, encoding="utf-8"))
            if preserve_migration:
                remote_meta = merge_champion_metadata(remote_meta, bundled_meta)
                with open(meta_tmp, "w", encoding="utf-8") as fh:
                    json.dump(remote_meta, fh, ensure_ascii=False, indent=2)
            os.replace(model_tmp, model_path)
            os.replace(meta_tmp, meta_path)
            return True
        except Exception:
            for path in (model_tmp, meta_tmp):
                try:
                    os.remove(path)
                except OSError:
                    pass
            return False

    prefix = os.environ.get("QUANT_MODEL_PREFIX", "quantmodel/")
    score_ok = download_pair(
        prefix + "lgb_score.txt", prefix + "meta.json",
        BUNDLED_MODEL, BUNDLED_META,
        preserve_migration=True,
    )
    signal_ok = download_pair(
        prefix + "lgb_signal.txt", prefix + "signal_meta.json",
        BUNDLED_SIGNAL, BUNDLED_SIGNAL_META,
    )
    log(f"OSS 现役冠军同步: score={score_ok} signal={signal_ok}")
    return score_ok


def build_dataset(pool, bars, horizon, forecast_after=""):
    """调 build_dataset.py 重建 dataset.npz（拉最新日线，新成熟标签自动进入）。
    区分退出码:rc==2 → 数据源不可达/被限流(海外 CI 常见),抛 DataUnavailable 让上游按
    「跳过而非失败」处理;其它非 0 → 视为真实构建错误。"""
    cmd = [sys.executable, os.path.join(HERE, "build_dataset.py"),
           "--pool", str(pool), "--bars", str(bars),
           "--horizon", str(horizon), "--out", DATASET]
    if forecast_after:
        cmd += ["--forecast-after", str(forecast_after)]
    log("重建数据集:", " ".join(cmd[1:]))
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=1500)
    sys.stdout.write(r.stdout[-1500:] if r.stdout else "")
    if r.returncode == 2:
        sys.stderr.write(r.stderr[-1500:] if r.stderr else "")
        raise DataUnavailable("行情数据源不可达/被限流,无法拉到任何日线")
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-1500:] if r.stderr else "")
        raise RuntimeError(f"build_dataset 失败 rc={r.returncode}")


def load_dataset():
    d = np.load(DATASET, allow_pickle=True)
    X = d["X"].astype(np.float32)
    y = d["y"].astype(int)
    dates = d["dates"].astype(str)
    codes = d["codes"].astype(str)
    feat_names = [str(x) for x in d["feat_names"]]
    next_up_probabilities = (
        d["next_up_probabilities"].astype(float)
        if "next_up_probabilities" in d.files
        else None
    )
    next_actual_up = (
        d["next_actual_up"].astype(int)
        if "next_actual_up" in d.files
        else None
    )
    next_range_hit = (
        d["next_range_hit"].astype(int)
        if "next_range_hit" in d.files
        else None
    )
    return (
        X,
        y,
        dates,
        codes,
        feat_names,
        next_up_probabilities,
        next_actual_up,
        next_range_hit,
    )


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


def _date_key(value):
    return "".join(ch for ch in str(value) if ch.isdigit())


def forward_holdout_split(dates, champion_data_end):
    """用冠军训练截止日之后的成熟样本做真正的前向样本外评测。"""
    end_key = _date_key(champion_data_end)
    keys = np.asarray([_date_key(value) for value in dates])
    train_idx = np.flatnonzero(keys <= end_key)
    hold_idx = np.flatnonzero(keys > end_key)
    hold_dates = sorted({str(dates[i]) for i in hold_idx}, key=_date_key)
    return train_idx, hold_idx, hold_dates


def forward_holdout_ready(holdout_n, holdout_dates, min_samples=None, min_dates=None):
    min_samples = FORWARD_MIN_SAMPLES if min_samples is None else min_samples
    min_dates = FORWARD_MIN_DATES if min_dates is None else min_dates
    return holdout_n >= min_samples and len(holdout_dates) >= min_dates


def incremental_adaptation_split(dates, champion_data_end, blind_dates=3):
    """Split post-champion mature dates into adaptation and untouched blind test.

    The challenger trains on all historical rows plus early post-champion rows.
    The latest ``blind_dates`` dates remain unseen by both champion adaptation
    and challenger training, so the gate measures whether consuming new labels
    actually improved forward performance.
    """
    end_key = _date_key(champion_data_end)
    keys = np.asarray([_date_key(value) for value in dates])
    new_dates = sorted(
        {str(dates[i]) for i in np.flatnonzero(keys > end_key)},
        key=_date_key,
    )
    blind_count = max(1, int(blind_dates))
    if len(new_dates) <= blind_count:
        return (
            np.flatnonzero(keys <= end_key),
            np.flatnonzero(keys > end_key),
            [],
            new_dates,
        )
    blind = new_dates[-blind_count:]
    adapt = new_dates[:-blind_count]
    blind_start = _date_key(blind[0])
    train_idx = np.flatnonzero(keys < blind_start)
    blind_idx = np.flatnonzero(keys >= blind_start)
    return train_idx, blind_idx, adapt, blind


def incremental_window_ready(
    adapt_n,
    adapt_dates,
    blind_n,
    blind_dates,
    min_adapt_samples=None,
    min_adapt_dates=None,
    min_blind_samples=None,
    min_blind_dates=None,
):
    min_adapt_samples = (
        ADAPT_MIN_SAMPLES
        if min_adapt_samples is None
        else min_adapt_samples
    )
    min_adapt_dates = (
        ADAPT_MIN_DATES if min_adapt_dates is None else min_adapt_dates
    )
    min_blind_samples = (
        BLIND_MIN_SAMPLES
        if min_blind_samples is None
        else min_blind_samples
    )
    min_blind_dates = (
        BLIND_MIN_DATES if min_blind_dates is None else min_blind_dates
    )
    return (
        int(adapt_n) >= int(min_adapt_samples)
        and len(adapt_dates) >= int(min_adapt_dates)
        and int(blind_n) >= int(min_blind_samples)
        and len(blind_dates) >= int(min_blind_dates)
    )


def recency_sample_weights(
    dates,
    champion_data_end=None,
    half_life_dates=None,
    new_sample_boost=None,
    floor=0.25,
):
    """Return normalized time-decay weights without changing feature shape."""
    values = np.asarray(dates).astype(str)
    if not len(values):
        return np.asarray([], dtype=np.float32)
    unique = sorted(set(values), key=_date_key)
    ranks = {value: index for index, value in enumerate(unique)}
    latest_rank = len(unique) - 1
    half_life = max(
        1,
        int(
            RECENCY_HALF_LIFE_DATES
            if half_life_dates is None
            else half_life_dates
        ),
    )
    boost = float(
        NEW_SAMPLE_BOOST if new_sample_boost is None else new_sample_boost
    )
    champion_key = _date_key(champion_data_end)
    weights = []
    for value in values:
        age = latest_rank - ranks[value]
        weight = max(float(floor), 0.5 ** (age / half_life))
        if champion_key and _date_key(value) > champion_key:
            weight *= max(1.0, boost)
        weights.append(weight)
    result = np.asarray(weights, dtype=np.float32)
    mean = float(result.mean())
    return result / mean if mean > 0 else np.ones_like(result)


def prediction_metrics(labels, probabilities, top_fraction=0.1):
    labels = np.asarray(labels, dtype=int)
    probabilities = np.clip(
        np.asarray(probabilities, dtype=float),
        1e-6,
        1 - 1e-6,
    )
    if len(labels) != len(probabilities) or not len(labels):
        raise ValueError("labels and probabilities must be non-empty and aligned")
    auc = (
        float(roc_auc_score(labels, probabilities))
        if len(set(labels)) > 1
        else float("nan")
    )
    top_n = max(1, int(np.ceil(len(labels) * float(top_fraction))))
    top_idx = np.argsort(probabilities, kind="stable")[-top_n:]
    return {
        "auc": auc,
        "logloss": float(log_loss(labels, probabilities, labels=[0, 1])),
        "top_precision": float(labels[top_idx].mean()),
        "top_n": int(top_n),
        "base_rate": float(labels.mean()),
    }


def should_promote_metrics(champion, challenger):
    auc_delta = float(challenger["auc"]) - float(champion["auc"])
    logloss_delta = (
        float(challenger["logloss"]) - float(champion["logloss"])
    )
    top_precision_delta = (
        float(challenger["top_precision"])
        - float(champion["top_precision"])
    )
    non_degraded = (
        float(challenger["auc"]) >= AUC_FLOOR
        and auc_delta >= -MAX_AUC_REGRESSION
        and logloss_delta <= MAX_LOGLOSS_REGRESSION
        and top_precision_delta >= -MAX_TOP_PREC_REGRESSION
    )
    improvements = []
    if auc_delta >= MIN_AUC_GAIN:
        improvements.append("auc_gain")
    if top_precision_delta >= MIN_TOP_PREC_GAIN:
        improvements.append("top_precision_gain")
    return {
        "promote": bool(non_degraded and improvements),
        "non_degraded": bool(non_degraded),
        "improvements": improvements,
        "auc_delta": round(auc_delta, 6),
        "logloss_delta": round(logloss_delta, 6),
        "top_precision_delta": round(top_precision_delta, 6),
    }


def align_features(meta, cur_feats, X):
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


def publish_current_production_accuracy(
    champion,
    champion_meta,
    X,
    y,
    dates,
    codes,
    feat_names,
    next_up_probabilities=None,
    next_actual_up=None,
    next_range_hit=None,
):
    """Publish current champion accuracy before any retrain decision."""
    if champion is None or not champion_meta.get("data_end_date"):
        log("现役生产模型缺少训练截止日，跳过实际准确率回测")
        return None
    aligned = align_features(champion_meta, feat_names, X)
    if aligned is None:
        log("现役生产模型特征不兼容，跳过实际准确率回测")
        return None
    try:
        report = evaluate_production_model(
            champion,
            champion_meta,
            X=aligned,
            labels=y,
            dates=dates,
            codes=codes,
            next_up_probabilities=next_up_probabilities,
            next_actual_up=next_actual_up,
            next_range_hit=next_range_hit,
        )
        upload_production_accuracy(report)
        overall = report["overall"]
        log(
            "生产模型前向回测:",
            f"{overall['correct']}/{overall['total']}",
            f"accuracy={overall['accuracyPct']}",
            f"balanced={overall['balancedAccuracyPct']}",
        )
        return report
    except Exception as error:  # noqa: BLE001
        log("生产模型实际准确率发布失败，不阻断重训:", str(error)[:160])
        return None


def load_champion():
    if not (os.path.exists(BUNDLED_MODEL) and os.path.exists(BUNDLED_META)):
        return None, {}
    try:
        booster = lgb.Booster(model_file=BUNDLED_MODEL)
        meta = json.load(open(BUNDLED_META, encoding="utf-8"))
        return booster, meta
    except Exception:  # noqa: BLE001
        return None, {}


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


def train_challenger(
    X_tr,
    y_tr,
    dates_tr,
    X_hold,
    y_hold,
    weights=None,
):
    """Fit the incremental challenger and evaluate the untouched blind set."""
    # 用时序 CV 在训练段内定迭代数(避免过拟合)，再用该迭代数在训练段全量拟合
    _, n_est = cv_auc_and_iters(
        X_tr,
        y_tr,
        dates_tr,
        n_splits=4,
        verbose=False,
        weights=weights,
    )
    booster = fit_final(X_tr, y_tr, n_est, weights=weights)
    p = booster.predict(X_hold)
    return prediction_metrics(y_hold, p), n_est


def promote(
    X,
    y,
    dates,
    feat_names,
    chall_hold_auc,
    champ_auc,
    weights=None,
    evaluation_metrics=None,
):
    """晋级：全量重训最终模型 → 覆盖 bundled → 上传 OSS。返回写入的 meta。"""
    from factors_lib import FEATURE_NAMES  # noqa: F401  (口径一致性引用)
    cv_auc, n_est = cv_auc_and_iters(
        X,
        y,
        dates,
        n_splits=5,
        verbose=False,
        weights=weights,
    )
    final = fit_final(X, y, n_est, weights=weights)
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
        "data_source": "tencent_qfq",
        "data_end_date": str(max(dates, key=_date_key)),
        "evaluation_protocol": (
            evaluation_metrics or {}
        ).get("protocol", "same_forward_unseen_holdout"),
        "incremental_training": {
            "enabled": weights is not None,
            "recency_half_life_dates": RECENCY_HALF_LIFE_DATES,
            "new_sample_boost": NEW_SAMPLE_BOOST,
        },
        "blind_metrics": evaluation_metrics or {},
    }
    json.dump(meta, open(BUNDLED_META, "w"), ensure_ascii=False, indent=2)
    log(f"已覆盖 bundled 模型 (cv_auc={cv_auc:.4f} n_est={n_est})")
    return meta, cv_auc


def upload_oss():
    """把新模型上传 OSS(quantmodel/)。缺 OSS 凭证则跳过(只更新本地 bundled)。
    若信号头产物存在则一并上传(高把握买点当天同步热更新)。"""
    if not (os.environ.get("OSS_ACCESS_KEY_ID") and os.environ.get("OSS_BUCKET")):
        log("未配置 OSS_* 环境变量，跳过上传(本地 bundled 已更新，下次部署随包生效)")
        return False
    cmd = [sys.executable, os.path.join(HERE, "upload_model.py"),
           "--model", BUNDLED_MODEL, "--meta", BUNDLED_META]
    if os.path.exists(BUNDLED_SIGNAL) and os.path.exists(BUNDLED_SIGNAL_META):
        cmd += ["--signal", BUNDLED_SIGNAL, "--signal-meta", BUNDLED_SIGNAL_META]
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=180)
    sys.stdout.write(r.stdout or "")
    if r.returncode != 0:
        sys.stderr.write(r.stderr or "")
        log("OSS 上传失败(线上暂不热更新，本地 bundled 已更新)")
        return False
    log("已上传 OSS，量化服务将在 1 小时内热更新自动上线")
    return True


def retrain_signal_head(pool, bars):
    """重训「高把握买点」信号头(可信度>=85% 闸门)，实现每天 gate 随新样本前推。
    冠军-挑战者护栏：新信号头须在样本外 holdout 上精确率 >= SIGNAL_PREC_FLOOR
    且信号数 >= SIGNAL_MIN_N 才覆盖 bundled；否则保留旧信号头(绝不降低可信度)。
    返回 dict(决策记录) 或 None(构建失败)。"""
    # 1) 重建 sweep.npz(多口径评测集，含 fmax5)；失败则用现有的
    cmd = [sys.executable, os.path.join(HERE, "build_sweep.py")]
    try:
        log("重建 sweep(信号头评测集)...")
        r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=1500)
        sys.stdout.write(r.stdout[-800:] if r.stdout else "")
        if r.returncode != 0 and not os.path.exists(SWEEP):
            sys.stderr.write(r.stderr[-800:] if r.stderr else "")
            return {"signal_decision": "error", "stage": "build_sweep"}
    except Exception as e:  # noqa: BLE001
        if not os.path.exists(SWEEP):
            return {"signal_decision": "error", "stage": "build_sweep", "error": str(e)[:160]}

    # 2) 训练候选信号头到临时文件(不直接覆盖 bundled，先过护栏)
    cand_model = os.path.join(HERE, "lgb_signal.cand.txt")
    cand_meta = os.path.join(HERE, "signal_meta.cand.json")
    tr = subprocess.run(
        [sys.executable, os.path.join(HERE, "train_signal.py"),
         "--out-model", cand_model, "--out-meta", cand_meta],
        cwd=HERE, capture_output=True, text=True, timeout=900)
    sys.stdout.write(tr.stdout[-800:] if tr.stdout else "")
    if tr.returncode != 0 or not os.path.exists(cand_meta):
        sys.stderr.write(tr.stderr[-800:] if tr.stderr else "")
        return {"signal_decision": "error", "stage": "train_signal"}

    # 3) 护栏：候选信号头在其自身 holdout 上的样本外精确率必须达标
    cm = json.load(open(cand_meta))
    prec = cm.get("holdout_precision")
    n_sig = cm.get("n_signal_holdout", 0)
    ok = (prec is not None and np.isfinite(prec)
          and prec >= SIGNAL_PREC_FLOOR and n_sig >= SIGNAL_MIN_N)
    rec = {"signal_holdout_precision": (round(float(prec), 4) if prec is not None else None),
           "signal_gate": cm.get("gate"), "signal_n": int(n_sig),
           "signal_prec_floor": SIGNAL_PREC_FLOOR}
    if ok:
        os.replace(cand_model, BUNDLED_SIGNAL)
        os.replace(cand_meta, BUNDLED_SIGNAL_META)
        rec["signal_decision"] = "promote"
        log(f"信号头晋级: 样本外精确率={prec*100:.1f}% gate={cm.get('gate')} n={n_sig}")
    else:
        for p in (cand_model, cand_meta):
            try:
                os.remove(p)
            except OSError:
                pass
        rec["signal_decision"] = "reject"
        log(f"信号头拒绝(保留旧版): 精确率={prec} n={n_sig} 未达 {SIGNAL_PREC_FLOOR}/{SIGNAL_MIN_N}")
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", type=int, default=600)
    ap.add_argument("--bars", type=int, default=700)  # 与冠军训练同深度(700根)，保证挑战者数据量对等、可公平胜出
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--dry-run", action="store_true", help="只训练评测打印决策，不写文件不上传")
    ap.add_argument("--skip-build", action="store_true", help="复用现有 dataset.npz(调试用)")
    a = ap.parse_args()

    t0 = time.time()
    sync_champion_from_oss()
    build_meta = {}
    try:
        build_meta = json.load(open(BUNDLED_META, encoding="utf-8"))
    except Exception:  # noqa: BLE001
        pass
    try:
        if not a.skip_build:
            build_dataset(
                a.pool,
                a.bars,
                a.horizon,
                forecast_after=build_meta.get("data_end_date", ""),
            )
        (
            X,
            y,
            dates,
            codes,
            feat_names,
            next_up_probabilities,
            next_actual_up,
            next_range_hit,
        ) = load_dataset()
    except DataUnavailable as e:
        # 数据源不可达(非代码错误):记一条 skip 审计,正常退出(不改线上、不判红报警)。
        append_history({"decision": "skip", "reason": "data_unavailable", "detail": str(e)[:200]})
        log("数据源不可达,跳过当日重训(线上保持冠军不变):", e)
        sys.exit(0)
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

    champion, champion_meta = load_champion()
    publish_current_production_accuracy(
        champion,
        champion_meta,
        X,
        y,
        dates,
        codes,
        feat_names,
        next_up_probabilities,
        next_actual_up,
        next_range_hit,
    )
    champion_data_end = champion_meta.get("data_end_date")
    hold_dates = []
    adapt_dates = []
    adapt_n = 0
    training_weights = None
    champion_metrics = None
    challenger_metrics = None
    metric_gate = None
    evaluation_protocol = "legacy_recorded_holdout"
    if champion is not None and champion_data_end:
        tr_idx, hold_idx, adapt_dates, hold_dates = (
            incremental_adaptation_split(
                dates,
                champion_data_end,
                blind_dates=BLIND_MIN_DATES,
            )
        )
        champion_end_key = _date_key(champion_data_end)
        adapt_n = int(np.sum([
            _date_key(dates[i]) > champion_end_key for i in tr_idx
        ]))
        if not incremental_window_ready(
            adapt_n,
            adapt_dates,
            len(hold_idx),
            hold_dates,
        ):
            rec = {
                "decision": "skip",
                "reason": "insufficient_incremental_window",
                "champion_data_end": champion_data_end,
                "adapt_n": adapt_n,
                "adapt_dates": adapt_dates,
                "blind_n": int(len(hold_idx)),
                "blind_dates": hold_dates,
                "required_adapt_samples": ADAPT_MIN_SAMPLES,
                "required_adapt_dates": ADAPT_MIN_DATES,
                "required_blind_samples": BLIND_MIN_SAMPLES,
                "required_blind_dates": BLIND_MIN_DATES,
            }
            if not a.dry_run:
                append_history(rec)
            log(
                "增量适配或盲测样本不足，等待成熟标签积累:",
                json.dumps(rec, ensure_ascii=False),
            )
            return
        champion_X = align_features(champion_meta, feat_names, X[hold_idx])
        if champion_X is None:
            append_history({
                "decision": "error", "stage": "feature_alignment",
                "reason": "champion_features_incompatible",
            })
            log("冠军特征与当前数据集不兼容，停止对拍")
            sys.exit(1)
        if len(set(y[hold_idx])) < 2:
            rec = {
                "decision": "skip", "reason": "single_class_forward_holdout",
                "champion_data_end": champion_data_end,
                "blind_n": int(len(hold_idx)), "blind_dates": hold_dates,
            }
            if not a.dry_run:
                append_history(rec)
            log("前向保留集只有单一标签，等待更多成熟样本")
            return
        champion_metrics = prediction_metrics(
            y[hold_idx],
            champion.predict(champion_X),
        )
        champ_auc = champion_metrics["auc"]
        champ_src = "incremental_blind_forward"
        cut_date = hold_dates[0]
        evaluation_protocol = "incremental_adaptation_then_blind_forward"
        training_weights = recency_sample_weights(
            dates[tr_idx],
            champion_data_end=champion_data_end,
        )
        log(
            f"增量训练窗: champion_data_end={champion_data_end} "
            f"adapt_dates={len(adapt_dates)} adapt_n={adapt_n} "
            f"blind_dates={len(hold_dates)} blind_n={len(hold_idx)}"
        )
    else:
        # 兼容尚未记录训练截止日的旧冠军；当前 bundled 已补齐该字段，
        # 这里只保留为部署迁移期间的兜底。
        tr_idx, hold_idx, cut_date = date_holdout_split(dates, HOLDOUT_FRAC)
        champ_auc, champ_src = champion_baseline()
        log(f"旧版保留评测集: cut_date={cut_date} train={len(tr_idx)} holdout={len(hold_idx)}")

    # 挑战者与冠军严格在同一保留集上评测
    challenger_metrics, _ = train_challenger(
        X[tr_idx],
        y[tr_idx],
        dates[tr_idx],
        X[hold_idx],
        y[hold_idx],
        weights=training_weights,
    )
    chall_auc = challenger_metrics["auc"]

    # ---- 护栏决策 ----
    above_floor = chall_auc >= AUC_FLOOR
    no_champ = champ_auc is None or not np.isfinite(champ_auc)
    if champion_metrics is not None:
        metric_gate = should_promote_metrics(
            champion_metrics,
            challenger_metrics,
        )
        should_promote = metric_gate["promote"]
        log(
            "盲测指标 → "
            f"冠军 AUC={champion_metrics['auc']:.4f} "
            f"logloss={champion_metrics['logloss']:.4f} "
            f"top精度={champion_metrics['top_precision']:.4f}; "
            f"挑战者 AUC={challenger_metrics['auc']:.4f} "
            f"logloss={challenger_metrics['logloss']:.4f} "
            f"top精度={challenger_metrics['top_precision']:.4f}; "
            f"gate={metric_gate}"
        )
    else:
        beats_champ = no_champ or (chall_auc >= champ_auc - TOL)
        should_promote = above_floor and beats_champ
        log(
            f"旧版样本外 AUC → 冠军="
            f"{champ_auc if champ_auc is None else round(champ_auc,4)}"
            f"(来源{champ_src}) 挑战者={round(chall_auc,4)}"
        )

    base = {
        "n_samples": n, "pos_rate": round(pos_rate, 4), "cut_date": cut_date,
        "holdout_n": int(len(hold_idx)),
        "champ_baseline_auc": (None if no_champ else round(champ_auc, 4)),
        "champ_baseline_src": champ_src,
        "chall_holdout_auc": round(chall_auc, 4),
        "evaluation_protocol": evaluation_protocol,
        "champion_data_end": champion_data_end,
        "holdout_dates": hold_dates,
        "adapt_n": adapt_n,
        "adapt_dates": adapt_dates,
        "blind_n": int(len(hold_idx)),
        "blind_dates": hold_dates,
        "champion_metrics": champion_metrics,
        "challenger_metrics": challenger_metrics,
        "metric_gate": metric_gate,
        "recency_half_life_dates": (
            RECENCY_HALF_LIFE_DATES if training_weights is not None else None
        ),
        "new_sample_boost": (
            NEW_SAMPLE_BOOST if training_weights is not None else None
        ),
        "tol": TOL, "auc_floor": AUC_FLOOR,
        "elapsed_s": round(time.time() - t0, 1),
    }

    if a.dry_run:
        base["decision"] = "promote" if should_promote else "reject"
        base["dry_run"] = True
        log("DRY-RUN 决策:", json.dumps(base, ensure_ascii=False))
        return

    if not should_promote:
        if not above_floor:
            reason = "below_floor"
        elif metric_gate is not None and not metric_gate["non_degraded"]:
            reason = "metric_regression"
        elif metric_gate is not None:
            reason = "no_incremental_improvement"
        else:
            reason = "not_better_than_champion"
        rec = {**base, "decision": "reject", "reason": reason}
        # 打分模型不晋级，但高把握买点信号头仍按自身护栏独立每日重训(gate 随新样本前推)
        sig_rec = retrain_signal_head(a.pool, a.bars)
        if sig_rec:
            rec.update(sig_rec)
            if sig_rec.get("signal_decision") == "promote":
                rec["oss_uploaded"] = upload_oss()
        append_history(rec)
        log("拒绝晋级(保留冠军，线上不变):", reason)
        return

    final_weights = (
        recency_sample_weights(
            dates,
            champion_data_end=champion_data_end,
        )
        if champion_data_end
        else None
    )
    evaluation_metrics = {
        "protocol": evaluation_protocol,
        "champion": champion_metrics,
        "challenger": challenger_metrics,
        "gate": metric_gate,
        "adapt_n": adapt_n,
        "adapt_dates": adapt_dates,
        "blind_n": int(len(hold_idx)),
        "blind_dates": hold_dates,
    }
    meta, cv_auc = promote(
        X,
        y,
        dates,
        feat_names,
        chall_auc,
        (None if no_champ else champ_auc),
        weights=final_weights,
        evaluation_metrics=evaluation_metrics,
    )
    publish_current_production_accuracy(
        lgb.Booster(model_file=BUNDLED_MODEL),
        meta,
        X,
        y,
        dates,
        codes,
        feat_names,
        next_up_probabilities,
        next_actual_up,
        next_range_hit,
    )
    # 高把握买点信号头：与主模型同批每日重训(独立精确率护栏)
    sig_rec = retrain_signal_head(a.pool, a.bars) or {}
    uploaded = upload_oss()
    rec = {**base, "decision": "promote", "cv_auc": round(cv_auc, 4),
           "n_estimators": meta["n_estimators"], "oss_uploaded": uploaded, **sig_rec}
    append_history(rec)
    log("晋级完成:", json.dumps(rec, ensure_ascii=False))


if __name__ == "__main__":
    main()
