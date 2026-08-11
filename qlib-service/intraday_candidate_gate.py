"""Decide whether an intraday challenger may enter isolated shadow validation."""

import argparse
import json
import math
import os

from minute_data import validate_download_report_for_training


REQUIRED_ARCHITECTURES = ("tcn", "gru", "transformer")
SHADOW_MIN_BALANCED_ACCURACY = 0.60
SHADOW_MIN_MACRO_F1 = 0.42


def _metric(value, name):
    try:
        metric = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} 必须是有限数值") from error
    if not math.isfinite(metric):
        raise ValueError(f"{name} 必须是有限数值")
    return metric


def _normalized_metrics(bakeoff_metrics):
    if not isinstance(bakeoff_metrics, dict):
        raise ValueError("bakeoff_metrics 必须是对象")
    normalized = {}
    for architecture in REQUIRED_ARCHITECTURES:
        item = bakeoff_metrics.get(architecture)
        if not isinstance(item, dict):
            raise ValueError(f"缺少 {architecture} 对拍指标")
        log_loss = _metric(item.get("holdout_log_loss"), "holdout_log_loss")
        macro_f1 = _metric(item.get("holdout_macro_f1"), "holdout_macro_f1")
        balanced_accuracy = _metric(
            item.get("holdout_balanced_accuracy"),
            "holdout_balanced_accuracy",
        )
        if log_loss < 0 or not 0 <= macro_f1 <= 1 or not 0 <= balanced_accuracy <= 1:
            raise ValueError(f"{architecture} 对拍指标范围无效")
        normalized[architecture] = {
            "holdout_log_loss": log_loss,
            "holdout_macro_f1": macro_f1,
            "holdout_balanced_accuracy": balanced_accuracy,
            "best_epoch": int(item.get("best_epoch", 0)),
        }
    return normalized


def select_intraday_architecture(bakeoff_metrics):
    """Choose by classification quality, then calibration loss as a tie-breaker."""
    metrics = _normalized_metrics(bakeoff_metrics)
    architecture = max(
        REQUIRED_ARCHITECTURES,
        key=lambda name: (
            metrics[name]["holdout_balanced_accuracy"],
            metrics[name]["holdout_macro_f1"],
            -metrics[name]["holdout_log_loss"],
        ),
    )
    return architecture, metrics


def evaluate_intraday_candidate(bakeoff_metrics, download_report):
    """Produce a non-production candidate decision from offline evidence."""
    architecture, metrics = select_intraday_architecture(bakeoff_metrics)
    selected = metrics[architecture]
    shadow_blockers = []
    try:
        data_quality = validate_download_report_for_training(download_report)
    except ValueError as error:
        data_quality = None
        shadow_blockers.append(str(error))

    if selected["holdout_balanced_accuracy"] < SHADOW_MIN_BALANCED_ACCURACY:
        shadow_blockers.append(
            "留出集平衡准确率未达到影子观察门槛 "
            f"{SHADOW_MIN_BALANCED_ACCURACY:.2f}"
        )
    if selected["holdout_macro_f1"] < SHADOW_MIN_MACRO_F1:
        shadow_blockers.append(
            "留出集 Macro F1 未达到影子观察门槛 "
            f"{SHADOW_MIN_MACRO_F1:.2f}"
        )

    shadow_eligible = not shadow_blockers
    return {
        "schema_version": 1,
        "selected_architecture": architecture,
        "selected_metrics": selected,
        "all_metrics": metrics,
        "data_quality": data_quality,
        "shadow_eligible": shadow_eligible,
        "shadow_blockers": shadow_blockers,
        "production_eligible": False,
        "production_blockers": [
            "未完成连续 14 至 28 天真实前向影子观察",
            "未完成分钟候选模型的含费 A 股成交回测",
            "未完成影子推理稳定性与延迟验证",
            "未获得独立人工生产发布确认",
        ],
        "decision": "shadow_only" if shadow_eligible else "rejected",
    }


def main():
    parser = argparse.ArgumentParser(
        description="评估分钟候选模型是否仅可进入影子观察",
    )
    parser.add_argument("--bakeoff", required=True)
    parser.add_argument("--download-report", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.bakeoff, encoding="utf-8") as handle:
        bakeoff_metrics = json.load(handle)
    with open(args.download_report, encoding="utf-8") as handle:
        download_report = json.load(handle)
    report = evaluate_intraday_candidate(bakeoff_metrics, download_report)
    output = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("INTRADAY_CANDIDATE_GATE_OK")


if __name__ == "__main__":
    main()
