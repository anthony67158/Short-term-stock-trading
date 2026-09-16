import hashlib
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.config import settings
from platform_app.contracts.base import utcnow
from platform_app.modules.identity.models import User
from platform_app.modules.experiments.models import StrategyVersion
from platform_app.modules.learning.models import (
    ProspectiveOutcome,
    ProspectiveSample,
)
from platform_app.modules.operations.models import Job
from platform_app.modules.review.contracts import (
    REVIEW_PROTOCOL_VERSION,
    FailureCluster,
    ImprovementProposalView,
    ReviewCapability,
    ReviewMetric,
    ReviewMetricSnapshot,
    ReviewReportPage,
    ReviewReportView,
    ReviewRunInput,
    StrategyCompilationInput,
)
from platform_app.modules.review.models import (
    ImprovementProposal,
    ReviewReport,
)
from platform_app.modules.review.strategy_agent import allowed_parameters


class ReviewError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        self.code, self.message, self.status = code, message, status


def capability() -> ReviewCapability:
    config = settings()
    available = config.agent_enabled and bool(
        config.agent_api_key.get_secret_value()
    )
    return ReviewCapability(
        available=available,
        model=config.agent_model,
        reason=(
            None
            if available
            else "复盘推理服务尚未启用；结构化结果仍会继续结算"
        ),
    )


def _return(value: object) -> Decimal:
    if not isinstance(value, str):
        raise ReviewError(
            "REVIEW_OUTCOME_INVALID",
            "成熟结果的收益合同不完整",
        )
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise ReviewError(
            "REVIEW_OUTCOME_INVALID",
            "成熟结果包含非法收益",
        ) from exc
    if not parsed.is_finite():
        raise ReviewError(
            "REVIEW_OUTCOME_INVALID",
            "成熟结果包含非法收益",
        )
    return parsed


def _decimal_text(value: Decimal) -> str:
    rendered = format(value.quantize(Decimal("0.00000001")), "f")
    return "0.00000000" if rendered == "-0.00000000" else rendered


def _selected_action(sample: ProspectiveSample) -> str:
    action = sample.scenario.get("selectedAction")
    if action in {"NONE", "WAIT"}:
        return "HOLD"
    if action not in {"HOLD", "ADD", "REDUCE", "EXIT"}:
        raise ReviewError(
            "REVIEW_SAMPLE_INVALID",
            "成熟样本缺少有效联合动作",
        )
    return action


def build_review_snapshot(
    review_date: date,
    matured_rows: list[tuple[ProspectiveSample, ProspectiveOutcome]],
    excluded_rows: list[ProspectiveSample],
) -> ReviewMetricSnapshot:
    selected_returns = []
    underperformed_hold = []
    execution_eligible = []
    clusters: dict[str, dict] = {}
    source_datasets = set()

    def add_cluster(
        cluster_id: str,
        category: str,
        label: str,
        sample_id: str,
        *,
        strategy_failure_eligible: bool,
    ):
        cluster = clusters.setdefault(
            cluster_id,
            {
                "clusterId": cluster_id,
                "category": category,
                "label": label,
                "sampleIds": [],
                "count": 0,
                "strategyFailureEligible": strategy_failure_eligible,
            },
        )
        cluster["count"] += 1
        if len(cluster["sampleIds"]) < 50:
            cluster["sampleIds"].append(sample_id)

    for sample, outcome in matured_rows:
        raw_returns = outcome.simulation_outcome.get("actionNetReturns")
        if not isinstance(raw_returns, dict) or set(raw_returns) != {
            "HOLD",
            "ADD",
            "REDUCE",
            "EXIT",
        }:
            raise ReviewError(
                "REVIEW_OUTCOME_INVALID",
                "成熟结果缺少完整动作反事实",
            )
        returns = {
            action: _return(value)
            for action, value in raw_returns.items()
        }
        selected = _selected_action(sample)
        selected_return = returns[selected]
        selected_returns.append((sample.id, selected_return))
        hold_delta = selected_return - returns["HOLD"]
        if selected_return < 0:
            add_cluster(
                "STRATEGY_NEGATIVE_RETURN",
                "STRATEGY",
                "联合动作费后收益为负",
                sample.id,
                strategy_failure_eligible=True,
            )
        if hold_delta < 0:
            underperformed_hold.append(sample.id)
            add_cluster(
                "ACTION_UNDERPERFORMED_HOLD",
                "STRATEGY",
                "联合动作弱于同期持有基线",
                sample.id,
                strategy_failure_eligible=True,
            )
        best_action = max(
            ("HOLD", "REDUCE", "EXIT", "ADD"),
            key=lambda action: (
                returns[action],
                -("HOLD", "REDUCE", "EXIT", "ADD").index(action),
            ),
        )
        if selected != best_action:
            add_cluster(
                "ACTION_NOT_EX_POST_BEST",
                "STRATEGY",
                "联合动作不是事后最优动作",
                sample.id,
                strategy_failure_eligible=True,
            )
        if (
            selected_return < 0
            and sample.agent_features.get("uncertaintyCount", 0) > 0
        ):
            add_cluster(
                "UNCERTAINTY_WITH_NEGATIVE_RETURN",
                "STRATEGY",
                "Agent存在不确定性且联合动作收益为负",
                sample.id,
                strategy_failure_eligible=True,
            )
        actual = outcome.actual_execution_outcome
        actual_evaluation = outcome.attribution.get(
            "actualExecutionEvaluation",
            {},
        )
        actual_status = actual.get("status")
        if actual_status == "NOT_EXECUTED":
            add_cluster(
                "USER_NOT_EXECUTED",
                "EXECUTION",
                "用户未创建计划或未录入成交",
                sample.id,
                strategy_failure_eligible=False,
            )
        if actual_status in {"EXECUTED", "NO_TRADE_REQUIRED"}:
            execution_eligible.append(sample.id)
        execution_reason = actual_evaluation.get("reason")
        if execution_reason in {"PARTIAL_EXECUTION", "OVER_EXECUTION"}:
            add_cluster(
                execution_reason,
                "EXECUTION",
                (
                    "真实成交未完成计划数量"
                    if execution_reason == "PARTIAL_EXECUTION"
                    else "真实成交超过计划数量"
                ),
                sample.id,
                strategy_failure_eligible=False,
            )
        execution_delta = actual_evaluation.get(
            "executionDeltaVsSelectedAction"
        )
        if execution_delta is not None and _return(execution_delta) < 0:
            add_cluster(
                "EXECUTION_DRAG",
                "EXECUTION",
                "真实执行结果弱于同动作模拟结果",
                sample.id,
                strategy_failure_eligible=False,
            )
        source_datasets.add(outcome.source_dataset_id)

    for sample in excluded_rows:
        reason = sample.exclusion_reason or "UNKNOWN"
        add_cluster(
            f"DATA_{reason}",
            "DATA",
            f"样本因数据质量被排除：{reason}",
            sample.id,
            strategy_failure_eligible=False,
        )

    selected_ids = [sample_id for sample_id, _value in selected_returns]
    mean_return = (
        sum((value for _sample_id, value in selected_returns), Decimal(0))
        / len(selected_returns)
        if selected_returns
        else Decimal(0)
    )
    metrics = [
        ReviewMetric(
            metric_id="matured-samples",
            label="成熟样本",
            value=str(len(matured_rows)),
            unit="COUNT",
            source_sample_ids=selected_ids[:50],
        ),
        ReviewMetric(
            metric_id="excluded-samples",
            label="排除样本",
            value=str(len(excluded_rows)),
            unit="COUNT",
            source_sample_ids=[
                sample.id for sample in excluded_rows[:50]
            ],
        ),
        ReviewMetric(
            metric_id="mean-selected-net-return",
            label="联合动作平均费后收益",
            value=_decimal_text(mean_return),
            unit="RETURN",
            source_sample_ids=selected_ids[:50],
        ),
        ReviewMetric(
            metric_id="underperformed-hold-rate",
            label="弱于持有基线占比",
            value=_decimal_text(
                Decimal(len(underperformed_hold))
                / len(matured_rows)
                if matured_rows
                else Decimal(0)
            ),
            unit="RATE",
            source_sample_ids=underperformed_hold[:50],
        ),
        ReviewMetric(
            metric_id="execution-eligible-rate",
            label="可评估真实执行占比",
            value=_decimal_text(
                Decimal(len(execution_eligible))
                / len(matured_rows)
                if matured_rows
                else Decimal(0)
            ),
            unit="RATE",
            source_sample_ids=execution_eligible[:50],
        ),
    ]
    failure_clusters = [
        FailureCluster(
            cluster_id=cluster["clusterId"],
            category=cluster["category"],
            label=cluster["label"],
            sample_count=cluster["count"],
            strategy_failure_eligible=cluster[
                "strategyFailureEligible"
            ],
            source_sample_ids=cluster["sampleIds"],
        )
        for cluster in sorted(
            clusters.values(),
            key=lambda value: (
                {"STRATEGY": 0, "EXECUTION": 1, "DATA": 2}[
                    value["category"]
                ],
                -value["count"],
                value["clusterId"],
            ),
        )
    ]
    return ReviewMetricSnapshot(
        review_date=review_date,
        matured_samples=len(matured_rows),
        excluded_samples=len(excluded_rows),
        source_dataset_ids=sorted(source_datasets),
        metrics=metrics,
        failure_clusters=failure_clusters,
    )


def _snapshot(db, owner_id: str, review_date: date) -> ReviewMetricSnapshot:
    matured_rows = list(
        db.execute(
            select(ProspectiveSample, ProspectiveOutcome)
            .join(
                ProspectiveOutcome,
                ProspectiveOutcome.sample_id == ProspectiveSample.id,
            )
            .where(
                ProspectiveSample.owner_id == owner_id,
                ProspectiveSample.horizon_end_date == review_date,
                ProspectiveSample.status == "MATURED",
            )
            .order_by(ProspectiveSample.id)
        )
    )
    excluded_rows = list(
        db.scalars(
            select(ProspectiveSample)
            .where(
                ProspectiveSample.owner_id == owner_id,
                ProspectiveSample.horizon_end_date == review_date,
                ProspectiveSample.status == "EXCLUDED",
            )
            .order_by(ProspectiveSample.id)
        )
    )
    if not matured_rows and not excluded_rows:
        raise ReviewError(
            "REVIEW_DATA_UNAVAILABLE",
            "该日期没有已成熟或已排除的前瞻样本",
            409,
        )
    return build_review_snapshot(
        review_date,
        matured_rows,
        excluded_rows,
    )


def submit_review(
    owner_id: str,
    body: ReviewRunInput,
    key: str,
) -> Job:
    config = settings()
    now = utcnow()
    if body.review_date > now.astimezone(
        ZoneInfo("Asia/Shanghai")
    ).date():
        raise ReviewError(
            "REVIEW_DATE_IN_FUTURE",
            "复盘日期不能晚于当前日期",
        )
    current_capability = capability()
    if not current_capability.available:
        raise ReviewError(
            "AGENT_UNAVAILABLE",
            current_capability.reason,
            503,
        )
    request_hash = hashlib.sha256(
        body.model_dump_json().encode()
    ).hexdigest()
    with sessions().begin() as db:
        db.execute(select(func.pg_advisory_xact_lock(618051019)))
        db.scalar(select(User).where(User.id == owner_id).with_for_update())
        existing = db.scalar(
            select(Job).where(
                Job.owner_id == owner_id,
                Job.kind == "DAILY_REVIEW",
                Job.business_key == key,
            )
        )
        if existing:
            if existing.input_hash != request_hash:
                raise ReviewError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一请求编号对应不同复盘",
                    409,
                )
            return existing
        published = db.scalar(
            select(ReviewReport).where(
                ReviewReport.owner_id == owner_id,
                ReviewReport.review_date == body.review_date,
            )
        )
        if published:
            return db.get(Job, published.job_id)
        recent = db.scalar(
            select(func.count())
            .select_from(Job)
            .where(
                Job.owner_id == owner_id,
                Job.kind.in_(["RESEARCH", "DAILY_REVIEW"]),
                Job.created_at >= now - timedelta(hours=24),
            )
        )
        if recent >= config.agent_daily_call_limit:
            raise ReviewError(
                "REVIEW_BUDGET_EXCEEDED",
                "已达到24小时Agent调用上限",
                429,
            )
        total = db.scalar(
            select(func.count())
            .select_from(Job)
            .where(
                Job.kind.in_(["RESEARCH", "DAILY_REVIEW"]),
                Job.created_at >= now - timedelta(hours=24),
            )
        )
        if total >= config.agent_global_daily_call_limit:
            raise ReviewError(
                "REVIEW_BUDGET_EXCEEDED",
                "平台24小时Agent调用预算已用尽",
                429,
            )
        snapshot = _snapshot(db, owner_id, body.review_date)
        payload = {
            "request": body.model_dump(mode="json"),
            "metricSnapshot": snapshot.model_dump(mode="json"),
            "protocolVersion": REVIEW_PROTOCOL_VERSION,
            "model": config.agent_model,
            "asOf": now.isoformat(),
            "deadline": (now + timedelta(minutes=5)).isoformat(),
        }
        job = Job(
            owner_id=owner_id,
            kind="DAILY_REVIEW",
            business_key=key,
            input_hash=request_hash,
            priority=30,
            payload=payload,
        )
        db.add(job)
        db.flush()
        return job


def _report_view(db, report: ReviewReport) -> ReviewReportView:
    proposals = list(
        db.scalars(
            select(ImprovementProposal)
            .where(
                ImprovementProposal.review_report_id == report.id,
            )
            .order_by(ImprovementProposal.created_at, ImprovementProposal.id)
        )
    )
    return ReviewReportView(
        id=report.id,
        job_id=report.job_id,
        review_date=report.review_date,
        protocol_version=report.protocol_version,
        model_id=report.model_id,
        metric_snapshot=report.metric_snapshot,
        output=report.output,
        proposals=[
            ImprovementProposalView.model_validate(row)
            for row in proposals
        ],
        created_at=report.created_at,
    )


def reports(owner_id: str, limit: int) -> ReviewReportPage:
    with sessions()() as db:
        rows = list(
            db.scalars(
                select(ReviewReport)
                .where(ReviewReport.owner_id == owner_id)
                .order_by(
                    ReviewReport.review_date.desc(),
                    ReviewReport.id.desc(),
                )
                .limit(limit)
            )
        )
        return ReviewReportPage(
            reports=[_report_view(db, row) for row in rows]
        )


def submit_strategy_compilation(
    owner_id: str,
    proposal_id: str,
    body: StrategyCompilationInput,
    key: str,
) -> Job:
    config = settings()
    now = utcnow()
    if not capability().available:
        raise ReviewError(
            "AGENT_UNAVAILABLE",
            "策略推理服务尚未启用",
            503,
        )
    request_hash = hashlib.sha256(
        (
            proposal_id
            + "\0"
            + body.model_dump_json(exclude_none=True)
        ).encode()
    ).hexdigest()
    with sessions().begin() as db:
        db.execute(select(func.pg_advisory_xact_lock(618051020)))
        db.scalar(select(User).where(User.id == owner_id).with_for_update())
        existing = db.scalar(
            select(Job).where(
                Job.owner_id == owner_id,
                Job.kind == "STRATEGY_PROPOSAL",
                Job.business_key == key,
            )
        )
        if existing:
            if existing.input_hash != request_hash:
                raise ReviewError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一请求编号对应不同实验提案",
                    409,
                )
            return existing
        proposal = db.scalar(
            select(ImprovementProposal)
            .where(
                ImprovementProposal.id == proposal_id,
                ImprovementProposal.owner_id == owner_id,
            )
            .with_for_update()
        )
        if proposal is None:
            raise ReviewError(
                "IMPROVEMENT_PROPOSAL_NOT_FOUND",
                "改进提案不存在或无权访问",
                404,
            )
        if proposal.status != "DRAFT":
            raise ReviewError(
                "IMPROVEMENT_PROPOSAL_TERMINAL",
                "改进提案已经编译或拒绝",
                409,
            )
        strategy_query = select(StrategyVersion).where(
            StrategyVersion.owner_id == owner_id,
            StrategyVersion.status.in_(["FROZEN", "EVALUATED"]),
        )
        if body.base_strategy_version_id:
            strategy_query = strategy_query.where(
                StrategyVersion.id
                == body.base_strategy_version_id
            )
        strategy = db.scalar(
            strategy_query.order_by(
                StrategyVersion.version.desc(),
                StrategyVersion.id.desc(),
            ).limit(1)
        )
        if strategy is None:
            raise ReviewError(
                "BASE_STRATEGY_NOT_FOUND",
                "没有可用于实验的冻结基线策略",
                409,
            )
        allowed = allowed_parameters(
            proposal.change_type,
            proposal.direction,
        )
        if not allowed:
            raise ReviewError(
                "PROPOSAL_PARAMETER_UNSUPPORTED",
                "当前提案方向没有已注册的安全实验参数",
                422,
            )
        recent = db.scalar(
            select(func.count())
            .select_from(Job)
            .where(
                Job.owner_id == owner_id,
                Job.kind.in_(
                    ["RESEARCH", "DAILY_REVIEW", "STRATEGY_PROPOSAL"]
                ),
                Job.created_at >= now - timedelta(hours=24),
            )
        )
        if recent >= config.agent_daily_call_limit:
            raise ReviewError(
                "STRATEGY_AGENT_BUDGET_EXCEEDED",
                "已达到24小时Agent调用上限",
                429,
            )
        payload = {
            "proposal": {
                "proposalId": proposal.id,
                "title": proposal.title,
                "hypothesis": proposal.hypothesis,
                "changeType": proposal.change_type,
                "direction": proposal.direction,
                "sourceSampleIds": proposal.source_sample_ids,
            },
            "baseStrategy": {
                "id": strategy.id,
                "strategyKey": strategy.strategy_key,
                "version": strategy.version,
                "config": strategy.config,
            },
            "allowedParameters": allowed,
            "protocolVersion": "strategy-agent.v1",
            "model": config.agent_model,
            "asOf": now.isoformat(),
            "deadline": (now + timedelta(minutes=5)).isoformat(),
        }
        job = Job(
            owner_id=owner_id,
            kind="STRATEGY_PROPOSAL",
            business_key=key,
            input_hash=request_hash,
            priority=20,
            payload=payload,
        )
        db.add(job)
        db.flush()
        return job
