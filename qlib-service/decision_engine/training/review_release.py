"""Compare a trigger-review challenger with the active production model."""

from __future__ import annotations

import argparse
import json
import math
import os
import time

import numpy as np

from ..review_registry import (
    REVIEW_ARTIFACT_FILENAMES,
    load_review_release,
)
from ..heads.review_contract import FEATURE_SCHEMA_VERSION
from ..heads.review_contract_v4 import FEATURE_SCHEMA_VERSION_V4
from .review_bakeoff import load_dataset
from .review_dataset import is_main_board_code
from .review_ensemble import (
    MINIMUM_CONFIRMATION_TRADING_DAYS,
    _evaluate,
    _evaluate_fill,
    _member_predictions,
    _policy_metrics,
    _value_head_predictions,
)
from time_splits import four_way_interval_split


REVIEW_RELEASE_SCHEMA_VERSION = "review-champion-challenger.v1"
# 冠亚门禁允许的特征合同：v3 生产 + v4 Alpha158 连续特征挑战者。
# 只有冠亚特征合同一致时才真正同窗评估；不一致直接门禁拦截并 KEEP_CURRENT，
# 生产 v3 清单绝不被异构挑战者覆盖。
_SCHEMA_VERSION_TO_KEY = {
    FEATURE_SCHEMA_VERSION: "v3",
    FEATURE_SCHEMA_VERSION_V4: "v4",
}


def _schema_key(version):
    return _SCHEMA_VERSION_TO_KEY.get(str(version or ""), "v3")


REVIEW_RELEASE_THRESHOLDS = {
    "freshEvidence": {
        "minimumDates": 10,
        "minimumConditionalSamples": 200,
        "minimumFillSamples": 500,
        "minimumOpportunitySamples": 500,
    },
    "regression": {
        "meanNetRMaxDrop": 0.01,
        "lowerBoundMaxDrop": 0.01,
        "precisionMaxDrop": 0.02,
        "drawdownRelativeIncrease": 0.05,
        "drawdownAbsoluteIncreaseR": 0.05,
        "brierMaxIncrease": 0.01,
        "netRMaeRelativeIncrease": 0.05,
        "q10CoverageMinimum": 0.85,
        "q10CoverageMaxDrop": 0.02,
        "selectedCoverageMinimumRatio": 0.5,
        "minimumAnnualizedTrades": 80.0,
        "maximumAccountDrawdownPctAtRisk07Top5": 10.0,
    },
    "improvement": {
        "meanNetRMinimumLift": 0.01,
        "lowerBoundMinimumLift": 0.005,
        "precisionMinimumLift": 0.01,
        "drawdownMinimumReductionR": 0.05,
    },
}


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _metric(value, *path):
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return _number(current)


def _delta(challenger, champion, *path):
    candidate = _metric(challenger, *path)
    baseline = _metric(champion, *path)
    if candidate is None or baseline is None:
        return None
    return candidate - baseline


def _compact_date(value):
    return str(value or "").replace("-", "")[:8]


def _write_json(path, value):
    destination = os.path.abspath(path)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    temporary = destination + ".part"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(
            value,
            handle,
            ensure_ascii=False,
            allow_nan=False,
            indent=2,
        )
    os.replace(temporary, destination)


def _detect_bundle_schema(metadata_path):
    # 只窥探 featureSchemaVersion 以决定用哪套合同做严格校验加载；
    # 未知版本按 v3 处理，交由 load_review_release 的严格校验兜底报错。
    try:
        with open(metadata_path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError):
        return FEATURE_SCHEMA_VERSION
    version = str((raw or {}).get("featureSchemaVersion") or "")
    return version if version in _SCHEMA_VERSION_TO_KEY else FEATURE_SCHEMA_VERSION


def _load_bundle(directory):
    artifact_path = os.path.join(
        directory,
        REVIEW_ARTIFACT_FILENAMES["ensemble"],
    )
    metadata_path = os.path.join(
        directory,
        REVIEW_ARTIFACT_FILENAMES["meta"],
    )
    models, metadata = load_review_release(
        artifact_path,
        metadata_path,
        feature_schema=_detect_bundle_schema(metadata_path),
    )
    members = [
        {
            "config": config,
            "models": model,
        }
        for model, config in zip(
            models["ensemble"],
            metadata["ensembleMembers"],
        )
    ]
    return members, metadata


def _confirmation_partitions(dataset):
    minimum_confirmation_dates = (
        MINIMUM_CONFIRMATION_TRADING_DAYS
        if dataset.get("feature_schema") == "v4"
        else 0
    )
    development, _, _, confirmation, _ = four_way_interval_split(
        dataset["dates"],
        dataset["label_start_ms"],
        dataset["label_end_ms"],
        dataset["event_group_ids"],
        calibration_fraction=0.15,
        selection_fraction=0.15,
        confirmation_fraction=0.15,
        embargo_dates=5,
        minimum_confirmation_dates=minimum_confirmation_dates,
    )
    fill_development, _, _, fill_confirmation, _ = (
        four_way_interval_split(
            dataset["dates_all"],
            dataset["label_start_ms_all"],
            dataset["label_end_ms_all"],
            dataset["event_group_ids_all"],
            calibration_fraction=0.15,
            selection_fraction=0.15,
            confirmation_fraction=0.15,
            embargo_dates=5,
            minimum_confirmation_dates=minimum_confirmation_dates,
        )
    )
    _, _, _, opportunity_confirmation, _ = four_way_interval_split(
        dataset["dates_opportunity"],
        dataset["label_start_ms_opportunity"],
        dataset["label_end_ms_opportunity"],
        dataset["event_group_ids_opportunity"],
        calibration_fraction=0.15,
        selection_fraction=0.15,
        confirmation_fraction=0.15,
        embargo_dates=5,
        minimum_confirmation_dates=minimum_confirmation_dates,
    )
    return {
        "development": development,
        "confirmation": confirmation,
        "fillDevelopment": fill_development,
        "fillConfirmation": fill_confirmation,
        "opportunityConfirmation": opportunity_confirmation,
    }


def _after_cutoff(indices, dates, cutoff):
    values = np.asarray(dates).astype(str)
    return np.asarray([
        index
        for index in np.asarray(indices, dtype=np.int64)
        if _compact_date(values[index]) > cutoff
    ], dtype=np.int64)


def fresh_confirmation_partitions(dataset, champion_metadata):
    cutoff = _compact_date(
        (champion_metadata.get("validation") or {}).get(
            "confirmationEndDate"
        )
    )
    if len(cutoff) != 8 or not cutoff.isdigit():
        raise ValueError("现役复核模型缺少最终确认截止日期")
    partitions = _confirmation_partitions(dataset)
    confirmation = _after_cutoff(
        partitions["confirmation"],
        dataset["dates"],
        cutoff,
    )
    fill_confirmation = _after_cutoff(
        partitions["fillConfirmation"],
        dataset["dates_all"],
        cutoff,
    )
    opportunity_confirmation = _after_cutoff(
        partitions["opportunityConfirmation"],
        dataset["dates_opportunity"],
        cutoff,
    )
    dates = sorted(set(
        np.asarray(dataset["dates_opportunity"])[
            opportunity_confirmation
        ].astype(str).tolist()
    ))
    return {
        **partitions,
        "confirmation": confirmation,
        "fillConfirmation": fill_confirmation,
        "opportunityConfirmation": opportunity_confirmation,
        "evidence": {
            "championCutoffDate": cutoff,
            "startDate": dates[0] if dates else None,
            "endDate": dates[-1] if dates else None,
            "dates": len(dates),
            "conditionalSamples": int(len(confirmation)),
            "fillSamples": int(len(fill_confirmation)),
            "opportunitySamples": int(len(opportunity_confirmation)),
        },
    }


def evaluate_review_release(dataset, partitions, members, metadata):
    conditional = partitions["confirmation"]
    fill = partitions["fillConfirmation"]
    opportunity = partitions["opportunityConfirmation"]
    conditional_predictions = _value_head_predictions(
        [
            _member_predictions(member, dataset["X"][conditional])
            for member in members
        ],
        metadata["valueHead"],
        metadata["ensembleQ10CalibrationOffset"],
    )
    conditional_metrics, _ = _evaluate(
        dataset,
        partitions["development"],
        conditional,
        conditional_predictions,
    )
    fill_metrics, _ = _evaluate_fill(
        dataset,
        partitions["fillDevelopment"],
        fill,
        [
            _member_predictions(member, dataset["X_all"][fill])
            for member in members
        ],
    )
    opportunity_metrics = _policy_metrics(
        dataset,
        opportunity,
        _value_head_predictions(
            [
                _member_predictions(
                    member,
                    dataset["X_opportunity"][opportunity],
                )
                for member in members
            ],
            metadata["valueHead"],
            metadata["ensembleQ10CalibrationOffset"],
        ),
        metadata["selectionPolicy"],
    )
    return {
        "conditional": conditional_metrics,
        "fill": fill_metrics,
        "opportunity": opportunity_metrics,
    }


def fresh_evidence_blockers(fresh_evidence):
    blockers = []
    fresh = REVIEW_RELEASE_THRESHOLDS["freshEvidence"]
    for field, threshold, label in (
        ("dates", "minimumDates", "新增交易日"),
        (
            "conditionalSamples",
            "minimumConditionalSamples",
            "新增条件收益样本",
        ),
        ("fillSamples", "minimumFillSamples", "新增成交样本"),
        (
            "opportunitySamples",
            "minimumOpportunitySamples",
            "新增机会样本",
        ),
    ):
        minimum = fresh[threshold]
        if int(fresh_evidence.get(field) or 0) < minimum:
            blockers.append(f"{label}少于{minimum}")
    return blockers


def review_promotion_gate(
    champion,
    challenger,
    fresh_evidence,
):
    thresholds = REVIEW_RELEASE_THRESHOLDS
    blockers = fresh_evidence_blockers(fresh_evidence)
    improvements = []

    regression = thresholds["regression"]

    def require_delta(path, minimum, label):
        change = _delta(challenger, champion, *path)
        if change is None:
            blockers.append(f"{label}无法与现役模型比较")
        elif change < minimum:
            blockers.append(f"{label}下降超过允许阈值")
        return change

    mean_delta = require_delta(
        ("opportunity", "meanNetRAt5"),
        -regression["meanNetRMaxDrop"],
        "机会Top5平均净R",
    )
    lower = _metric(
        challenger,
        "opportunity",
        "netRLowerBound95",
    )
    lower_delta = require_delta(
        ("opportunity", "netRLowerBound95"),
        -regression["lowerBoundMaxDrop"],
        "机会Top5净R下界",
    )
    precision_delta = require_delta(
        ("opportunity", "precisionAt5"),
        -regression["precisionMaxDrop"],
        "机会Top5正净R命中率",
    )
    if lower is None or lower <= 0:
        blockers.append("机会Top5净R的95%下界必须大于0")
    stress_coverage = _metric(
        challenger,
        "opportunity",
        "stress10Coverage",
    )
    stress_lower = _metric(
        challenger,
        "opportunity",
        "stress10NetRLowerBound95",
    )
    if stress_coverage is None or stress_coverage < 1:
        blockers.append("10bps压力标签覆盖率必须达到100%")
    if stress_lower is None or stress_lower <= 0:
        blockers.append("10bps压力净R的95%下界必须大于0")

    selected = _metric(challenger, "opportunity", "selected")
    active_days = _metric(challenger, "opportunity", "activeDays")
    if selected is None or selected < 5:
        blockers.append("挑战者至少需要5个入选机会")
    if active_days is None or active_days < 5:
        blockers.append("挑战者至少需要5个活跃交易日")
    for field, label in (
        ("selected", "入选机会覆盖"),
        ("activeDays", "活跃交易日覆盖"),
    ):
        candidate = _metric(challenger, "opportunity", field)
        baseline = _metric(champion, "opportunity", field)
        if (
            candidate is None
            or baseline is None
            or (
                baseline >= 10
                and candidate
                < baseline
                * regression["selectedCoverageMinimumRatio"]
            )
        ):
            blockers.append(f"{label}低于现役模型的一半")

    drawdown = _metric(
        challenger,
        "opportunity",
        "maximumDrawdownRAt5",
    )
    champion_drawdown = _metric(
        champion,
        "opportunity",
        "maximumDrawdownRAt5",
    )
    if drawdown is None or champion_drawdown is None:
        blockers.append("机会Top5最大回撤无法与现役模型比较")
    else:
        allowed = champion_drawdown + max(
            regression["drawdownAbsoluteIncreaseR"],
            abs(champion_drawdown)
            * regression["drawdownRelativeIncrease"],
        )
        if drawdown > allowed:
            blockers.append("机会Top5最大回撤恶化超过允许阈值")
    account_drawdown = _metric(
        challenger,
        "opportunity",
        "accountDrawdownPctAtRisk07Top5",
    )
    if (
        account_drawdown is None
        or account_drawdown
        > regression["maximumAccountDrawdownPctAtRisk07Top5"]
    ):
        blockers.append("按单笔0.7%风险映射的账户回撤超过10%")
    annualized_trades = _metric(
        challenger,
        "opportunity",
        "account",
        "annualizedTrades",
    )
    if (
        annualized_trades is None
        or annualized_trades
        < regression["minimumAnnualizedTrades"]
    ):
        blockers.append("挑战者年化有效交易数低于80笔")

    for path, label in (
        (("conditional", "pWinBrier"), "盈利概率Brier"),
        (("fill", "pFillBrier"), "成交概率Brier"),
    ):
        change = _delta(challenger, champion, *path)
        if change is None:
            blockers.append(f"{label}无法与现役模型比较")
        elif change > regression["brierMaxIncrease"]:
            blockers.append(f"{label}恶化超过0.01")

    candidate_mae = _metric(challenger, "conditional", "netRMae")
    champion_mae = _metric(champion, "conditional", "netRMae")
    if candidate_mae is None or champion_mae is None:
        blockers.append("净R MAE无法与现役模型比较")
    elif candidate_mae > champion_mae * (
        1 + regression["netRMaeRelativeIncrease"]
    ):
        blockers.append("净R MAE恶化超过5%")

    candidate_q10 = _metric(
        challenger,
        "conditional",
        "q10Coverage",
    )
    champion_q10 = _metric(
        champion,
        "conditional",
        "q10Coverage",
    )
    if (
        candidate_q10 is None
        or candidate_q10 < regression["q10CoverageMinimum"]
    ):
        blockers.append("Q10覆盖率低于85%")
    elif (
        champion_q10 is None
        or candidate_q10
        < champion_q10 - regression["q10CoverageMaxDrop"]
    ):
        blockers.append("Q10覆盖率下降超过2个百分点")

    improvement = thresholds["improvement"]
    if (
        mean_delta is not None
        and mean_delta >= improvement["meanNetRMinimumLift"]
    ):
        improvements.append("机会Top5平均净R至少提升0.01R")
    if (
        lower_delta is not None
        and lower_delta >= improvement["lowerBoundMinimumLift"]
    ):
        improvements.append("机会Top5净R下界至少提升0.005R")
    if (
        precision_delta is not None
        and precision_delta >= improvement["precisionMinimumLift"]
    ):
        improvements.append("机会Top5命中率至少提升1个百分点")
    if (
        drawdown is not None
        and champion_drawdown is not None
        and champion_drawdown - drawdown
        >= improvement["drawdownMinimumReductionR"]
        and (mean_delta or 0) >= 0
    ):
        improvements.append("回撤至少降低0.05R且平均净R未下降")
    if not improvements:
        blockers.append("挑战者没有达到业务收益改善门槛")
    return {
        "passed": not blockers,
        "blockers": list(dict.fromkeys(blockers)),
        "improvements": improvements,
    }


def select_review_release(
    dataset_path,
    champion_directory,
    challenger_directory,
    *,
    decision_output,
):
    champion_members, champion_metadata = _load_bundle(
        champion_directory
    )
    challenger_members, challenger_metadata = _load_bundle(
        challenger_directory
    )
    champion_schema = champion_metadata.get("featureSchemaVersion")
    challenger_schema = challenger_metadata.get("featureSchemaVersion")
    schemas_match = (
        champion_schema == challenger_schema
        and tuple(champion_metadata.get("featureNames") or ())
        == tuple(challenger_metadata.get("featureNames") or ())
    )
    # 同窗评估要求特征矩阵维度与模型一致：仅当冠亚合同一致时按该合同装配数据集；
    # 不一致时会被下方门禁拦截、跳过评估，此处用挑战者合同装配不影响结论。
    dataset = load_dataset(
        dataset_path,
        feature_schema=_schema_key(challenger_schema),
    )
    partitions = fresh_confirmation_partitions(
        dataset,
        champion_metadata,
    )
    evidence = partitions["evidence"]
    blockers = []
    universe = (dataset.get("summary") or {}).get("universe") or {}
    if (
        universe.get("schema_version") != "cn-main-board.v1"
        or any(
            not is_main_board_code(code)
            for field in (
                "codes",
                "codes_all",
                "codes_opportunity",
            )
            for code in np.asarray(dataset.get(field, [])).astype(str)
        )
    ):
        blockers.append("挑战者训练数据未通过沪深主板边界校验")
    if challenger_metadata.get("productionEligible") is not True:
        blockers.append("挑战者未通过自身生产门禁")
    if not schemas_match:
        blockers.append("现役模型与挑战者特征合同不一致")
    if (
        challenger_metadata.get("modelVersion")
        == champion_metadata.get("modelVersion")
    ):
        blockers.append("挑战者版本与现役模型相同")
    evidence_blockers = fresh_evidence_blockers(evidence)
    if evidence_blockers:
        blockers.extend(evidence_blockers)
        champion_evaluation = None
        challenger_evaluation = None
        improvements = []
    elif blockers:
        champion_evaluation = None
        challenger_evaluation = None
        improvements = []
    else:
        champion_evaluation = evaluate_review_release(
            dataset,
            partitions,
            champion_members,
            champion_metadata,
        )
        challenger_evaluation = evaluate_review_release(
            dataset,
            partitions,
            challenger_members,
            challenger_metadata,
        )
        gate = review_promotion_gate(
            champion_evaluation,
            challenger_evaluation,
            evidence,
        )
        blockers.extend(gate["blockers"])
        improvements = gate["improvements"]
    action = "PUBLISH" if not blockers else "KEEP_CURRENT"
    decision = {
        "schemaVersion": REVIEW_RELEASE_SCHEMA_VERSION,
        "generatedAt": int(time.time() * 1000),
        "action": action,
        "eligible": action == "PUBLISH",
        "reason": (
            "挑战者在共同新增留出集上改善且通过全部风险门禁"
            if action == "PUBLISH"
            else "挑战者未能在共同新增留出集上证明优于现役模型"
        ),
        "championVersion": champion_metadata["modelVersion"],
        "challengerVersion": challenger_metadata["modelVersion"],
        "championFeatureSchemaVersion": champion_schema,
        "challengerFeatureSchemaVersion": challenger_schema,
        "selectedVersion": (
            challenger_metadata["modelVersion"]
            if action == "PUBLISH"
            else champion_metadata["modelVersion"]
        ),
        "freshHoldout": evidence,
        "thresholds": REVIEW_RELEASE_THRESHOLDS,
        "evaluation": {
            "champion": champion_evaluation,
            "challenger": challenger_evaluation,
        },
        "compatibility": {
            "passed": action == "PUBLISH",
            "blockers": list(dict.fromkeys(blockers)),
            "improvements": improvements,
        },
    }
    _write_json(decision_output, decision)
    return decision


def main():
    parser = argparse.ArgumentParser(
        description="比较现役与挑战者复核模型并生成发布裁决",
    )
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--champion", required=True)
    parser.add_argument("--challenger", required=True)
    parser.add_argument("--decision-output", required=True)
    args = parser.parse_args()
    decision = select_review_release(
        args.dataset,
        args.champion,
        args.challenger,
        decision_output=args.decision_output,
    )
    print(json.dumps({
        "action": decision["action"],
        "championVersion": decision["championVersion"],
        "challengerVersion": decision["challengerVersion"],
        "selectedVersion": decision["selectedVersion"],
        "blockers": decision["compatibility"]["blockers"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
