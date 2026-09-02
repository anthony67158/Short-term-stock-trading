"""Leak-free evaluation and serializable probability calibration helpers."""

import numpy as np


def _probabilities(values):
    probabilities = np.asarray(values, dtype=np.float64)
    if (
        probabilities.ndim != 1
        or not len(probabilities)
        or not np.isfinite(probabilities).all()
        or np.any(probabilities < 0)
        or np.any(probabilities > 1)
    ):
        raise ValueError("概率必须是一维且位于0到1之间")
    return np.clip(probabilities, 1e-8, 1 - 1e-8)


def _binary_labels(values):
    labels = np.asarray(values, dtype=np.int8)
    if labels.ndim != 1 or not len(labels):
        raise ValueError("二分类标签必须是一维非空数组")
    if not set(np.unique(labels)).issubset({0, 1}):
        raise ValueError("二分类标签只能为0或1")
    return labels


def _ranks(values):
    values = np.asarray(values, dtype=np.float64)
    order = np.argsort(values, kind="stable")
    ranks = np.empty(len(values), dtype=np.float64)
    cursor = 0
    while cursor < len(order):
        end = cursor + 1
        while (
            end < len(order)
            and values[order[end]] == values[order[cursor]]
        ):
            end += 1
        rank = (cursor + end - 1) / 2 + 1
        ranks[order[cursor:end]] = rank
        cursor = end
    return ranks


def _auc(labels, probabilities):
    positives = labels == 1
    positive_count = int(positives.sum())
    negative_count = len(labels) - positive_count
    if not positive_count or not negative_count:
        return None
    ranks = _ranks(probabilities)
    rank_sum = float(ranks[positives].sum())
    return (
        rank_sum - positive_count * (positive_count + 1) / 2
    ) / (positive_count * negative_count)


def reliability_bins(labels, probabilities, bins=10):
    labels = _binary_labels(labels)
    probabilities = _probabilities(probabilities)
    if len(labels) != len(probabilities):
        raise ValueError("概率与标签长度不一致")
    output = []
    for index in range(max(2, int(bins))):
        low = index / bins
        high = (index + 1) / bins
        selected = (
            (probabilities >= low)
            & (
                probabilities <= high
                if index == bins - 1
                else probabilities < high
            )
        )
        if not selected.any():
            continue
        output.append({
            "low": round(low, 3),
            "high": round(high, 3),
            "samples": int(selected.sum()),
            "mean_probability": round(
                float(probabilities[selected].mean()),
                6,
            ),
            "positive_rate": round(
                float(labels[selected].mean()),
                6,
            ),
        })
    return output


def binary_metrics(labels, probabilities):
    labels = _binary_labels(labels)
    probabilities = _probabilities(probabilities)
    if len(labels) != len(probabilities):
        raise ValueError("概率与标签长度不一致")
    log_loss = -np.mean(
        labels * np.log(probabilities)
        + (1 - labels) * np.log(1 - probabilities)
    )
    return {
        "samples": int(len(labels)),
        "positive_rate": round(float(labels.mean()), 6),
        "brier": round(
            float(np.mean(np.square(probabilities - labels))),
            6,
        ),
        "log_loss": round(float(log_loss), 6),
        "auc": (
            round(float(_auc(labels, probabilities)), 6)
            if _auc(labels, probabilities) is not None
            else None
        ),
        "reliability": reliability_bins(labels, probabilities),
    }


def regression_metrics(actual, predicted):
    actual = np.asarray(actual, dtype=np.float64)
    predicted = np.asarray(predicted, dtype=np.float64)
    if (
        actual.ndim != 1
        or predicted.shape != actual.shape
        or not len(actual)
        or not np.isfinite(actual).all()
        or not np.isfinite(predicted).all()
    ):
        raise ValueError("回归评测输入无效")
    errors = predicted - actual
    actual_ranks = _ranks(actual)
    predicted_ranks = _ranks(predicted)
    rank_correlation = (
        float(np.corrcoef(actual_ranks, predicted_ranks)[0, 1])
        if len(actual) > 1
        and np.std(actual_ranks) > 0
        and np.std(predicted_ranks) > 0
        else None
    )
    return {
        "samples": int(len(actual)),
        "mae": round(float(np.mean(np.abs(errors))), 6),
        "rmse": round(float(np.sqrt(np.mean(np.square(errors)))), 6),
        "rank_correlation": (
            round(rank_correlation, 6)
            if rank_correlation is not None
            else None
        ),
    }


def ranking_metrics(
    positive_labels,
    relevance,
    scores,
    dates,
    *,
    top_k=5,
):
    positive = np.asarray(positive_labels, dtype=bool)
    relevance = np.asarray(relevance, dtype=np.float64)
    scores = np.asarray(scores, dtype=np.float64)
    dates = np.asarray(dates).astype(str)
    if not (
        positive.shape
        == relevance.shape
        == scores.shape
        == dates.shape
    ) or positive.ndim != 1:
        raise ValueError("排序评测输入维度不一致")
    if not np.isfinite(relevance).all() or not np.isfinite(scores).all():
        raise ValueError("排序评测包含非有限数值")
    precisions = []
    ndcgs = []
    net_returns = []
    daily_net_r = {}
    k = max(1, int(top_k))
    for date in sorted(set(dates)):
        selected = np.flatnonzero(dates == date)
        if not len(selected):
            continue
        order = selected[
            np.argsort(-scores[selected], kind="stable")
        ][: min(k, len(selected))]
        ideal = np.sort(np.maximum(relevance[selected], 0))[::-1][
            : len(order)
        ]
        discounts = 1 / np.log2(np.arange(len(order)) + 2)
        dcg = float(
            np.sum(np.maximum(relevance[order], 0) * discounts)
        )
        ideal_dcg = float(np.sum(ideal * discounts))
        precisions.append(float(positive[order].mean()))
        ndcgs.append(dcg / ideal_dcg if ideal_dcg > 0 else 0.0)
        daily_net_r[date] = float(relevance[order].mean())
        net_returns.append(daily_net_r[date])
    return {
        f"precision_at_{k}": round(float(np.mean(precisions)), 6)
        if precisions else None,
        f"ndcg_at_{k}": round(float(np.mean(ndcgs)), 6)
        if ndcgs else None,
        f"mean_net_r_at_{k}": round(float(np.mean(net_returns)), 6)
        if net_returns else None,
        "daily_net_r": daily_net_r,
    }


def block_bootstrap_lower_bound(
    values_by_date,
    *,
    confidence=0.95,
    samples=1000,
    random_state=42,
):
    values = np.asarray(
        list((values_by_date or {}).values()),
        dtype=np.float64,
    )
    if not len(values) or not np.isfinite(values).all():
        return None
    rng = np.random.default_rng(random_state)
    draws = rng.choice(
        values,
        size=(max(100, int(samples)), len(values)),
        replace=True,
    ).mean(axis=1)
    percentile = max(0.0, min(100.0, (1 - confidence) * 100))
    return round(float(np.percentile(draws, percentile)), 6)


def _fit_sigmoid(labels, probabilities):
    x = np.log(
        probabilities / (1 - probabilities)
    )
    design = np.column_stack([x, np.ones(len(x))])
    coefficients = np.asarray([1.0, 0.0], dtype=np.float64)
    for _ in range(100):
        logits = np.clip(design @ coefficients, -30, 30)
        fitted = 1 / (1 + np.exp(-logits))
        weights = np.maximum(fitted * (1 - fitted), 1e-6)
        gradient = design.T @ (fitted - labels)
        hessian = design.T @ (design * weights[:, None])
        hessian += np.eye(2) * 1e-6
        step = np.linalg.solve(hessian, gradient)
        coefficients -= step
        coefficients[0] = max(0.01, coefficients[0])
        if float(np.max(np.abs(step))) < 1e-8:
            break
    return {
        "method": "sigmoid",
        "coefficient": round(float(coefficients[0]), 12),
        "intercept": round(float(coefficients[1]), 12),
    }


def _fit_isotonic(labels, probabilities):
    order = np.argsort(probabilities, kind="stable")
    x = probabilities[order]
    y = labels[order].astype(np.float64)
    unique_x, inverse = np.unique(x, return_inverse=True)
    sums = np.bincount(inverse, weights=y).astype(np.float64)
    weights = np.bincount(inverse).astype(np.float64)
    values = sums / weights
    blocks = [
        [float(value), float(weight), index, index]
        for index, (value, weight) in enumerate(zip(values, weights))
    ]
    cursor = 0
    while cursor < len(blocks) - 1:
        if blocks[cursor][0] <= blocks[cursor + 1][0]:
            cursor += 1
            continue
        left = blocks[cursor]
        right = blocks[cursor + 1]
        weight = left[1] + right[1]
        merged = [
            (left[0] * left[1] + right[0] * right[1]) / weight,
            weight,
            left[2],
            right[3],
        ]
        blocks[cursor:cursor + 2] = [merged]
        cursor = max(0, cursor - 1)
    fitted = np.empty(len(unique_x), dtype=np.float64)
    for value, _, start, end in blocks:
        fitted[start:end + 1] = value
    return {
        "method": "isotonic",
        "x": unique_x.astype(float).tolist(),
        "y": fitted.astype(float).tolist(),
    }


def fit_probability_calibrator(
    labels,
    probabilities,
    *,
    isotonic_minimum=1000,
):
    labels = _binary_labels(labels)
    probabilities = _probabilities(probabilities)
    if len(labels) != len(probabilities):
        raise ValueError("概率与标签长度不一致")
    if len(set(labels.tolist())) < 2:
        raise ValueError("概率校准需要正负两类")
    if len(labels) >= int(isotonic_minimum):
        return _fit_isotonic(labels, probabilities)
    return _fit_sigmoid(labels, probabilities)


def apply_probability_calibrator(probabilities, artifact):
    values = _probabilities(probabilities)
    method = str((artifact or {}).get("method") or "")
    if method == "sigmoid":
        coefficient = float(artifact.get("coefficient"))
        intercept = float(artifact.get("intercept"))
        logits = np.log(values / (1 - values))
        adjusted = 1 / (
            1 + np.exp(-np.clip(
                coefficient * logits + intercept,
                -30,
                30,
            ))
        )
        return np.clip(adjusted, 0, 1)
    if method == "isotonic":
        x = np.asarray(artifact.get("x"), dtype=np.float64)
        y = np.asarray(artifact.get("y"), dtype=np.float64)
        if (
            x.ndim != 1
            or y.shape != x.shape
            or not len(x)
            or not np.isfinite(x).all()
            or not np.isfinite(y).all()
        ):
            raise ValueError("isotonic校准参数无效")
        return np.clip(np.interp(values, x, y), 0, 1)
    raise ValueError("未知概率校准方法")


def shadow_gate(metrics):
    blockers = []
    for head in ("pFill", "pWinGivenFill"):
        challenger = metrics[head]["challenger"]
        baseline = metrics[head]["baseline"]
        if challenger["brier"] > baseline["brier"] + 0.01:
            blockers.append(f"{head} Brier劣于逻辑回归基线")
        if challenger["log_loss"] > baseline["log_loss"] + 0.01:
            blockers.append(f"{head} LogLoss劣于逻辑回归基线")
    challenger = metrics["expectedNetR"]["challenger"]
    baseline = metrics["expectedNetR"]["baseline"]
    if challenger["mae"] > baseline["mae"] * 1.02 + 1e-9:
        blockers.append("expectedNetR MAE劣于线性基线")
    ranking = metrics.get("ranking")
    if ranking:
        challenger = ranking.get("challenger") or {}
        baseline = ranking.get("baseline") or {}
        for name, tolerance in (
            ("ndcg_at_5", 0.01),
            ("precision_at_5", 0.01),
            ("mean_net_r_at_5", 0.05),
        ):
            current = challenger.get(name)
            reference = baseline.get(name)
            if current is None or reference is None:
                blockers.append(f"排序指标{name}不可用")
            elif current < reference - tolerance:
                blockers.append(f"排序指标{name}劣于现有公式")
    return {
        "shadowEligible": not blockers,
        "shadowBlockers": blockers,
        "productionEligible": False,
        "productionBlockers": [
            "尚未完成多个独立时间窗口的前向影子观察",
            "尚未通过净期望下置信界为正的生产门槛",
            "尚未获得人工生产发布确认",
        ],
        "metrics": metrics,
    }
