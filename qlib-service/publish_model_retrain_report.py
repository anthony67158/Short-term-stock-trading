"""Publish V3 and sector retraining outcomes to the existing quant inbox."""

import argparse
import json
import math
import os
import time
from pathlib import Path


MODEL_LABELS = {"opportunity": "V3 机会模型", "sector": "板块模型"}
DECISIONS = {
    "promote": "已发布",
    "updated": "已更新",
    "shadow": "仅影子发布",
    "reject": "未通过晋级",
    "skip": "等待数据",
    "error": "运行异常",
    "cancelled": "已取消",
}


def number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (ValueError, TypeError):
        return None
    return result if math.isfinite(result) else None


def milliseconds(value):
    numeric = number(value)
    if numeric is None or numeric <= 0:
        return None
    return int(numeric * 1000 if numeric < 100_000_000_000 else numeric)


def display(value):
    numeric = number(value)
    return f"{numeric:g}" if numeric is not None else "未提供"


def text(value):
    return str(value or "").strip()[:180]


def metric_row(label, challenger, baseline=None, unit="number"):
    return {
        "label": label,
        "challenger": number(challenger),
        "baseline": number(baseline),
        "unit": unit,
    }


def opportunity_details(report, promotion, env):
    readiness = report.get("readiness") or {}
    split = report.get("split") or {}
    ranking = (report.get("metrics") or {}).get("ranking") or {}
    candidate = ranking.get("challenger") or {}
    baseline = ranking.get("baseline") or {}
    walk = report.get("walkForward") or {}
    state = text(report.get("state"))
    eligible = promotion.get("eligible") is True
    published = eligible and env.get("RETRAIN_PUBLISHED") == "true"
    direct = env.get("RETRAIN_DIRECT_PUBLISHED") == "true"
    shadow = (
        report.get("shadowEligible") is True
        and env.get("RETRAIN_SHADOW_PUBLISHED") == "true"
    )
    decision = (
        "promote" if published else "updated" if direct else "shadow" if shadow
        else "skip" if state == "NOT_READY" else "reject"
    )
    blockers = [
        *(readiness.get("blockers") or []),
        *(report.get("shadowBlockers") or []),
        *(promotion.get("blockers") or []),
    ]
    if eligible and not published and not direct:
        decision = "error"
        blockers.insert(0, "晋级检查已通过，但生产发布未确认成功")
    elif not promotion and state != "NOT_READY":
        blockers.append("生产晋级检查未完成")
    facts = [
        {"label": "成熟样本", "value": display(readiness.get("samples"))},
        {"label": "完整成交样本", "value": display(readiness.get("filled_samples"))},
        {"label": "独立交易日", "value": display(readiness.get("dates"))},
        {"label": "训练截止", "value": text(split.get("train_end_date")) or "未提供"},
        {"label": "独立盲测起点", "value": text(split.get("holdout_start_date")) or "未提供"},
        {"label": "独立盲测样本", "value": display(split.get("holdout_samples"))},
        {"label": "滚动时间窗", "value": (
            f"{sum(row.get('shadowEligible') is True for row in walk.get('results', []))}"
            f"/{display(walk.get('folds'))} 窗通过"
        )},
        {"label": "候选版本", "value": text(report.get("modelVersion")) or "未生成"},
    ]
    metrics = [
        metric_row("Top5 费后净R", candidate.get("mean_net_r_at_5"),
                   baseline.get("mean_net_r_at_5"), "r"),
        metric_row("Top5 净R下置信界", candidate.get("netRLowerBound"), unit="r"),
        metric_row("Top5 最大回撤", candidate.get("max_drawdown_r_at_5"),
                   baseline.get("max_drawdown_r_at_5"), "r"),
        metric_row("Top5 正净R信号占比", candidate.get("precision_at_5"),
                   baseline.get("precision_at_5"), "percent"),
    ]
    for head, label, key in (
        ("pFill", "成交概率校准误差", "brier"),
        ("pWinGivenFill", "盈利概率校准误差", "brier"),
        ("pWinGivenFill", "盈利概率对数损失", "log_loss"),
        ("expectedNetR", "净R平均绝对误差", "mae"),
    ):
        values = (report.get("metrics") or {}).get(head) or {}
        metrics.append(metric_row(
            label, (values.get("challenger") or {}).get(key),
            (values.get("baseline") or {}).get(key),
        ))
    return decision, facts, metrics, blockers, milliseconds(report.get("generatedAt"))


def sector_details(report, _promotion, _env):
    meta = report.get("meta") or {}
    eligible = report.get("promoted") is True
    published = eligible and report.get("uploaded") is True
    decision = "promote" if published else "error" if eligible else "reject"
    blockers = []
    if eligible and not published:
        blockers.append("板块模型已通过检查，但生产上传未成功")
    elif not eligible:
        blockers.append("次日与周度模型未同时满足晋级要求，保留现役模型")
    dates = meta.get("blind_dates") or []
    facts = [
        {"label": "训练样本", "value": display(meta.get("n_samples"))},
        {"label": "数据截止", "value": text(meta.get("data_end_date")) or "未提供"},
        {"label": "独立盲测区间", "value": (
            f"{min(dates)} 至 {max(dates)}" if dates else "未提供"
        )},
        {"label": "候选版本", "value": text(meta.get("modelVersion")) or "未生成"},
    ]
    metrics = []
    for head, label in (("next", "次日"), ("week", "周度")):
        candidate = (meta.get("challenger_metrics") or {}).get(head) or {}
        baseline = (meta.get("champion_metrics") or {}).get(head) or {}
        for key, metric_label, unit in (
            ("auc", "AUC", "number"),
            ("logloss", "对数损失", "number"),
            ("top5_precision", "Top5 命中率", "percent"),
        ):
            metrics.append(metric_row(
                f"{label} {metric_label}", candidate.get(key),
                baseline.get(key), unit,
            ))
    return decision, facts, metrics, blockers, milliseconds(meta.get("trained_at"))


def build_report(model, report=None, promotion=None, *, env=None, now_ms=None):
    env = dict(os.environ if env is None else env)
    if model not in MODEL_LABELS:
        raise ValueError("不支持的重训模型")
    run_id = int(env["GITHUB_RUN_ID"])
    if run_id <= 0:
        raise ValueError("无效的运行批次")
    at = int(now_ms if now_ms is not None else time.time() * 1000)
    job_status = text(env.get("RETRAIN_JOB_STATUS"))
    if isinstance(report, dict) and report:
        builder = opportunity_details if model == "opportunity" else sector_details
        decision, facts, metrics, blockers, trained_at = builder(report, promotion or {}, env)
    else:
        skipped = job_status == "success" and env.get("RETRAIN_PREFLIGHT") == "skip"
        decision = "skip" if skipped else "error"
        facts, metrics, trained_at = [], [], None
        blockers = ["行情数据源不可达，本次跳过"] if skipped else ["本轮未生成完整训练报告"]
    if job_status in ("failure", "failed", "cancelled"):
        decision = "cancelled" if job_status == "cancelled" else "error"
        blockers.insert(0, "本轮任务已取消" if decision == "cancelled" else "本轮任务失败，发布结果请核对运行详情")
    blockers = list(dict.fromkeys(text(value) for value in blockers if text(value)))[:12]
    summary = {
        "promote": "本轮模型已通过检查并发布。",
        "updated": "本轮模型已直接更新；发布成功不代表通过晋级，评测结果如下。",
        "shadow": "仅发布影子模型，未切换生产模型。",
        "reject": "本轮未通过晋级，生产模型未切换。",
        "skip": "本轮跳过训练或样本尚未成熟。",
        "error": "本轮存在异常，不能视为成功发布。",
        "cancelled": "本轮已取消，未确认发布。",
    }[decision]
    repo = text(env.get("GITHUB_REPOSITORY")) or "anthony67158/Short-term-stock-trading"
    result = {
        "schemaVersion": "quant-retrain-report.v2",
        "at": at,
        "model": model,
        "title": f"{MODEL_LABELS[model]} · 每日重训",
        "decision": decision,
        "summary": summary,
        "body": "\n".join([summary, *(f"{row['label']}：{row['value']}" for row in facts), *blockers]),
        "details": {"facts": facts, "metrics": metrics, "blockers": blockers},
        "meta": {
            "model": model,
            "runId": run_id,
            "runNumber": int(env.get("GITHUB_RUN_NUMBER") or 0),
            "runAttempt": int(env.get("GITHUB_RUN_ATTEMPT") or 1),
            "event": text(env.get("GITHUB_EVENT_NAME")),
            "workflowStatus": job_status,
            "workflowUrl": f"https://github.com/{repo}/actions/runs/{run_id}",
            "headSha": text(env.get("GITHUB_SHA"))[:12],
            "trainingAt": trained_at,
        },
    }
    return f"quantreport/{model}-{run_id}.json", result


def read_report(path):
    if not path or not Path(path).is_file():
        return None
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (ValueError, OSError):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, choices=tuple(MODEL_LABELS))
    parser.add_argument("--report", required=True)
    parser.add_argument("--promotion")
    args = parser.parse_args()
    key, report = build_report(args.model, read_report(args.report), read_report(args.promotion))
    from upload_model import bucket

    bucket().put_object(key, json.dumps(
        report, ensure_ascii=False, allow_nan=False, separators=(",", ":"),
    ).encode("utf-8"), headers={"Content-Type": "application/json", "Cache-Control": "no-cache"})
    print(f"[quant-report] published {key}")


if __name__ == "__main__":
    main()
