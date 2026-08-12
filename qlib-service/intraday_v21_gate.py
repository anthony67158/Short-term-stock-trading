"""Hard offline promotion gate for the V2.1 intraday dual-head model."""

import argparse
import json
import math
import os


HEADS = ("next30m", "sessionClose")
SESSIONS = ("morning", "noon", "afternoon")
MIN_BALANCED_ACCURACY = 0.58
MIN_MACRO_F1 = 0.48
MAX_LOG_LOSS = 1.05
MIN_CLASS_SAMPLES = 100
MIN_SESSION_BALANCED_ACCURACY = 0.52


def _number(value, label):
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} 必须是数值") from error
    if not math.isfinite(result):
        raise ValueError(f"{label} 必须是有限数值")
    return result


def _head_metrics(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"缺少 {label} 指标")
    counts = value.get("class_counts")
    if not isinstance(counts, dict):
        raise ValueError(f"缺少 {label} 类别样本数")
    return {
        "balanced_accuracy": _number(
            value.get("balanced_accuracy"),
            f"{label}.balanced_accuracy",
        ),
        "macro_f1": _number(value.get("macro_f1"), f"{label}.macro_f1"),
        "log_loss": _number(value.get("log_loss"), f"{label}.log_loss"),
        "class_counts": {
            str(index): int(counts.get(str(index), 0))
            for index in range(3)
        },
    }


def evaluate_v21_candidate(metrics):
    if not isinstance(metrics, dict):
        raise ValueError("V2.1 指标必须是对象")
    if metrics.get("model_version") != "v2.1-intraday":
        raise ValueError("V2.1 模型版本不匹配")
    heads = {
        name: _head_metrics(metrics.get("heads", {}).get(name), name)
        for name in HEADS
    }
    sessions = {}
    blockers = []
    for name, values in heads.items():
        if values["balanced_accuracy"] < MIN_BALANCED_ACCURACY:
            blockers.append(
                f"{name} 平衡准确率未达到 {MIN_BALANCED_ACCURACY:.2f}"
            )
        if values["macro_f1"] < MIN_MACRO_F1:
            blockers.append(f"{name} Macro F1 未达到 {MIN_MACRO_F1:.2f}")
        if values["log_loss"] >= MAX_LOG_LOSS:
            blockers.append(f"{name} Log Loss 未低于 {MAX_LOG_LOSS:.2f}")
        for class_name, count in values["class_counts"].items():
            if count < MIN_CLASS_SAMPLES:
                blockers.append(
                    f"{name} 类别{class_name}留出样本少于 {MIN_CLASS_SAMPLES}"
                )

    for bucket in SESSIONS:
        bucket_metrics = metrics.get("sessions", {}).get(bucket)
        if not isinstance(bucket_metrics, dict):
            blockers.append(f"缺少 {bucket} 时段指标")
            continue
        sessions[bucket] = {}
        for head_name in HEADS:
            values = _head_metrics(
                bucket_metrics.get(head_name),
                f"{bucket}.{head_name}",
            )
            sessions[bucket][head_name] = values
            if (
                values["balanced_accuracy"]
                < MIN_SESSION_BALANCED_ACCURACY
            ):
                blockers.append(
                    f"{bucket}.{head_name} 平衡准确率未达到 "
                    f"{MIN_SESSION_BALANCED_ACCURACY:.2f}"
                )

    eligible = not blockers
    return {
        "schema_version": 1,
        "model_version": "v2.1-intraday",
        "heads": heads,
        "sessions": sessions,
        "thresholds": {
            "minimum_balanced_accuracy": MIN_BALANCED_ACCURACY,
            "minimum_macro_f1": MIN_MACRO_F1,
            "maximum_log_loss": MAX_LOG_LOSS,
            "minimum_class_samples": MIN_CLASS_SAMPLES,
            "minimum_session_balanced_accuracy": (
                MIN_SESSION_BALANCED_ACCURACY
            ),
        },
        "production_eligible": eligible,
        "blockers": blockers,
        "decision": "promote" if eligible else "rejected",
    }


def main():
    parser = argparse.ArgumentParser(
        description="评估 V2.1 盘中双头模型是否允许生产晋级",
    )
    parser.add_argument("--metrics", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with open(args.metrics, encoding="utf-8") as handle:
        metrics = json.load(handle)
    report = evaluate_v21_candidate(metrics)
    output = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("INTRADAY_V21_GATE_OK")


if __name__ == "__main__":
    main()
