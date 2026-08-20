"""Champion-challenger training for independent next/week sector heads."""
import argparse
import json
import math
import os
import time

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
NEXT_MODEL = os.path.join(HERE, "sector_next_lgb.txt")
WEEK_MODEL = os.path.join(HERE, "sector_week_lgb.txt")
META_PATH = os.path.join(HERE, "sector_meta.json")
HARD_ERRORS_PATH = os.path.join(HERE, "sector_hard_errors.json")
DATASET_PATH = os.path.join(HERE, "sector_dataset.npz")


def _date_key(value):
    return "".join(char for char in str(value) if char.isdigit())


def hard_error_sample_weights(
    dates,
    codes,
    head,
    memory,
    half_life_dates=60,
    normalize=True,
):
    dates = np.asarray(dates).astype(str)
    codes = np.asarray(codes).astype(str)
    weights = np.ones(len(dates), dtype=np.float32)
    sample_map = {
        str(item.get("sampleKey") or ""): item
        for item in (memory or {}).get("samples", [])
        if isinstance(item, dict)
    }
    unique_dates = sorted(set(dates), key=_date_key)
    date_ranks = {value: index for index, value in enumerate(unique_dates)}
    latest = len(unique_dates) - 1
    matched = 0
    for index, (date, code) in enumerate(zip(dates, codes)):
        sample = sample_map.get(
            f"{_date_key(date)}:{code}:{head}"
        )
        if not sample:
            continue
        confidence = float(sample.get("confidence") or 0.0)
        target = min(3.0, 2.0 + np.clip(confidence, 0.0, 1.0))
        age = latest - date_ranks[date]
        decay = 0.5 ** (age / max(1, int(half_life_dates)))
        weights[index] = 1.0 + (target - 1.0) * decay
        matched += 1
    if normalize and len(weights) and weights.mean() > 0:
        weights /= weights.mean()
    return weights, {
        "matched_n": matched,
        "memory_total": len(sample_map),
        "half_life_dates": int(half_life_dates),
        "max_multiplier": round(float(weights.max()), 3),
    }


def recency_sample_weights(dates, half_life_dates=120):
    dates = np.asarray(dates).astype(str)
    if not len(dates):
        return np.asarray([], dtype=np.float32)
    unique_dates = sorted(set(dates), key=_date_key)
    ranks = {value: index for index, value in enumerate(unique_dates)}
    latest = len(unique_dates) - 1
    weights = np.asarray([
        max(
            0.25,
            0.5 ** (
                (latest - ranks[date])
                / max(1, int(half_life_dates))
            ),
        )
        for date in dates
    ], dtype=np.float32)
    return weights / weights.mean()


def collect_hard_errors(
    dates,
    codes,
    labels,
    probabilities,
    head,
    memory=None,
    minimum_confidence=0.3,
    limit=5000,
):
    samples = {
        str(item.get("sampleKey") or ""): item
        for item in (memory or {}).get("samples", [])
        if isinstance(item, dict) and item.get("sampleKey")
    }
    now = int(time.time())
    for date, code, label, probability in zip(
        np.asarray(dates).astype(str),
        np.asarray(codes).astype(str),
        np.asarray(labels).astype(int),
        np.asarray(probabilities).astype(float),
    ):
        predicted = int(probability >= 0.5)
        confidence = abs(float(probability) - 0.5) * 2
        if predicted == int(label) or confidence < minimum_confidence:
            continue
        sample_key = f"{_date_key(date)}:{code}:{head}"
        samples[sample_key] = {
            "sampleKey": sample_key,
            "date": _date_key(date),
            "code": str(code),
            "head": head,
            "label": int(label),
            "probability": round(float(probability), 6),
            "confidence": round(float(confidence), 6),
            "updatedAt": now,
        }
    ordered = sorted(
        samples.values(),
        key=lambda item: (
            int(item.get("updatedAt") or 0),
            str(item.get("sampleKey") or ""),
        ),
        reverse=True,
    )[: max(1, int(limit))]
    return {
        "schemaVersion": "sector-hard-errors.v1",
        "updatedAt": now,
        "total": len(ordered),
        "samples": ordered,
    }


def _dcg(labels):
    return sum(
        float(label) / math.log2(index + 2)
        for index, label in enumerate(labels)
    )


def ranking_metrics(labels, probabilities, dates, top_k=5):
    labels = np.asarray(labels, dtype=int)
    probabilities = np.asarray(probabilities, dtype=float)
    dates = np.asarray(dates).astype(str)
    ndcgs = []
    precisions = []
    for date in sorted(set(dates), key=_date_key):
        selected = np.flatnonzero(dates == date)
        order = selected[
            np.argsort(-probabilities[selected], kind="stable")
        ]
        top = order[: max(1, min(int(top_k), len(order)))]
        ideal = np.sort(labels[selected])[::-1][
            : max(1, min(int(top_k), len(selected)))
        ]
        ideal_dcg = _dcg(ideal)
        ndcgs.append(_dcg(labels[top]) / ideal_dcg if ideal_dcg else 0.0)
        precisions.append(float(labels[top].mean()))
    return {
        "ndcg_at_5": float(np.mean(ndcgs)) if ndcgs else 0.0,
        "top5_precision": (
            float(np.mean(precisions)) if precisions else 0.0
        ),
    }


def prediction_metrics(labels, probabilities, dates):
    from sklearn.metrics import log_loss, roc_auc_score

    labels = np.asarray(labels, dtype=int)
    probabilities = np.clip(
        np.asarray(probabilities, dtype=float),
        1e-6,
        1 - 1e-6,
    )
    metrics = ranking_metrics(labels, probabilities, dates, top_k=5)
    metrics.update({
        "auc": (
            float(roc_auc_score(labels, probabilities))
            if len(set(labels)) > 1
            else 0.5
        ),
        "logloss": float(
            log_loss(labels, probabilities, labels=[0, 1])
        ),
        "samples": int(len(labels)),
    })
    return metrics


def should_promote_heads(champion, challenger):
    improvements = []
    per_head = {}
    for head in ("next", "week"):
        current = champion[head]
        candidate = challenger[head]
        deltas = {
            "auc": candidate["auc"] - current["auc"],
            "logloss": candidate["logloss"] - current["logloss"],
            "ndcg_at_5": (
                candidate["ndcg_at_5"] - current["ndcg_at_5"]
            ),
            "top5_precision": (
                candidate["top5_precision"]
                - current["top5_precision"]
            ),
        }
        non_degraded = (
            deltas["auc"] >= -0.002
            and deltas["logloss"] <= 0.005
            and deltas["ndcg_at_5"] >= -0.01
            and deltas["top5_precision"] >= -0.01
        )
        per_head[head] = {
            "non_degraded": non_degraded,
            "deltas": {
                key: round(float(value), 6)
                for key, value in deltas.items()
            },
        }
        if deltas["auc"] >= 0.005:
            improvements.append(f"{head}:auc")
        if deltas["logloss"] <= -0.005:
            improvements.append(f"{head}:logloss")
        if deltas["ndcg_at_5"] >= 0.02:
            improvements.append(f"{head}:ndcg")
        if deltas["top5_precision"] >= 0.02:
            improvements.append(f"{head}:top5")
    return {
        "promote": bool(
            all(item["non_degraded"] for item in per_head.values())
            and improvements
        ),
        "improvements": improvements,
        "heads": per_head,
    }


def _load_memory():
    if os.path.exists(HARD_ERRORS_PATH):
        with open(HARD_ERRORS_PATH, encoding="utf-8") as handle:
            return json.load(handle)
    try:
        from model_lib import _oss_bucket
        bucket = _oss_bucket()
        if bucket is None:
            return {"samples": []}
        prefix = os.environ.get("SECTOR_MODEL_PREFIX", "sectormodel/")
        payload = json.loads(
            bucket.get_object(
                prefix + "hard_errors.json"
            ).read().decode("utf-8")
        )
        return payload if isinstance(payload, dict) else {"samples": []}
    except Exception:
        return {"samples": []}


def _save_memory(memory):
    with open(HARD_ERRORS_PATH, "w", encoding="utf-8") as handle:
        json.dump(memory, handle, ensure_ascii=False, indent=2)
    try:
        from model_lib import _oss_bucket
        bucket = _oss_bucket()
        if bucket is None:
            return False
        prefix = os.environ.get("SECTOR_MODEL_PREFIX", "sectormodel/")
        bucket.put_object_from_file(
            prefix + "hard_errors.json",
            HARD_ERRORS_PATH,
        )
        return True
    except Exception:
        return False


def _load_dataset(path):
    data = np.load(path, allow_pickle=True)
    return {
        key: data[key]
        for key in data.files
    }


def _split_by_dates(dates, holdout_dates=20, purge_dates=5):
    unique = sorted(set(dates.astype(str)), key=_date_key)
    if len(unique) <= holdout_dates + purge_dates:
        raise ValueError("sector dataset has too few dates for blind holdout")
    holdout = set(unique[-holdout_dates:])
    train = set(unique[: -(holdout_dates + purge_dates)])
    return (
        np.flatnonzero(np.isin(dates, list(train))),
        np.flatnonzero(np.isin(dates, list(holdout))),
    )


def _fit_head(X, labels, weights):
    import lightgbm as lgb
    model = lgb.LGBMClassifier(
        objective="binary",
        n_estimators=240,
        learning_rate=0.035,
        num_leaves=31,
        max_depth=6,
        min_child_samples=40,
        subsample=0.85,
        subsample_freq=1,
        colsample_bytree=0.85,
        reg_alpha=0.2,
        reg_lambda=0.8,
        random_state=42,
        n_jobs=-1,
        verbosity=-1,
    )
    model.fit(X, labels, sample_weight=weights)
    return model.booster_


def _load_champion():
    try:
        from sector_model import get_sector_models
        models, meta = get_sector_models(force=True)
        if models and models[0] is not None and models[1] is not None:
            return models, (meta or {})
    except Exception:
        pass
    if not (
        os.path.exists(NEXT_MODEL)
        and os.path.exists(WEEK_MODEL)
        and os.path.exists(META_PATH)
    ):
        return None, None
    import lightgbm as lgb
    with open(META_PATH, encoding="utf-8") as handle:
        meta = json.load(handle)
    return (
        lgb.Booster(model_file=NEXT_MODEL),
        lgb.Booster(model_file=WEEK_MODEL),
    ), meta


def _save_and_upload(models, meta):
    models[0].save_model(NEXT_MODEL)
    models[1].save_model(WEEK_MODEL)
    with open(META_PATH, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
    try:
        from model_lib import _oss_bucket
        bucket = _oss_bucket()
        if bucket is None:
            return False
        prefix = os.environ.get("SECTOR_MODEL_PREFIX", "sectormodel/")
        bucket.put_object_from_file(prefix + "next_lgb.txt", NEXT_MODEL)
        bucket.put_object_from_file(prefix + "week_lgb.txt", WEEK_MODEL)
        bucket.put_object_from_file(prefix + "meta.json", META_PATH)
        if os.path.exists(HARD_ERRORS_PATH):
            bucket.put_object_from_file(
                prefix + "hard_errors.json",
                HARD_ERRORS_PATH,
            )
        return True
    except Exception:
        return False


def train(path=DATASET_PATH, dry_run=False):
    data = _load_dataset(path)
    X = data["X"].astype(np.float32)
    dates = data["dates"].astype(str)
    codes = data["codes"].astype(str)
    feature_names = [str(item) for item in data["feat_names"]]
    train_idx, hold_idx = _split_by_dates(dates)
    memory = _load_memory()
    challenger_models = []
    challenger_metrics = {}
    challenger_probabilities = {}
    weight_reports = {}
    for head, label_key in (
        ("next", "y_next"),
        ("week", "y_week"),
    ):
        labels = data[label_key].astype(int)
        hard_weights, weight_report = hard_error_sample_weights(
            dates[train_idx],
            codes[train_idx],
            head,
            memory,
            normalize=False,
        )
        weights = (
            recency_sample_weights(dates[train_idx]) * hard_weights
        )
        weights /= weights.mean()
        model = _fit_head(
            X[train_idx],
            labels[train_idx],
            weights,
        )
        challenger_models.append(model)
        probabilities = model.predict(X[hold_idx])
        challenger_probabilities[head] = probabilities
        challenger_metrics[head] = prediction_metrics(
            labels[hold_idx],
            probabilities,
            dates[hold_idx],
        )
        weight_reports[head] = weight_report

    champion_models, _champion_meta = _load_champion()
    if champion_models:
        champion_metrics = {}
        production_probabilities = {}
        for index, (head, label_key) in enumerate((
            ("next", "y_next"),
            ("week", "y_week"),
        )):
            probabilities = champion_models[index].predict(X[hold_idx])
            production_probabilities[head] = probabilities
            champion_metrics[head] = prediction_metrics(
                data[label_key].astype(int)[hold_idx],
                probabilities,
                dates[hold_idx],
            )
        gate = should_promote_heads(
            champion_metrics,
            challenger_metrics,
        )
    else:
        champion_metrics = None
        production_probabilities = challenger_probabilities
        gate = {
            "promote": all(
                metrics["auc"] >= 0.52
                for metrics in challenger_metrics.values()
            ),
            "improvements": ["initial-model"],
            "heads": {},
        }

    next_memory = memory
    for head, label_key in (
        ("next", "y_next"),
        ("week", "y_week"),
    ):
        next_memory = collect_hard_errors(
            dates[hold_idx],
            codes[hold_idx],
            data[label_key].astype(int)[hold_idx],
            production_probabilities[head],
            head,
            memory=next_memory,
        )
    memory_uploaded = False if dry_run else _save_memory(next_memory)
    promoted = bool(gate["promote"] and not dry_run)
    meta = {
        "modelVersion": f"sector-lgb-{int(time.time())}",
        "feat_names": feature_names,
        "trained_at": int(time.time()),
        "data_end_date": str(max(dates, key=_date_key)),
        "n_samples": int(len(X)),
        "blind_dates": sorted(
            set(dates[hold_idx]), key=_date_key
        ),
        "challenger_metrics": challenger_metrics,
        "champion_metrics": champion_metrics,
        "promotion_gate": gate,
        "hard_error_weighting": weight_reports,
        "hard_error_memory": {
            "total": int(next_memory.get("total") or 0),
            "uploaded": memory_uploaded,
        },
        "week_drawdown_estimate": round(
            float(np.nanmedian(data["week_drawdown"])),
            2,
        ),
        "data_source": "tushare_ths_daily+moneyflow_ind_ths",
    }
    uploaded = False
    if promoted:
        final_models = []
        for head, label_key in (
            ("next", "y_next"),
            ("week", "y_week"),
        ):
            hard_weights, _ = hard_error_sample_weights(
                dates,
                codes,
                head,
                memory,
                normalize=False,
            )
            weights = recency_sample_weights(dates) * hard_weights
            weights /= weights.mean()
            final_models.append(
                _fit_head(X, data[label_key].astype(int), weights)
            )
        uploaded = _save_and_upload(tuple(final_models), meta)
    return {
        "promoted": promoted,
        "uploaded": uploaded,
        "meta": meta,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default=DATASET_PATH)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    result = train(args.dataset, args.dry_run)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
