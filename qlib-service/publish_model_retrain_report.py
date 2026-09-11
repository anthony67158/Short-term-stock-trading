"""Publish V3 and sector retraining outcomes to the existing quant inbox."""

import argparse
import json
import math
import os
import time
from pathlib import Path


MODEL_LABELS = {"opportunity": "V3 机会模型", "sector": "板块模型"}
COMPONENT_LABELS = {
    "fillProbability": "成交概率",
    "winProbability": "盈利概率",
    "payoff": "胜负幅度",
    "tailRisk": "尾部风险",
    "ranking": "横截面排序",
}
DECISIONS = {
    "promote": "已发布",
    "hold": "维持现役",
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


def ensemble_window_note(ensemble):
    folds = ensemble.get("folds") or []
    latest = max(
        (fold for fold in folds if isinstance(fold, dict)),
        key=lambda fold: str(fold.get("validationEndDate") or ""),
        default=None,
    )
    if not latest:
        return ""
    mean = number(latest.get("meanNetRAt5"))
    lower = number(latest.get("netRLowerBound"))
    if mean is None or lower is None:
        return ""
    period = " 至 ".join(filter(None, (
        text(latest.get("validationStartDate")),
        text(latest.get("validationEndDate")),
    )))
    prefix = f"最新独立窗口（{period}）" if period else "最新独立窗口"
    return (
        f"{prefix} Top5费后净R {mean:+.3f}R，"
        f"下置信界 {lower:+.3f}R"
    )


def metric_row(
    label,
    challenger,
    baseline=None,
    unit="number",
    *,
    selected=None,
):
    return {
        "label": label,
        "challenger": number(challenger),
        "baseline": number(baseline),
        "champion": number(baseline),
        "selected": number(selected),
        "unit": unit,
    }


def nested_metric(value, *path):
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def selective_release_details(report, release, env):
    readiness = report.get("readiness") or {}
    split = report.get("split") or {}
    evaluations = release.get("evaluation") or {}
    champion = evaluations.get("champion") or {}
    challenger = evaluations.get("challenger") or {}
    selected = evaluations.get("selected") or {}
    action = release.get("action")
    published = (
        action == "PUBLISH"
        and release.get("eligible") is True
        and env.get("RETRAIN_PUBLISHED") == "true"
    )
    decision = (
        "promote"
        if published
        else "error"
        if action == "PUBLISH"
        else "hold"
    )
    promoted = [
        COMPONENT_LABELS.get(value, text(value))
        for value in release.get("promotedComponents") or []
    ]
    facts = [
        {"label": "成熟样本", "value": display(readiness.get("samples"))},
        {
            "label": "完整成交样本",
            "value": display(readiness.get("filled_samples")),
        },
        {"label": "独立交易日", "value": display(readiness.get("dates"))},
        {
            "label": "训练截止",
            "value": text(split.get("train_end_date")) or "未提供",
        },
        {
            "label": "生产对照版本",
            "value": text(release.get("championVersion")) or "未提供",
        },
        {
            "label": "训练候选版本",
            "value": text(release.get("challengerVersion")) or "未提供",
        },
        {
            "label": "发布版本",
            "value": (
                text(release.get("selectedVersion"))
                if published
                else text(release.get("championVersion"))
            ) or "未提供",
        },
        {
            "label": "晋级方式",
            "value": {
                "FULL": "整包晋级",
                "PARTIAL": "组成部分选择性晋级",
                "NONE": "维持现役",
            }.get(release.get("releaseMode"), "维持现役"),
        },
        {
            "label": "晋级组成",
            "value": "、".join(promoted) if promoted else "无",
        },
        {
            "label": "组合验证",
            "value": (
                f"{int(release.get('compatibleCombinations') or 0)}/"
                f"{int(release.get('combinationsEvaluated') or 0)} 组通过"
            ),
        },
    ]
    metric_paths = (
        ("Top5费后净R", ("business", "mean_net_r_at_5"), "r"),
        ("Top5净R下置信界", ("business", "netRLowerBound"), "r"),
        ("Top5正净R命中率", ("business", "precision_at_5"), "percent"),
        ("Top5最大回撤", ("business", "max_drawdown_r_at_5"), "r"),
        ("正期望覆盖率", ("business", "positiveExpectedCoverage"), "percent"),
        ("成交概率准确率", ("pFill", "accuracy"), "percent"),
        ("成交概率召回率", ("pFill", "recall"), "percent"),
        ("成交概率F1", ("pFill", "f1"), "percent"),
        ("成交概率Brier", ("pFill", "brier"), "number"),
        ("盈利概率准确率", ("pWinGivenFill", "accuracy"), "percent"),
        ("盈利概率召回率", ("pWinGivenFill", "recall"), "percent"),
        ("盈利概率F1", ("pWinGivenFill", "f1"), "percent"),
        ("盈利概率Brier", ("pWinGivenFill", "brier"), "number"),
        ("净R平均绝对误差", ("expectedNetR", "mae"), "r"),
        ("Q10覆盖率", ("tailRisk", "q10Coverage"), "percent"),
        ("千条推理耗时", ("inference", "msPer1000"), "ms"),
    )
    metrics = [
        metric_row(
            label,
            nested_metric(challenger, *path),
            nested_metric(champion, *path),
            unit,
            selected=nested_metric(selected, *path),
        )
        for label, path, unit in metric_paths
    ]
    components = []
    for item in release.get("componentDecisions") or []:
        if not isinstance(item, dict):
            continue
        components.append({
            "component": text(item.get("component")),
            "label": (
                text(item.get("label"))
                or COMPONENT_LABELS.get(item.get("component"), "模型组成")
            ),
            "status": text(item.get("status")) or "UNCHANGED",
            "improvements": [
                text(value)
                for value in item.get("improvements") or []
                if text(value)
            ][:6],
            "blockers": [
                text(value)
                for value in item.get("blockers") or []
                if text(value)
            ][:6],
            "metrics": [
                {
                    "label": text(metric.get("label")),
                    "challenger": number(metric.get("challenger")),
                    "champion": number(metric.get("champion")),
                    "delta": number(metric.get("delta")),
                    "lowerIsBetter":
                        metric.get("lowerIsBetter") is True,
                }
                for metric in item.get("metrics") or []
                if isinstance(metric, dict)
            ][:8],
        })
    blockers = [
        *(
            (release.get("compatibility") or {}).get("blockers")
            or []
        ),
    ]
    if action == "PUBLISH" and not published:
        blockers.insert(0, "选择性发布已通过，但生产清单未确认更新")
    return (
        decision,
        facts,
        metrics,
        [text(value) for value in blockers if text(value)][:12],
        milliseconds(report.get("generatedAt")),
        {
            "components": components,
            "thresholds": release.get("thresholds") or {},
            "deployment": {
                "action": action,
                "published": published,
                "releaseMode": release.get("releaseMode"),
                "championVersion": release.get("championVersion"),
                "challengerVersion": release.get("challengerVersion"),
                "selectedVersion": release.get("selectedVersion"),
                "promotedComponents":
                    release.get("promotedComponents") or [],
            },
        },
    )


def opportunity_details(report, promotion, env):
    if (
        promotion.get("schemaVersion")
        == "opportunity-selective-release.v1"
    ):
        return selective_release_details(report, promotion, env)
    readiness = report.get("readiness") or {}
    split = report.get("split") or {}
    ranking = (report.get("metrics") or {}).get("ranking") or {}
    candidate = ranking.get("challenger") or {}
    action_value = ranking.get("actionValue") or {}
    ranker = ranking.get("ranker") or {}
    baseline = ranking.get("baseline") or {}
    quantile = (report.get("metrics") or {}).get("quantile10") or {}
    walk = report.get("walkForward") or {}
    ensemble = report.get("seedEnsemble") or {}
    ensemble_aggregate = ensemble.get("aggregate") or {}
    ensemble_decision = ensemble.get("decision") or {}
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
    blockers = [*(readiness.get("blockers") or [])]
    if not ensemble:
        blockers.extend(report.get("shadowBlockers") or [])
        blockers.extend(promotion.get("blockers") or [])
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
        {
            "label": "模型组合",
            "value": (
                "三种子 LightGBM 动作价值 + CatBoost 排序集成"
                if ensemble
                else "LightGBM 动作价值 + CatBoost 排序"
            ),
        },
    ]
    metrics = [
        metric_row(
            "当前组合 Top5 费后净R",
            ensemble_aggregate.get("top5MeanNetR")
            if ensemble_aggregate
            else candidate.get("mean_net_r_at_5"),
            baseline.get("mean_net_r_at_5"),
            "r",
        ),
        metric_row(
            "当前组合 Top5 净R下置信界",
            ensemble_aggregate.get("top5LowerBound")
            if ensemble_aggregate
            else candidate.get("netRLowerBound"),
            unit="r",
        ),
        metric_row("动作价值 Top5 费后净R",
                   action_value.get("mean_net_r_at_5"), unit="r"),
        metric_row("CatBoost Top5 费后净R",
                   ranker.get("mean_net_r_at_5"), unit="r"),
        metric_row("Q10 覆盖率", quantile.get("coverage"), unit="percent"),
    ]
    if ensemble_aggregate:
        metrics.append(metric_row(
            "当前组合正期望覆盖率",
            ensemble_aggregate.get("positiveExpectedCoverage"),
            unit="percent",
        ))
    else:
        metrics.extend([
            metric_row("Top5 最大回撤", candidate.get("max_drawdown_r_at_5"),
                       baseline.get("max_drawdown_r_at_5"), "r"),
            metric_row("Top5 正净R信号占比", candidate.get("precision_at_5"),
                       baseline.get("precision_at_5"), "percent"),
        ])
    if ensemble and ensemble_decision.get("eligible") is not True:
        blockers.append(
            ensemble_window_note(ensemble)
            or text(ensemble_decision.get("reason"))
            or "三种子集成仍存在未通过的独立窗口"
        )
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
    return (
        decision,
        facts,
        metrics,
        blockers,
        milliseconds(report.get("generatedAt")),
        {},
    )


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
    return (
        decision,
        facts,
        metrics,
        blockers,
        milliseconds(meta.get("trained_at")),
        {},
    )


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
        (
            decision,
            facts,
            metrics,
            blockers,
            trained_at,
            extra_details,
        ) = builder(report, promotion or {}, env)
    else:
        skipped = job_status == "success" and env.get("RETRAIN_PREFLIGHT") == "skip"
        decision = "skip" if skipped else "error"
        facts, metrics, trained_at, extra_details = [], [], None, {}
        blockers = ["行情数据源不可达，本次跳过"] if skipped else ["本轮未生成完整训练报告"]
    if job_status in ("failure", "failed", "cancelled"):
        decision = "cancelled" if job_status == "cancelled" else "error"
        blockers.insert(0, "本轮任务已取消" if decision == "cancelled" else "本轮任务失败，发布结果请核对运行详情")
    blockers = list(dict.fromkeys(text(value) for value in blockers if text(value)))[:12]
    summary = {
        "promote": "本轮模型已通过检查并发布。",
        "hold": "本轮没有形成更优且兼容的组合，继续使用现役版本。",
        "updated": "本轮模型已直接更新；发布成功不代表通过晋级，评测结果如下。",
        "shadow": "仅发布影子模型，未切换生产模型。",
        "reject": "本轮未通过晋级，生产模型未切换。",
        "skip": "本轮跳过训练或样本尚未成熟。",
        "error": "本轮存在异常，不能视为成功发布。",
        "cancelled": "本轮已取消，未确认发布。",
    }[decision]
    repo = text(env.get("GITHUB_REPOSITORY")) or "anthony67158/Short-term-stock-trading"
    result = {
        "schemaVersion": "quant-retrain-report.v3",
        "at": at,
        "model": model,
        "title": f"{MODEL_LABELS[model]} · 每日重训",
        "decision": decision,
        "summary": summary,
        "body": "\n".join([summary, *(f"{row['label']}：{row['value']}" for row in facts), *blockers]),
        "details": {
            "facts": facts,
            "metrics": metrics,
            "blockers": blockers,
            **extra_details,
        },
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
