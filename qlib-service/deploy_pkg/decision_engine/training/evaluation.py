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
    predicted = probabilities >= 0.5
    positive = labels == 1
    true_positive = int(np.sum(predicted & positive))
    false_positive = int(np.sum(predicted & ~positive))
    false_negative = int(np.sum(~predicted & positive))
    precision = (
        true_positive / (true_positive + false_positive)
        if true_positive + false_positive
        else 0.0
    )
    recall = (
        true_positive / (true_positive + false_negative)
        if true_positive + false_negative
        else 0.0
    )
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    log_loss = -np.mean(
        labels * np.log(probabilities)
        + (1 - labels) * np.log(1 - probabilities)
    )
    return {
        "samples": int(len(labels)),
        "positive_rate": round(float(labels.mean()), 6),
        "accuracy": round(float(np.mean(predicted == positive)), 6),
        "precision": round(float(precision), 6),
        "recall": round(float(recall), 6),
        "f1": round(float(f1), 6),
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
    group_ids=None,
    eligible_mask=None,
):
    positive = np.asarray(positive_labels, dtype=bool)
    relevance = np.asarray(relevance, dtype=np.float64)
    scores = np.asarray(scores, dtype=np.float64)
    dates = np.asarray(dates).astype(str)
    groups = (
        np.asarray(group_ids).astype(str)
        if group_ids is not None
        else np.arange(len(dates)).astype(str)
    )
    eligible = (
        np.ones(len(dates), dtype=bool)
        if eligible_mask is None
        else np.asarray(eligible_mask, dtype=bool)
    )
    if not (
        positive.shape
        == relevance.shape
        == scores.shape
        == dates.shape
        == groups.shape
        == eligible.shape
    ) or positive.ndim != 1:
        raise ValueError("排序评测输入维度不一致")
    if not np.isfinite(relevance).all() or not np.isfinite(scores).all():
        raise ValueError("排序评测包含非有限数值")
    precisions = []
    ndcgs = []
    net_returns = []
    daily_net_r = {}
    selected_total = 0
    active_days = 0
    k = max(1, int(top_k))
    for date in sorted(set(dates)):
        selected = np.flatnonzero((dates == date) & eligible)
        if not len(selected):
            precisions.append(0.0)
            ndcgs.append(0.0)
            daily_net_r[date] = 0.0
            net_returns.append(0.0)
            continue
        active_days += 1
        ranked = selected[
            np.argsort(-scores[selected], kind="stable")
        ]
        order = []
        seen_groups = set()
        for index in ranked:
            group = groups[index]
            if group in seen_groups:
                continue
            seen_groups.add(group)
            order.append(index)
            if len(order) >= k:
                break
        order = np.asarray(order, dtype=np.int64)
        selected_total += len(order)
        ideal_by_group = {}
        for index in selected:
            group = groups[index]
            ideal_by_group[group] = max(
                ideal_by_group.get(group, 0.0),
                max(float(relevance[index]), 0.0),
            )
        ideal = np.sort(
            np.asarray(list(ideal_by_group.values()), dtype=np.float64)
        )[::-1][: len(order)]
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
        f"max_drawdown_r_at_{k}": (
            round(float(max(
                np.maximum.accumulate(np.cumsum(net_returns))
                - np.cumsum(net_returns)
            )), 6)
            if net_returns else None
        ),
        f"worst_daily_net_r_at_{k}": (
            round(float(np.min(net_returns)), 6)
            if net_returns else None
        ),
        "daily_net_r": daily_net_r,
        "selected": int(selected_total),
        "active_days": int(active_days),
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


def select_risk_adjusted_trial(
    trials,
    *,
    minimum_coverage=0.02,
):
    candidates = [
        value
        for value in trials
        if (
            value.get("positiveExpectedCoverage") is not None
            and float(value["positiveExpectedCoverage"])
            >= float(minimum_coverage)
        )
    ] or list(trials)
    if not candidates:
        raise ValueError("混合权重候选为空")

    def score(value):
        lower = value.get("netRLowerBound")
        mean = value.get("meanNetRAt5")
        drawdown = value.get("maxDrawdownRAt5")
        weight = value.get("weight")
        return (
            float(lower) if lower is not None else -float("inf"),
            float(mean) if mean is not None else -float("inf"),
            -float(drawdown)
            if drawdown is not None
            else -float("inf"),
            -float(weight),
        )

    return max(candidates, key=score)


def _fit_sigmoid(labels, probabilities):
    x = np.log(
        probabilities / (1 - probabilities)
    )
    coefficients = np.asarray([1.0, 0.0], dtype=np.float64)
    for _ in range(100):
        logits = np.clip(
            x * coefficients[0] + coefficients[1],
            -30,
            30,
        )
        fitted = 1 / (1 + np.exp(-logits))
        weights = np.maximum(fitted * (1 - fitted), 1e-6)
        errors = fitted - labels
        gradient = np.asarray([
            np.dot(x, errors),
            errors.sum(),
        ])
        cross = np.dot(x, weights)
        hessian = np.asarray([
            [np.dot(x * x, weights) + 1e-6, cross],
            [cross, weights.sum() + 1e-6],
        ])
        step = np.linalg.solve(hessian, gradient)
        if not np.isfinite(step).all():
            break
        step = np.clip(step, -2.0, 2.0)
        coefficients -= step
        coefficients[0] = np.clip(coefficients[0], 0.01, 20.0)
        coefficients[1] = np.clip(coefficients[1], -20.0, 20.0)
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


def _calibration_strata(values, expected_length, label):
    items = np.asarray(values).astype(str)
    if items.shape != (expected_length,):
        raise ValueError(f"{label}校准分层维度无效")
    return items


def _stratified_group_keys(playbook_ids, routes):
    return {
        "playbookRoute": np.char.add(
            np.char.add(playbook_ids, ":"),
            routes,
        ),
        "playbook": playbook_ids,
        "route": routes,
    }


def _log_odds(value):
    probability = np.clip(float(value), 1e-6, 1 - 1e-6)
    return float(np.log(probability / (1 - probability)))


def _shift_probability_log_odds(probabilities, offset):
    values = _probabilities(probabilities)
    logits = np.log(values / (1 - values))
    return 1 / (
        1 + np.exp(-np.clip(logits + float(offset), -30, 30))
    )


def _stratified_prior_config(
    labels,
    base_probabilities,
    mask,
    shrinkage_samples,
):
    sample_count = int(mask.sum())
    positive_count = int(labels[mask].sum())
    negative_count = sample_count - positive_count
    strength = max(0.0, float(shrinkage_samples))
    base_rate = float(base_probabilities[mask].mean())
    adjusted_rate = (
        positive_count + strength * base_rate
    ) / (
        sample_count + strength
    )
    return {
        "sampleCount": sample_count,
        "positiveCount": positive_count,
        "negativeCount": negative_count,
        "empiricalRate": round(
            positive_count / sample_count,
            12,
        ),
        "baseRate": round(base_rate, 12),
        "adjustedRate": round(adjusted_rate, 12),
        "logOddsOffset": round(
            _log_odds(adjusted_rate)
            - _log_odds(base_rate),
            12,
        ),
    }


def fit_stratified_probability_calibrator(
    labels,
    probabilities,
    playbook_ids,
    routes,
    *,
    dates=None,
    minimum_samples=100,
    minimum_class_samples=20,
    minimum_validation_samples=30,
    minimum_validation_class_samples=5,
    minimum_brier_lift=0.001,
    shrinkage_samples=1000,
    isotonic_minimum=1000,
):
    labels = _binary_labels(labels)
    probabilities = _probabilities(probabilities)
    if len(labels) != len(probabilities):
        raise ValueError("概率与标签长度不一致")
    playbooks = _calibration_strata(
        playbook_ids,
        len(labels),
        "打法",
    )
    route_values = _calibration_strata(
        routes,
        len(labels),
        "路径",
    )
    global_calibrator = fit_probability_calibrator(
        labels,
        probabilities,
        isotonic_minimum=isotonic_minimum,
    )
    global_adjusted = apply_probability_calibrator(
        probabilities,
        global_calibrator,
    )
    development_mask = None
    validation_mask = None
    development_global = None
    development_adjusted = None
    if dates is not None:
        date_values = _calibration_strata(
            dates,
            len(labels),
            "日期",
        )
        unique_dates = np.unique(date_values)
        validation_dates = max(1, int(np.ceil(len(unique_dates) * 0.3)))
        if len(unique_dates) - validation_dates >= 2:
            cutoff = unique_dates[-validation_dates]
            development_mask = date_values < cutoff
            validation_mask = ~development_mask
            if (
                len(set(labels[development_mask].tolist())) >= 2
                and len(set(labels[validation_mask].tolist())) >= 2
            ):
                development_global = fit_probability_calibrator(
                    labels[development_mask],
                    probabilities[development_mask],
                    isotonic_minimum=isotonic_minimum,
                )
                development_adjusted = apply_probability_calibrator(
                    probabilities,
                    development_global,
                )
            else:
                development_mask = None
                validation_mask = None
    groups = {}
    for level, keys in _stratified_group_keys(
        playbooks,
        route_values,
    ).items():
        level_groups = {}
        if dates is not None and development_mask is None:
            groups[level] = level_groups
            continue
        for key in np.unique(keys):
            if not key or "UNKNOWN" in key.upper():
                continue
            mask = keys == key
            sample_count = int(mask.sum())
            positive_count = int(labels[mask].sum())
            negative_count = sample_count - positive_count
            if (
                sample_count < int(minimum_samples)
                or min(positive_count, negative_count)
                < int(minimum_class_samples)
            ):
                continue
            validation_diagnostics = {}
            if development_mask is not None:
                fit_mask = mask & development_mask
                check_mask = mask & validation_mask
                fit_count = int(fit_mask.sum())
                check_count = int(check_mask.sum())
                fit_positive = int(labels[fit_mask].sum())
                check_positive = int(labels[check_mask].sum())
                if (
                    fit_count < int(minimum_samples)
                    or min(fit_positive, fit_count - fit_positive)
                    < int(minimum_class_samples)
                    or check_count < int(minimum_validation_samples)
                    or min(check_positive, check_count - check_positive)
                    < int(minimum_validation_class_samples)
                ):
                    continue
                fit_base_rate = float(
                    development_adjusted[fit_mask].mean()
                )
                fit_rate_delta = fit_positive / fit_count - fit_base_rate
                check_rate_delta = (
                    check_positive / check_count
                    - float(development_adjusted[check_mask].mean())
                )
                if fit_rate_delta * check_rate_delta <= 0:
                    continue
                candidate = _stratified_prior_config(
                    labels,
                    development_adjusted,
                    fit_mask,
                    shrinkage_samples,
                )
                global_check = development_adjusted[check_mask]
                local_check = _shift_probability_log_odds(
                    global_check,
                    candidate["logOddsOffset"],
                )
                global_metrics = binary_metrics(
                    labels[check_mask],
                    global_check,
                )
                local_metrics = binary_metrics(
                    labels[check_mask],
                    local_check,
                )
                if (
                    local_metrics["brier"]
                    > global_metrics["brier"]
                    - float(minimum_brier_lift)
                    or local_metrics["log_loss"]
                    > global_metrics["log_loss"]
                ):
                    continue
                validation_diagnostics = {
                    "validationSampleCount": check_count,
                    "validationBrierLift": round(
                        global_metrics["brier"]
                        - local_metrics["brier"],
                        12,
                    ),
                    "validationLogLossLift": round(
                        global_metrics["log_loss"]
                        - local_metrics["log_loss"],
                        12,
                    ),
                }
            level_groups[str(key)] = {
                **_stratified_prior_config(
                    labels,
                    global_adjusted,
                    mask,
                    shrinkage_samples,
                ),
                **validation_diagnostics,
            }
        groups[level] = level_groups
    return {
        "method": "stratified-playbook-route",
        "global": global_calibrator,
        "globalSampleCount": int(len(labels)),
        "minimumSamples": int(minimum_samples),
        "minimumClassSamples": int(minimum_class_samples),
        "minimumValidationSamples": int(minimum_validation_samples),
        "minimumValidationClassSamples":
            int(minimum_validation_class_samples),
        "minimumBrierLift": float(minimum_brier_lift),
        "shrinkageSamples": float(shrinkage_samples),
        "temporalValidation": development_mask is not None,
        "levels": ["playbookRoute", "playbook", "route"],
        "groups": groups,
    }


def probability_calibration_bucket(artifact, playbook, route):
    if str((artifact or {}).get("method") or "") != (
        "stratified-playbook-route"
    ):
        return {
            "level": "global",
            "key": "GLOBAL",
            "sampleCount": None,
        }
    playbook_key = str(playbook or "UNKNOWN")
    route_key = str(route or "UNKNOWN")
    keys = {
        "playbookRoute": f"{playbook_key}:{route_key}",
        "playbook": playbook_key,
        "route": route_key,
    }
    groups = artifact.get("groups") or {}
    for level in artifact.get("levels") or ():
        value = (groups.get(level) or {}).get(keys.get(level))
        if isinstance(value, dict):
            return {
                "level": level,
                "key": keys[level],
                "sampleCount": int(value.get("sampleCount") or 0),
            }
    return {
        "level": "global",
        "key": "GLOBAL",
        "sampleCount": int(artifact.get("globalSampleCount") or 0),
    }


def apply_probability_calibrator(
    probabilities,
    artifact,
    *,
    playbook_ids=None,
    routes=None,
):
    values = _probabilities(probabilities)
    method = str((artifact or {}).get("method") or "")
    if method == "stratified-playbook-route":
        adjusted = apply_probability_calibrator(
            values,
            artifact.get("global"),
        )
        if playbook_ids is None or routes is None:
            return adjusted
        playbooks = _calibration_strata(
            playbook_ids,
            len(values),
            "打法",
        )
        route_values = _calibration_strata(
            routes,
            len(values),
            "路径",
        )
        keys_by_level = _stratified_group_keys(
            playbooks,
            route_values,
        )
        unresolved = np.ones(len(values), dtype=bool)
        groups = artifact.get("groups") or {}
        for level in artifact.get("levels") or ():
            keys = keys_by_level.get(level)
            if keys is None:
                continue
            for key, config in (groups.get(level) or {}).items():
                mask = unresolved & (keys == key)
                if not mask.any():
                    continue
                offset = float(
                    (config or {}).get("logOddsOffset") or 0.0
                )
                adjusted[mask] = _shift_probability_log_odds(
                    adjusted[mask],
                    offset,
                )
                unresolved[mask] = False
        return np.clip(adjusted, 0, 1)
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
