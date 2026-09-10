"""Aggregate repeated V3 POC runs and enforce stability gates."""

import argparse
import json
import os

import numpy as np


SUMMARY_SCHEMA_VERSION = "v3-model-bakeoff-summary.v1"


def _mean(values):
    return round(float(np.mean(values)), 6)


def _minimum(values):
    return round(float(np.min(values)), 6)


def _fold_metric(report, family, path):
    values = []
    for fold in report["families"][family].get("folds") or []:
        current = fold
        for key in path:
            current = (current or {}).get(key)
        if current is None:
            return []
        values.append(float(current))
    return values


def summarize_reports(paths):
    reports = []
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
        if value.get("schemaVersion") != "v3-model-bakeoff.v1":
            raise ValueError("POC报告版本无效")
        reports.append(value)
    if len(reports) < 2:
        raise ValueError("稳定性评估至少需要两次POC")
    dataset_hashes = {
        value["dataset"]["sha256"]
        for value in reports
    }
    if len(dataset_hashes) != 1:
        raise ValueError("POC报告使用了不同数据集")
    family_names = set(reports[0]["families"])
    if any(set(value["families"]) != family_names for value in reports):
        raise ValueError("POC报告模型集合不一致")

    families = {}
    for name in sorted(family_names):
        runs = [
            value["families"][name]["aggregate"]
            for value in reports
        ]
        utility_means = [
            float(value["utilityTop5MeanNetR"])
            for value in runs
        ]
        utility_lowers = [
            float(value["utilityTop5LowerBound"])
            for value in runs
        ]
        ranker_means = [
            float(value["rankerTop5MeanNetR"])
            for value in runs
        ]
        ranker_lowers = [
            float(value["rankerTop5LowerBound"])
            for value in runs
        ]
        q10_coverages = [
            float(value["q10Coverage"])
            for value in runs
        ]
        pwin_skills = [
            float(value.get("pWinBrierSkill", float("-inf")))
            for value in runs
        ]
        netr_skills = [
            float(value.get("netRMaeSkill", float("-inf")))
            for value in runs
        ]
        positive_coverages = [
            float(value.get("positiveExpectedCoverage", 0))
            for value in runs
        ]
        utility_fold_means = [
            metric
            for report in reports
            for metric in _fold_metric(
                report,
                name,
                ("ranking", "utility", "top5", "mean_net_r_at_5"),
            )
        ]
        ranker_fold_means = [
            metric
            for report in reports
            for metric in _fold_metric(
                report,
                name,
                ("ranking", "ranker", "top5", "mean_net_r_at_5"),
            )
        ]
        passed = (
            len(utility_fold_means) >= len(reports) * 3
            and min(utility_fold_means) > 0
            and _minimum(utility_lowers) > 0
            and min(q10_coverages) >= 0.88
            and max(q10_coverages) <= 0.92
            and _minimum(pwin_skills) > 0
            and _minimum(netr_skills) > 0
            and _minimum(positive_coverages) >= 0.02
        )
        ranker_candidate = (
            len(ranker_fold_means) >= len(reports) * 3
            and min(ranker_fold_means) > 0
            and min(ranker_means) > 0
            and _minimum(ranker_lowers) > 0
        )
        families[name] = {
            "runs": len(runs),
            "utilityTop5MeanNetR": _mean(utility_means),
            "utilityTop5WorstSeedMeanNetR": _minimum(utility_means),
            "utilityTop5WorstSeedLowerBound": _minimum(
                utility_lowers,
            ),
            "rankerTop5MeanNetR": _mean(ranker_means),
            "rankerTop5WorstSeedMeanNetR": _minimum(ranker_means),
            "rankerTop5WorstSeedLowerBound": _minimum(
                ranker_lowers,
            ),
            "q10CoverageMean": _mean(q10_coverages),
            "q10CoverageMinimum": _minimum(q10_coverages),
            "pWinBrierSkillWorstSeed": _minimum(pwin_skills),
            "netRMaeSkillWorstSeed": _minimum(netr_skills),
            "positiveExpectedCoverageWorstSeed": _minimum(
                positive_coverages,
            ),
            "allUtilityFoldsPositive": (
                len(utility_fold_means) >= len(reports) * 3
                and min(utility_fold_means) > 0
            ),
            "allRankerFoldsPositive": (
                len(ranker_fold_means) >= len(reports) * 3
                and min(ranker_fold_means) > 0
            ),
            "productionGatePassed": passed,
            "rankerGatePassed": ranker_candidate,
        }

    combination_runs = [
        value
        for report in reports
        for value in [
            (report.get("combination") or {}).get("aggregate")
        ]
        if isinstance(value, dict)
        and value.get("top5MeanNetR") is not None
        and value.get("top5LowerBound") is not None
    ]
    combination_means = [
        float(value["top5MeanNetR"])
        for value in combination_runs
    ]
    combination_lowers = [
        float(value["top5LowerBound"])
        for value in combination_runs
    ]
    combination_fold_means = [
        float(
            fold["ranking"]["top5"]["mean_net_r_at_5"]
        )
        for report in reports
        for fold in (report.get("combination") or {}).get("folds") or []
    ]
    combination_ready = bool(
        (families.get("lightgbm") or {}).get(
            "productionGatePassed"
        )
        and (families.get("catboost") or {}).get(
            "rankerGatePassed"
        )
        and len(combination_runs) == len(reports)
        and len(combination_fold_means) >= len(reports) * 3
        and min(combination_fold_means) > 0
        and _minimum(combination_lowers) > 0
    )
    winners = [
        name
        for name, value in families.items()
        if value["productionGatePassed"]
    ]
    return {
        "schemaVersion": SUMMARY_SCHEMA_VERSION,
        "datasetSha256": dataset_hashes.pop(),
        "runs": len(reports),
        "families": families,
        "combination": {
            "actionValue": "lightgbm",
            "ranking": "catboost",
            "eligible": combination_ready,
            "top5MeanNetR": (
                _mean(combination_means)
                if combination_means else None
            ),
            "top5WorstSeedLowerBound": (
                _minimum(combination_lowers)
                if combination_lowers else None
            ),
            "allFoldsPositive": (
                len(combination_fold_means) >= len(reports) * 3
                and min(combination_fold_means) > 0
            ),
        },
        "decision": {
            "state": (
                "PRODUCTION_COMBINATION_READY"
                if combination_ready
                else "STABLE_WINNER"
                if len(winners) == 1
                else "NO_STABLE_WINNER"
            ),
            "winner": (
                "lightgbm+catboost"
                if combination_ready
                else winners[0] if len(winners) == 1 else None
            ),
            "reason": (
                "LightGBM动作价值与CatBoost排序同时通过多种子门槛"
                if combination_ready
                else f"{winners[0]}通过多种子费后价值与尾部校准门槛"
                if len(winners) == 1
                else "当前组合未同时通过窗口、下界、校准、技能和覆盖率门槛"
            ),
        },
    }


def markdown(summary):
    rows = []
    for name, value in summary["families"].items():
        rows.append(
            f"| {name} | {value['utilityTop5MeanNetR']:.4f}R | "
            f"{value['utilityTop5WorstSeedLowerBound']:.4f}R | "
            f"{value['rankerTop5MeanNetR']:.4f}R | "
            f"{value['rankerTop5WorstSeedLowerBound']:.4f}R | "
            f"{value['q10CoverageMean']:.1%} | "
            f"{'通过' if value['productionGatePassed'] else '未通过'} |"
        )
    return "\n".join([
        "# V3 双模型多种子稳定性总结",
        "",
        f"- 数据摘要：`{summary['datasetSha256']}`",
        f"- 重复次数：{summary['runs']}",
        f"- 结论：**{summary['decision']['reason']}**",
        "",
        "| 模型 | 动作价值Top5均值 | 最差种子下界 | Ranker Top5均值 | Ranker最差下界 | Q10覆盖率 | 生产门槛 |",
        "|---|---:|---:|---:|---:|---:|---|",
        *rows,
        "",
    ])


def main():
    parser = argparse.ArgumentParser(
        description="汇总V3双模型多种子POC",
    )
    parser.add_argument("reports", nargs="+")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    summary = summarize_reports(args.reports)
    os.makedirs(args.output_dir, exist_ok=True)
    with open(
        os.path.join(args.output_dir, "stability.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    with open(
        os.path.join(args.output_dir, "stability.md"),
        "w",
        encoding="utf-8",
    ) as handle:
        handle.write(markdown(summary))
    print(json.dumps(summary["decision"], ensure_ascii=False))


if __name__ == "__main__":
    main()
