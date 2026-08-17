"""Publish one idempotent daily-retrain result into the dashboard OSS inbox."""

import json
import os
import time

from upload_model import bucket


REASONS = {
    "below_floor": "挑战者样本外 AUC 低于绝对下限",
    "not_better_than_champion": "挑战者样本外 AUC 未超过冠军基线（含容差）",
    "data_unavailable": "行情数据源不可达，本次安全跳过",
    "unhealthy_data": "训练数据健康度未通过护栏",
    "insufficient_forward_holdout": "冠军训练后的成熟样本不足",
    "single_class_forward_holdout": "前向保留集只有单一标签",
    "champion_features_incompatible": "冠军特征与当前数据集不兼容",
}

DECISIONS = {
    "promote": ("晋级", "晋级（新冠军已上传）"),
    "reject": ("拒绝", "拒绝（保留冠军，线上不变）"),
    "skip": ("跳过", "跳过（线上冠军不变）"),
    "error": ("异常", "异常（线上冠军不变）"),
}


def latest_record(path="retrain_history.jsonl"):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        records = [json.loads(line) for line in fh if line.strip()]
    return records[-1] if records else None


def text(value, fallback="-"):
    value = str(value if value is not None else "").strip()
    return value[:500] if value else fallback


def metric(value):
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.4f}".rstrip("0").rstrip(".")
    return str(value)


def report_from(record, env=None, now_ms=None):
    env = env or os.environ
    run_id = int(env["GITHUB_RUN_ID"])
    run_number = int(env.get("GITHUB_RUN_NUMBER") or 0)
    job_status = text(env.get("RETRAIN_JOB_STATUS"), "unknown")
    preflight = text(env.get("RETRAIN_PREFLIGHT"), "unknown")
    repo = text(env.get("GITHUB_REPOSITORY"), "anthony67158/Short-term-stock-trading")
    workflow_url = f"https://github.com/{repo}/actions/runs/{run_id}"
    rec = dict(record or {})

    if not rec:
        decision = "skip" if preflight != "ok" and job_status == "success" else "error"
        rec = {
            "decision": decision,
            "reason": "data_unavailable" if decision == "skip" else "workflow_failed",
        }
    decision = text(rec.get("decision"), "error").lower()
    if decision not in DECISIONS:
        decision = "error"
    decision_label, title_label = DECISIONS[decision]
    reason = REASONS.get(text(rec.get("reason")), text(rec.get("reason")))
    training_at = text(rec.get("at"), "-")

    lines = [
        f"决策：{decision_label}",
        f"训练时间：{training_at}",
        f"原因：{reason}",
    ]
    if rec.get("reason") == "insufficient_forward_holdout":
        lines.extend([
            (
                f"前向样本：{metric(rec.get('holdout_n'))}/"
                f"{metric(rec.get('required_samples'))}"
            ),
            (
                f"成熟交易日：{len(rec.get('holdout_dates') or [])}/"
                f"{metric(rec.get('required_dates'))}"
            ),
            f"冠军数据截止：{text(rec.get('champion_data_end'))}",
        ])
    else:
        lines.extend([
            (
                "样本外 AUC："
                f"冠军 {metric(rec.get('champ_baseline_auc'))} "
                f"vs 挑战者 {metric(rec.get('chall_holdout_auc'))}"
            ),
            (
                f"样本量：{metric(rec.get('n_samples'))}，"
                f"正样本率 {metric(rec.get('pos_rate'))}，"
                f"切分日 {text(rec.get('cut_date'))}"
            ),
            f"耗时：{metric(rec.get('elapsed_s'))}s",
            f"模型上传：{text(rec.get('oss_uploaded'))}",
            f"信号头：{text(rec.get('signal_decision'))}",
        ])
    lines.append(f"任务：GitHub Actions #{run_number}")
    at = int(now_ms if now_ms is not None else time.time() * 1000)
    report = {
        "at": at,
        "title": f"量化每日重训 · {title_label}",
        "body": "\n".join(lines),
        "decision": decision,
        "meta": {
            "runId": run_id,
            "runNumber": run_number,
            "event": text(env.get("GITHUB_EVENT_NAME"), ""),
            "workflowStatus": job_status,
            "workflowUrl": workflow_url,
            "headSha": text(env.get("GITHUB_SHA"), "")[:12],
            "trainingAt": training_at,
            "preflight": preflight,
            "champBaselineAuc": rec.get("champ_baseline_auc"),
            "challHoldoutAuc": rec.get("chall_holdout_auc"),
            "cvAuc": rec.get("cv_auc"),
            "nSamples": rec.get("n_samples"),
            "elapsedSec": rec.get("elapsed_s"),
            "ossUploaded": rec.get("oss_uploaded"),
            "signalDecision": rec.get("signal_decision"),
            "holdoutN": rec.get("holdout_n"),
            "requiredSamples": rec.get("required_samples"),
            "holdoutDates": rec.get("holdout_dates"),
            "requiredDates": rec.get("required_dates"),
            "championDataEnd": rec.get("champion_data_end"),
        },
    }
    return f"quantreport/retrain-{run_id}.json", report


def main():
    key, report = report_from(latest_record())
    payload = json.dumps(report, ensure_ascii=False, separators=(",", ":"))
    bucket().put_object(key, payload.encode("utf-8"))
    print(f"[quant-report] published {key}")


if __name__ == "__main__":
    main()
