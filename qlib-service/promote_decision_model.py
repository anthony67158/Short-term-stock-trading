"""Promote a decision model only after return-based gates pass."""

import argparse
import json
import os
import shutil

from decision_engine.registry import (
    artifact_filenames_for_metadata,
    validate_decision_metadata,
)


PROMOTION_SCHEMA_VERSION = "opportunity-promotion.v1"


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def ensemble_window_blocker(ensemble):
    folds = ensemble.get("folds") or []
    latest = max(
        (fold for fold in folds if isinstance(fold, dict)),
        key=lambda fold: str(fold.get("validationEndDate") or ""),
        default=None,
    )
    if not latest:
        return "三种子集成仍有负收益独立窗口"
    mean = _number(latest.get("meanNetRAt5"))
    lower = _number(latest.get("netRLowerBound"))
    if mean is None or lower is None:
        return "三种子集成仍有负收益独立窗口"
    period = " 至 ".join(filter(None, (
        str(latest.get("validationStartDate") or ""),
        str(latest.get("validationEndDate") or ""),
    )))
    prefix = f"最新独立窗口（{period}）" if period else "最新独立窗口"
    return (
        f"{prefix} Top5费后净R {mean:+.3f}R，"
        f"下置信界 {lower:+.3f}R"
    )


def production_model_version(value):
    version = str(value or "").strip()
    if not version:
        raise ValueError("机会模型版本缺失")
    if version.endswith(".production"):
        return version
    promoted = version + ".production"
    if len(promoted) > 96:
        raise ValueError("机会生产模型版本过长")
    return promoted


def promotion_decision(report, stability=None):
    blockers = []
    ensemble = report.get("seedEnsemble") or {}
    ensemble_aggregate = ensemble.get("aggregate") or {}
    ensemble_folds = ensemble.get("folds") or []
    has_ensemble_metrics = (
        _number(ensemble_aggregate.get("top5MeanNetR")) is not None
        and _number(ensemble_aggregate.get("top5LowerBound")) is not None
    )
    if stability is not None:
        combination = stability.get("combination") or {}
        if combination.get("eligible") is not True:
            blockers.append(
                "LightGBM动作价值与CatBoost排序未同时通过多种子门槛"
            )
    if report.get("state") != "SHADOW_READY":
        blockers.append("影子模型尚未通过训练闸门")
    walk = report.get("walkForward") or {}
    if (
        walk.get("shadowEligible") is not True
        or int(walk.get("folds") or 0) < 2
    ):
        blockers.append("独立walk-forward窗口不足或不稳定")
    ranking = ((report.get("metrics") or {}).get("ranking") or {})
    challenger = ranking.get("challenger") or {}
    baseline = ranking.get("baseline") or {}
    lower_bound = _number(
        ensemble_aggregate.get("top5LowerBound")
        if has_ensemble_metrics
        else challenger.get("netRLowerBound")
    )
    challenger_net_r = _number(
        ensemble_aggregate.get("top5MeanNetR")
        if has_ensemble_metrics
        else challenger.get("mean_net_r_at_5")
    )
    baseline_net_r = _number(baseline.get("mean_net_r_at_5"))
    if lower_bound is None or lower_bound <= 0:
        blockers.append("Top5费后净R下置信界未大于0")
    if has_ensemble_metrics and any(
        (_number(fold.get("meanNetRAt5")) or 0) <= 0
        for fold in ensemble_folds
    ):
        blockers.append(ensemble_window_blocker(ensemble))
    if challenger_net_r is None or baseline_net_r is None:
        blockers.append("Top5净R对照指标缺失")
    else:
        minimum_lift = max(0.05, abs(baseline_net_r) * 0.2)
        if challenger_net_r < baseline_net_r + minimum_lift:
            blockers.append("Top5费后净R未较旧公式提升至少20%或0.05R")
    challenger_drawdown = _number(
        challenger.get("max_drawdown_r_at_5")
    )
    baseline_drawdown = _number(baseline.get("max_drawdown_r_at_5"))
    if (
        challenger_drawdown is None
        or baseline_drawdown is None
        or challenger_drawdown > baseline_drawdown * 1.1 + 1e-9
    ):
        blockers.append("Top5最大回撤较旧公式恶化超过10%")
    challenger_precision = _number(challenger.get("precision_at_5"))
    baseline_precision = _number(baseline.get("precision_at_5"))
    if (
        challenger_precision is None
        or baseline_precision is None
        or challenger_precision < baseline_precision
    ):
        blockers.append("Top5正净R命中率低于旧公式")
    return {
        "schemaVersion": PROMOTION_SCHEMA_VERSION,
        "eligible": not blockers,
        "blockers": blockers,
        "metrics": {
            "netRLowerBound": lower_bound,
            "challengerMeanNetRAt5": challenger_net_r,
            "baselineMeanNetRAt5": baseline_net_r,
            "challengerMaxDrawdownRAt5": challenger_drawdown,
            "baselineMaxDrawdownRAt5": baseline_drawdown,
            "challengerPrecisionAt5": challenger_precision,
            "baselinePrecisionAt5": baseline_precision,
        },
    }


def promote(
    source_directory,
    report_path,
    output_directory,
    *,
    stability_path=None,
):
    with open(report_path, encoding="utf-8") as handle:
        report = json.load(handle)
    stability = None
    if stability_path:
        with open(stability_path, encoding="utf-8") as handle:
            stability = json.load(handle)
    decision = promotion_decision(report, stability)
    if not decision["eligible"]:
        raise ValueError("；".join(decision["blockers"]))
    source = os.path.abspath(source_directory)
    target = os.path.abspath(output_directory)
    os.makedirs(target, exist_ok=True)
    metadata_path = os.path.join(source, "opportunity_meta.json")
    with open(metadata_path, encoding="utf-8") as handle:
        metadata = validate_decision_metadata(json.load(handle))
    artifact_filenames = artifact_filenames_for_metadata(metadata)
    for filename in artifact_filenames.values():
        source_path = os.path.join(source, filename)
        if not os.path.isfile(source_path):
            raise FileNotFoundError(source_path)
        shutil.copy2(source_path, os.path.join(target, filename))
    metadata_path = os.path.join(
        target,
        artifact_filenames["meta"],
    )
    metadata.update({
        "modelVersion": production_model_version(
            metadata.get("modelVersion"),
        ),
        "shadowOnly": False,
        "productionEligible": True,
        "promotion": decision,
    })
    temporary = metadata_path + ".part"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(metadata, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, metadata_path)
    validate_decision_metadata(metadata)
    return decision


def main():
    parser = argparse.ArgumentParser(
        description="晋级机会动作价值模型",
    )
    parser.add_argument("--source", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stability")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--decision-output")
    args = parser.parse_args()
    with open(args.report, encoding="utf-8") as handle:
        report = json.load(handle)
    stability = None
    if args.stability:
        with open(args.stability, encoding="utf-8") as handle:
            stability = json.load(handle)
    checked = promotion_decision(report, stability)
    if args.decision_output:
        destination = os.path.abspath(args.decision_output)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        temporary = destination + ".part"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(checked, handle, ensure_ascii=False, indent=2)
        os.replace(temporary, destination)
    if args.check_only:
        print(json.dumps(checked, ensure_ascii=False, indent=2))
        return
    decision = promote(
        args.source,
        args.report,
        args.output,
        stability_path=args.stability,
    )
    print(json.dumps(decision, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
