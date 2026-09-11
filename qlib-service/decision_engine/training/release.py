"""Select and validate a component-level decision-model release."""

import argparse
import copy
import itertools
import json
import os
import shutil
import statistics
import time

import numpy as np

from ..contracts import FEATURE_NAMES
from .evaluation import (
    binary_metrics,
    block_bootstrap_lower_bound,
    ranking_metrics,
    regression_metrics,
)
from ..inference import (
    ensemble_prediction_arrays,
)
from ..registry import (
    ENSEMBLE_ARTIFACT_FILENAMES,
    ENSEMBLE_PREDICTION_CONTRACT_VERSION,
    load_release,
    validate_decision_metadata,
)
from time_splits import three_way_purged_split
from .trainer import load_decision_dataset


RELEASE_SCHEMA_VERSION = "opportunity-selective-release.v1"
COMPONENTS = (
    "fillProbability",
    "winProbability",
    "payoff",
    "tailRisk",
    "ranking",
)
COMPONENT_LABELS = {
    "fillProbability": "成交概率",
    "winProbability": "盈利概率",
    "payoff": "胜负幅度",
    "tailRisk": "尾部风险",
    "ranking": "横截面排序",
}
COMPONENT_HEADS = {
    "fillProbability": ("pFill",),
    "winProbability": ("pWinGivenFill",),
    "payoff": ("winPayoffR", "lossPayoffR"),
    "tailRisk": ("netRLower10",),
    "ranking": ("ranking",),
}
RELEASE_THRESHOLDS = {
    "component": {
        "probabilityF1Lift": 0.005,
        "probabilityRecallLift": 0.01,
        "probabilityBrierLift": 0.002,
        "probabilityAccuracyMaxDrop": 0.005,
        "probabilityBrierMaxIncrease": 0.002,
        "payoffMaeRelativeLift": 0.01,
        "payoffRankCorrelationLift": 0.01,
        "tailCoverageTarget": 0.9,
        "tailCoverageErrorLift": 0.005,
        "tailCoverageMinimum": 0.88,
        "rankingMeanNetRLift": 0.01,
        "rankingLowerBoundLift": 0.01,
        "rankingPrecisionLift": 0.01,
    },
    "overall": {
        "meanNetRMaxDrop": 0.01,
        "lowerBoundMinimum": 0.0,
        "lowerBoundMaxDrop": 0.02,
        "drawdownRelativeIncrease": 0.05,
        "drawdownAbsoluteIncrease": 0.05,
        "precisionMaxDrop": 0.02,
        "positiveCoverageMinimum": 0.02,
        "positiveCoverageMaxDrop": 0.05,
        "brierMaxIncrease": 0.01,
        "expectedNetRMaeRelativeIncrease": 0.05,
        "tailCoverageMinimum": 0.85,
        "tailCoverageMaxDrop": 0.02,
        "inferenceLatencyRelativeIncrease": 0.25,
        "inferenceLatencyAbsoluteIncreaseMsPer1000": 1.0,
    },
}


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if np.isfinite(numeric) else None


def _delta(candidate, champion):
    left = _number(candidate)
    right = _number(champion)
    return None if left is None or right is None else left - right


def _metric(value, *path):
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return _number(current)


def _compact_binary(labels, probabilities):
    result = binary_metrics(labels, probabilities)
    result.pop("reliability", None)
    return result


def evaluate_release(
    models,
    metadata,
    data,
    holdout_index,
    *,
    benchmark_repeats=5,
):
    """Evaluate one complete model combination on the same untouched holdout."""
    matrix = data["X"][holdout_index]
    started = time.perf_counter()
    predictions = ensemble_prediction_arrays(
        models,
        metadata,
        matrix,
        playbook_ids=data["playbook_ids"][holdout_index],
        routes=data["routes"][holdout_index],
    )
    initial_duration = (time.perf_counter() - started) * 1000
    repeats = max(0, int(benchmark_repeats))
    durations = [initial_duration] if repeats == 0 else []
    for _ in range(repeats):
        started = time.perf_counter()
        ensemble_prediction_arrays(
            models,
            metadata,
            matrix,
            playbook_ids=data["playbook_ids"][holdout_index],
            routes=data["routes"][holdout_index],
        )
        durations.append((time.perf_counter() - started) * 1000)

    fill_labels = data["y_fill"][holdout_index].astype(np.int8)
    win_mask = np.isfinite(data["y_win"][holdout_index])
    net_r_mask = np.isfinite(data["y_net_r"][holdout_index])
    actual_net_r = np.nan_to_num(
        data["y_net_r"][holdout_index],
        nan=0.0,
    )
    ranking = ranking_metrics(
        actual_net_r > 0,
        actual_net_r,
        predictions["rankingScore"],
        data["dates"][holdout_index],
        top_k=5,
        group_ids=data["codes"][holdout_index],
        eligible_mask=predictions["expectedNetR"] > 0,
    )
    lower_bound = block_bootstrap_lower_bound(
        ranking["daily_net_r"],
        samples=2000,
        random_state=42,
    )
    ranking.pop("daily_net_r", None)
    q10_coverage = (
        float(np.mean(
            data["y_net_r"][holdout_index][net_r_mask]
            >= predictions["netRLowerBound"][net_r_mask]
        ))
        if net_r_mask.any()
        else None
    )
    median_ms = statistics.median(durations)
    return {
        "samples": int(len(holdout_index)),
        "pFill": _compact_binary(
            fill_labels,
            predictions["pFill"],
        ),
        "pWinGivenFill": _compact_binary(
            data["y_win"][holdout_index][win_mask].astype(np.int8),
            predictions["pWinGivenFill"][win_mask],
        ),
        "expectedNetR": regression_metrics(
            data["y_net_r"][holdout_index][net_r_mask],
            predictions["expectedNetR"][net_r_mask],
        ),
        "tailRisk": {
            "q10Coverage": (
                round(q10_coverage, 6)
                if q10_coverage is not None
                else None
            ),
        },
        "business": {
            **ranking,
            "netRLowerBound": lower_bound,
            "positiveExpectedCoverage": round(float(np.mean(
                predictions["expectedNetR"] > 0
            )), 6),
        },
        "inference": {
            "medianMs": round(median_ms, 6),
            "msPer1000": round(
                median_ms * 1000 / max(1, len(matrix)),
                6,
            ),
            "repeats": repeats,
        },
    }


def component_decision(component, champion, challenger):
    """Return whether one challenger component has a measurable improvement."""
    if component not in COMPONENTS:
        raise ValueError("未知决策模型组成部分")
    thresholds = RELEASE_THRESHOLDS["component"]
    blockers = []
    improvements = []
    comparisons = []

    def compare(label, candidate, baseline, *, lower_is_better=False):
        change = _delta(candidate, baseline)
        comparisons.append({
            "label": label,
            "challenger": _number(candidate),
            "champion": _number(baseline),
            "delta": (
                round(change, 6)
                if change is not None
                else None
            ),
            "lowerIsBetter": lower_is_better,
        })
        return change

    if component in ("fillProbability", "winProbability"):
        key = (
            "pFill"
            if component == "fillProbability"
            else "pWinGivenFill"
        )
        f1 = compare(
            "F1",
            _metric(challenger, key, "f1"),
            _metric(champion, key, "f1"),
        )
        recall = compare(
            "召回率",
            _metric(challenger, key, "recall"),
            _metric(champion, key, "recall"),
        )
        accuracy = compare(
            "准确率",
            _metric(challenger, key, "accuracy"),
            _metric(champion, key, "accuracy"),
        )
        brier = compare(
            "Brier",
            _metric(challenger, key, "brier"),
            _metric(champion, key, "brier"),
            lower_is_better=True,
        )
        if accuracy is None or accuracy < -thresholds[
            "probabilityAccuracyMaxDrop"
        ]:
            blockers.append("准确率下降超过0.5个百分点")
        if brier is None or brier > thresholds[
            "probabilityBrierMaxIncrease"
        ]:
            blockers.append("Brier恶化超过0.002")
        if (
            f1 is not None
            and f1 >= thresholds["probabilityF1Lift"]
        ):
            improvements.append("F1至少提升0.5个百分点")
        if (
            recall is not None
            and recall >= thresholds["probabilityRecallLift"]
        ):
            improvements.append("召回率至少提升1个百分点")
        if (
            brier is not None
            and brier <= -thresholds["probabilityBrierLift"]
        ):
            improvements.append("Brier至少改善0.002")
    elif component == "payoff":
        candidate_mae = _metric(
            challenger,
            "expectedNetR",
            "mae",
        )
        champion_mae = _metric(
            champion,
            "expectedNetR",
            "mae",
        )
        mae = compare(
            "净R MAE",
            candidate_mae,
            champion_mae,
            lower_is_better=True,
        )
        rank = compare(
            "净R秩相关",
            _metric(
                challenger,
                "expectedNetR",
                "rank_correlation",
            ),
            _metric(
                champion,
                "expectedNetR",
                "rank_correlation",
            ),
        )
        relative_lift = (
            -mae / champion_mae
            if mae is not None and champion_mae and champion_mae > 0
            else None
        )
        if (
            relative_lift is not None
            and relative_lift >= thresholds["payoffMaeRelativeLift"]
        ):
            improvements.append("净R MAE至少改善1%")
        if (
            rank is not None
            and rank >= thresholds["payoffRankCorrelationLift"]
        ):
            improvements.append("净R秩相关至少提升0.01")
    elif component == "tailRisk":
        target = thresholds["tailCoverageTarget"]
        candidate_coverage = _metric(
            challenger,
            "tailRisk",
            "q10Coverage",
        )
        champion_coverage = _metric(
            champion,
            "tailRisk",
            "q10Coverage",
        )
        compare(
            "Q10覆盖率",
            candidate_coverage,
            champion_coverage,
        )
        if (
            candidate_coverage is None
            or candidate_coverage < thresholds["tailCoverageMinimum"]
        ):
            blockers.append("Q10覆盖率低于88%")
        if (
            candidate_coverage is not None
            and champion_coverage is not None
            and (
                abs(champion_coverage - target)
                - abs(candidate_coverage - target)
            ) >= thresholds["tailCoverageErrorLift"]
        ):
            improvements.append("Q10覆盖率向90%目标改善至少0.5个百分点")
    else:
        mean_net_r = compare(
            "Top5费后净R",
            _metric(
                challenger,
                "business",
                "mean_net_r_at_5",
            ),
            _metric(champion, "business", "mean_net_r_at_5"),
        )
        lower_bound = compare(
            "Top5净R下置信界",
            _metric(challenger, "business", "netRLowerBound"),
            _metric(champion, "business", "netRLowerBound"),
        )
        precision = compare(
            "Top5正净R命中率",
            _metric(challenger, "business", "precision_at_5"),
            _metric(champion, "business", "precision_at_5"),
        )
        if (
            mean_net_r is not None
            and mean_net_r >= thresholds["rankingMeanNetRLift"]
        ):
            improvements.append("Top5费后净R至少提升0.01R")
        if (
            lower_bound is not None
            and lower_bound >= thresholds["rankingLowerBoundLift"]
        ):
            improvements.append("Top5净R下置信界至少提升0.01R")
        if (
            precision is not None
            and precision >= thresholds["rankingPrecisionLift"]
        ):
            improvements.append("Top5命中率至少提升1个百分点")

    status = (
        "BLOCKED"
        if blockers
        else "IMPROVED"
        if improvements
        else "UNCHANGED"
    )
    return {
        "component": component,
        "label": COMPONENT_LABELS[component],
        "status": status,
        "improved": status == "IMPROVED",
        "improvements": improvements,
        "blockers": blockers,
        "metrics": comparisons,
    }


def compatibility_gate(champion, candidate):
    """Apply explicit whole-model regression limits to a mixed release."""
    thresholds = RELEASE_THRESHOLDS["overall"]
    blockers = []

    def require_delta(path, minimum, label):
        change = _delta(
            _metric(candidate, *path),
            _metric(champion, *path),
        )
        if change is None:
            blockers.append(f"{label}无法与生产版本比较")
        elif change < minimum:
            blockers.append(f"{label}下降超过允许阈值")

    require_delta(
        ("business", "mean_net_r_at_5"),
        -thresholds["meanNetRMaxDrop"],
        "Top5费后净R",
    )
    lower = _metric(candidate, "business", "netRLowerBound")
    if lower is None or lower <= thresholds["lowerBoundMinimum"]:
        blockers.append("Top5净R下置信界必须大于0")
    require_delta(
        ("business", "netRLowerBound"),
        -thresholds["lowerBoundMaxDrop"],
        "Top5净R下置信界",
    )
    require_delta(
        ("business", "precision_at_5"),
        -thresholds["precisionMaxDrop"],
        "Top5正净R命中率",
    )
    require_delta(
        ("business", "positiveExpectedCoverage"),
        -thresholds["positiveCoverageMaxDrop"],
        "正期望覆盖率",
    )
    coverage = _metric(
        candidate,
        "business",
        "positiveExpectedCoverage",
    )
    if (
        coverage is None
        or coverage < thresholds["positiveCoverageMinimum"]
    ):
        blockers.append("正期望覆盖率低于2%")

    drawdown = _metric(
        candidate,
        "business",
        "max_drawdown_r_at_5",
    )
    champion_drawdown = _metric(
        champion,
        "business",
        "max_drawdown_r_at_5",
    )
    if drawdown is None or champion_drawdown is None:
        blockers.append("Top5最大回撤无法与生产版本比较")
    else:
        allowed = champion_drawdown + max(
            thresholds["drawdownAbsoluteIncrease"],
            abs(champion_drawdown)
            * thresholds["drawdownRelativeIncrease"],
        )
        if drawdown > allowed + 1e-12:
            blockers.append("Top5最大回撤恶化超过5%或0.05R")

    for key, label in (
        ("pFill", "成交概率Brier"),
        ("pWinGivenFill", "盈利概率Brier"),
    ):
        change = _delta(
            _metric(candidate, key, "brier"),
            _metric(champion, key, "brier"),
        )
        if change is None:
            blockers.append(f"{label}无法与生产版本比较")
        elif change > thresholds["brierMaxIncrease"]:
            blockers.append(f"{label}恶化超过0.01")

    candidate_mae = _metric(candidate, "expectedNetR", "mae")
    champion_mae = _metric(champion, "expectedNetR", "mae")
    if candidate_mae is None or champion_mae is None:
        blockers.append("净R MAE无法与生产版本比较")
    elif candidate_mae > champion_mae * (
        1 + thresholds["expectedNetRMaeRelativeIncrease"]
    ):
        blockers.append("净R MAE恶化超过5%")

    candidate_tail = _metric(candidate, "tailRisk", "q10Coverage")
    champion_tail = _metric(champion, "tailRisk", "q10Coverage")
    if (
        candidate_tail is None
        or candidate_tail < thresholds["tailCoverageMinimum"]
    ):
        blockers.append("Q10覆盖率低于85%")
    elif (
        champion_tail is None
        or candidate_tail
        < champion_tail - thresholds["tailCoverageMaxDrop"]
    ):
        blockers.append("Q10覆盖率下降超过2个百分点")

    latency = _metric(candidate, "inference", "msPer1000")
    champion_latency = _metric(
        champion,
        "inference",
        "msPer1000",
    )
    if latency is None or champion_latency is None:
        blockers.append("推理速度无法与生产版本比较")
    else:
        allowed = max(
            champion_latency * (
                1 + thresholds["inferenceLatencyRelativeIncrease"]
            ),
            champion_latency
            + thresholds["inferenceLatencyAbsoluteIncreaseMsPer1000"],
        )
        if latency > allowed:
            blockers.append("千条推理耗时增加超过25%且超过1毫秒")
    return {
        "passed": not blockers,
        "blockers": blockers,
    }


def _copy_member_config(champion, challenger, components):
    value = copy.deepcopy(champion)
    selected = set(components)
    if "fillProbability" in selected:
        value.setdefault("calibration", {})["pFill"] = copy.deepcopy(
            challenger["calibration"]["pFill"]
        )
    if "winProbability" in selected:
        value.setdefault("calibration", {})[
            "pWinGivenFill"
        ] = copy.deepcopy(
            challenger["calibration"]["pWinGivenFill"]
        )
    if "tailRisk" in selected:
        value["q10CalibrationOffset"] = challenger[
            "q10CalibrationOffset"
        ]
    if "ranking" in selected:
        for key in (
            "rankingCalibration",
            "rankValueCalibration",
            "rankingRelevance",
        ):
            value[key] = copy.deepcopy(challenger[key])
    return value


def compose_release(
    champion_models,
    champion_metadata,
    challenger_models,
    challenger_metadata,
    components,
):
    selected = tuple(sorted(set(components), key=COMPONENTS.index))
    if not selected:
        raise ValueError("发布组合至少需要一个晋级部分")
    for metadata in (champion_metadata, challenger_metadata):
        validate_decision_metadata(metadata)
        if (
            metadata.get("predictionContract")
            != ENSEMBLE_PREDICTION_CONTRACT_VERSION
        ):
            raise ValueError("成员级晋级只支持三种子决策集成")
    if (
        champion_metadata.get("featureSchemaVersion")
        != challenger_metadata.get("featureSchemaVersion")
        or tuple(champion_metadata.get("featureNames") or ())
        != tuple(challenger_metadata.get("featureNames") or ())
    ):
        raise ValueError("生产版本与挑战者特征合同不兼容")

    champion_by_seed = {
        int(config["seed"]): (model, config)
        for model, config in zip(
            champion_models["ensemble"],
            champion_metadata["ensembleMembers"],
        )
    }
    challenger_by_seed = {
        int(config["seed"]): (model, config)
        for model, config in zip(
            challenger_models["ensemble"],
            challenger_metadata["ensembleMembers"],
        )
    }
    if set(champion_by_seed) != set(challenger_by_seed):
        raise ValueError("生产版本与挑战者集成种子不兼容")

    heads = {
        head
        for component in selected
        for head in COMPONENT_HEADS[component]
    }
    models = {"ensemble": []}
    configs = []
    for champion_config in champion_metadata["ensembleMembers"]:
        seed = int(champion_config["seed"])
        champion_member, _ = champion_by_seed[seed]
        challenger_member, challenger_config = challenger_by_seed[seed]
        models["ensemble"].append({
            head: (
                challenger_member[head]
                if head in heads
                else champion_member[head]
            )
            for head in champion_member
        })
        configs.append(_copy_member_config(
            champion_config,
            challenger_config,
            selected,
        ))

    metadata = copy.deepcopy(champion_metadata)
    metadata["ensembleMembers"] = configs
    metadata["trainedAt"] = challenger_metadata.get("trainedAt")
    metadata["split"] = copy.deepcopy(
        challenger_metadata.get("split")
    )
    metadata["calibration"] = copy.deepcopy(
        champion_metadata.get("calibration") or {}
    )
    if "fillProbability" in selected:
        metadata["calibration"]["pFillSampleCount"] = (
            (challenger_metadata.get("calibration") or {}).get(
                "pFillSampleCount"
            )
        )
    if "winProbability" in selected:
        metadata["calibration"]["pWinGivenFillSampleCount"] = (
            (challenger_metadata.get("calibration") or {}).get(
                "pWinGivenFillSampleCount"
            )
        )
    if "ranking" in selected:
        for key in (
            "rankBlendWeight",
            "rankBlendTrials",
        ):
            metadata[key] = copy.deepcopy(
                challenger_metadata.get(key)
            )
    if "tailRisk" in selected:
        metadata.setdefault("risk", {})["q10Coverage"] = (
            (challenger_metadata.get("risk") or {}).get(
                "q10Coverage"
            )
        )
    if set(selected) == set(COMPONENTS):
        for key in ("ood", "labelClip"):
            metadata[key] = copy.deepcopy(
                challenger_metadata.get(key)
            )
        metadata["risk"] = copy.deepcopy(
            challenger_metadata.get("risk") or {}
        )
    return models, metadata


def _compose_artifact(
    champion_artifact,
    challenger_artifact,
    champion_metadata,
    components,
):
    selected = set(components)
    heads = {
        head
        for component in selected
        for head in COMPONENT_HEADS[component]
    }
    challenger_members = {
        int(member["seed"]): member
        for member in challenger_artifact["members"]
    }
    members = []
    for member in champion_artifact["members"]:
        seed = int(member["seed"])
        challenger = challenger_members[seed]
        members.append({
            "seed": seed,
            "models": {
                head: copy.deepcopy(
                    challenger["models"][head]
                    if head in heads
                    else payload
                )
                for head, payload in member["models"].items()
            },
        })
    return {
        "schemaVersion": champion_artifact["schemaVersion"],
        "featureSchemaVersion":
            champion_metadata["featureSchemaVersion"],
        "members": members,
    }


def _load_bundle(directory):
    metadata_path = os.path.join(
        directory,
        ENSEMBLE_ARTIFACT_FILENAMES["meta"],
    )
    artifact_path = os.path.join(
        directory,
        ENSEMBLE_ARTIFACT_FILENAMES["ensemble"],
    )
    with open(metadata_path, encoding="utf-8") as handle:
        metadata = validate_decision_metadata(json.load(handle))
    if (
        metadata.get("predictionContract")
        != ENSEMBLE_PREDICTION_CONTRACT_VERSION
    ):
        raise ValueError("当前生产模型不是可选择晋级的三种子集成")
    with open(artifact_path, encoding="utf-8") as handle:
        artifact = json.load(handle)
    models, loaded_metadata = load_release(
        {"ensemble": artifact_path},
        metadata_path,
    )
    return models, loaded_metadata, artifact


def _write_json(path, value):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    temporary = path + ".part"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(
            value,
            handle,
            ensure_ascii=False,
            allow_nan=False,
            indent=2,
        )
    os.replace(temporary, path)


def _candidate_score(evaluation):
    business = evaluation["business"]
    mean_net_r = _number(business.get("mean_net_r_at_5"))
    lower_bound = _number(business.get("netRLowerBound"))
    precision = _number(business.get("precision_at_5"))
    drawdown = _number(business.get("max_drawdown_r_at_5"))
    return (
        mean_net_r if mean_net_r is not None else -float("inf"),
        lower_bound if lower_bound is not None else -float("inf"),
        precision if precision is not None else -float("inf"),
        -drawdown if drawdown is not None else -float("inf"),
    )


def _project_dataset_for_metadata(data, metadata):
    source_names = tuple(
        np.asarray(
            data.get("feature_names", FEATURE_NAMES),
        ).astype(str).tolist()
    )
    target_names = tuple(metadata.get("featureNames") or ())
    indexes = []
    for name in target_names:
        if name not in source_names:
            raise ValueError(
                f"评测数据缺少模型特征: {name}"
            )
        indexes.append(source_names.index(name))
    return {
        **data,
        "X": np.asarray(data["X"])[:, indexes],
        "feature_names": np.asarray(target_names, dtype="<U80"),
    }


def select_release(
    dataset_path,
    champion_directory,
    challenger_directory,
    output_directory,
    *,
    decision_output,
):
    data = load_decision_dataset(dataset_path)
    _, _, holdout, split = three_way_purged_split(
        data["dates"],
        calibration_fraction=0.15,
        holdout_fraction=0.15,
        purge_dates=5,
    )
    (
        champion_models,
        champion_metadata,
        champion_artifact,
    ) = _load_bundle(champion_directory)
    (
        challenger_models,
        challenger_metadata,
        challenger_artifact,
    ) = _load_bundle(challenger_directory)
    champion_data = _project_dataset_for_metadata(
        data,
        champion_metadata,
    )
    challenger_data = _project_dataset_for_metadata(
        data,
        challenger_metadata,
    )
    champion_evaluation = evaluate_release(
        champion_models,
        champion_metadata,
        champion_data,
        holdout,
    )
    challenger_evaluation = evaluate_release(
        challenger_models,
        challenger_metadata,
        challenger_data,
        holdout,
    )
    schema_changed = (
        champion_metadata.get("featureSchemaVersion")
        != challenger_metadata.get("featureSchemaVersion")
        or tuple(champion_metadata.get("featureNames") or ())
        != tuple(challenger_metadata.get("featureNames") or ())
    )
    component_decisions = [
        component_decision(
            component,
            champion_evaluation,
            challenger_evaluation,
        )
        for component in COMPONENTS
    ]
    candidates = []
    if schema_changed:
        compatibility = compatibility_gate(
            champion_evaluation,
            challenger_evaluation,
        )
        if not any(item["improved"] for item in component_decisions):
            compatibility["passed"] = False
            compatibility["blockers"].append(
                "新特征合同没有任何模型组成部分达到独立改善门槛"
            )
        candidates.append({
            "components": list(COMPONENTS),
            "evaluation": challenger_evaluation,
            "compatibility": compatibility,
            "fullBundle": True,
        })
    else:
        improved = [
            item["component"]
            for item in component_decisions
            if item["improved"]
        ]
        individual_evaluations = {}
        for component in improved:
            models, metadata = compose_release(
                champion_models,
                champion_metadata,
                challenger_models,
                challenger_metadata,
                (component,),
            )
            individual_evaluations[component] = evaluate_release(
                models,
                metadata,
                data,
                holdout,
                benchmark_repeats=0,
            )
        combinations = (
            itertools.combinations(improved, size)
            for size in range(1, len(improved) + 1)
        )
        for group in combinations:
            for components in group:
                if len(components) == 1:
                    evaluation = individual_evaluations[components[0]]
                else:
                    models, metadata = compose_release(
                        champion_models,
                        champion_metadata,
                        challenger_models,
                        challenger_metadata,
                        components,
                    )
                    evaluation = evaluate_release(
                        models,
                        metadata,
                        data,
                        holdout,
                        benchmark_repeats=0,
                    )
                compatibility = compatibility_gate(
                    champion_evaluation,
                    evaluation,
                )
                candidates.append({
                    "components": list(components),
                    "evaluation": evaluation,
                    "compatibility": compatibility,
                    "fullBundle": False,
                })
    accepted = [
        item
        for item in candidates
        if item["compatibility"]["passed"]
    ]
    selected = max(
        accepted,
        key=lambda item: (
            _candidate_score(item["evaluation"]),
            -len(item["components"]),
        ),
        default=None,
    )
    final_validation_blockers = []
    if selected:
        if selected.get("fullBundle"):
            models = challenger_models
            metadata = copy.deepcopy(challenger_metadata)
            evaluation_data = challenger_data
        else:
            models, metadata = compose_release(
                champion_models,
                champion_metadata,
                challenger_models,
                challenger_metadata,
                selected["components"],
            )
            evaluation_data = data
        selected["evaluation"] = evaluate_release(
            models,
            metadata,
            evaluation_data,
            holdout,
        )
        selected["compatibility"] = compatibility_gate(
            champion_evaluation,
            selected["evaluation"],
        )
        if not selected["compatibility"]["passed"]:
            final_validation_blockers = selected[
                "compatibility"
            ]["blockers"]
            selected = None
    action = "PUBLISH" if selected else "KEEP_CURRENT"
    selected_components = (
        selected["components"]
        if selected
        else []
    )
    release_mode = (
        "FULL"
        if set(selected_components) == set(COMPONENTS)
        else "PARTIAL"
        if selected_components
        else "NONE"
    )
    selected_version = None
    if selected:
        suffix = ".production" if release_mode == "FULL" else ".selective"
        selected_version = (
            str(challenger_metadata["modelVersion"]) + suffix
        )
        if len(selected_version) > 96:
            raise ValueError("选择性发布版本号过长")
    decision = {
        "schemaVersion": RELEASE_SCHEMA_VERSION,
        "generatedAt": int(time.time() * 1000),
        "action": action,
        "eligible": bool(selected),
        "reason": (
            "已选择通过成员改进与整体兼容性验证的最佳组合"
            if selected
            else "没有组成部分同时满足单项改善和整体风险阈值"
        ),
        "championVersion": champion_metadata["modelVersion"],
        "challengerVersion": challenger_metadata["modelVersion"],
        "selectedVersion": selected_version,
        "releaseMode": release_mode,
        "promotedComponents": selected_components,
        "componentDecisions": component_decisions,
        "thresholds": RELEASE_THRESHOLDS,
        "holdout": {
            "samples": int(len(holdout)),
            "startDate": str(data["dates"][holdout][0]),
            "endDate": str(data["dates"][holdout][-1]),
            "split": split,
        },
        "evaluation": {
            "champion": champion_evaluation,
            "challenger": challenger_evaluation,
            "selected": (
                selected["evaluation"]
                if selected
                else champion_evaluation
            ),
        },
        "compatibility": (
            selected["compatibility"]
            if selected
            else {
                "passed": False,
                "blockers": list(dict.fromkeys(
                    [
                        *final_validation_blockers,
                        *(
                            blocker
                            for item in candidates
                            for blocker
                            in item["compatibility"]["blockers"]
                        ),
                    ]
                ))[:12],
            }
        ),
        "combinationsEvaluated": len(candidates),
        "compatibleCombinations": len(accepted),
    }
    if selected:
        if selected.get("fullBundle"):
            metadata = copy.deepcopy(challenger_metadata)
            artifact = copy.deepcopy(challenger_artifact)
        else:
            models, metadata = compose_release(
                champion_models,
                champion_metadata,
                challenger_models,
                challenger_metadata,
                selected_components,
            )
            del models
            artifact = _compose_artifact(
                champion_artifact,
                challenger_artifact,
                champion_metadata,
                selected_components,
            )
        metadata.update({
            "modelVersion": selected_version,
            "shadowOnly": False,
            "productionEligible": True,
            "usagePolicy": "DIRECT",
            "baselineSelected": True,
            "releaseManagement": {
                "schemaVersion": RELEASE_SCHEMA_VERSION,
                "parentModelVersion":
                    champion_metadata["modelVersion"],
                "challengerModelVersion":
                    challenger_metadata["modelVersion"],
                "releaseMode": release_mode,
                "promotedComponents": selected_components,
                "generatedAt": decision["generatedAt"],
            },
            "releaseEvaluation": selected["evaluation"],
        })
        validate_decision_metadata(metadata)
        if os.path.exists(output_directory):
            shutil.rmtree(output_directory)
        os.makedirs(output_directory, exist_ok=True)
        _write_json(
            os.path.join(
                output_directory,
                ENSEMBLE_ARTIFACT_FILENAMES["ensemble"],
            ),
            artifact,
        )
        _write_json(
            os.path.join(
                output_directory,
                ENSEMBLE_ARTIFACT_FILENAMES["meta"],
            ),
            metadata,
        )
    _write_json(decision_output, decision)
    return decision


def main():
    parser = argparse.ArgumentParser(
        description="按组成部分比较并选择生产决策模型组合",
    )
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--champion", required=True)
    parser.add_argument("--challenger", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--decision-output", required=True)
    args = parser.parse_args()
    decision = select_release(
        args.dataset,
        args.champion,
        args.challenger,
        args.output,
        decision_output=args.decision_output,
    )
    print(json.dumps({
        "action": decision["action"],
        "championVersion": decision["championVersion"],
        "challengerVersion": decision["challengerVersion"],
        "selectedVersion": decision["selectedVersion"],
        "promotedComponents": decision["promotedComponents"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
