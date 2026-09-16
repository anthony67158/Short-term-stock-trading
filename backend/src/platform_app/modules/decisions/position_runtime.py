"""Build audited shadow inputs from sealed features and validated Agent research."""

import hashlib
import json
import math
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_FLOOR
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.config import Settings
from platform_app.kernel.calendar import scheduled_day
from platform_app.modules.decisions.position_contracts import (
    ActionValueEstimate,
    PositionAssessment,
    PositionDecisionRequest,
    PositionEvidenceSignal,
    PositionValueReference,
)
from platform_app.modules.experiments.cash_equity_fees import (
    CASH_EQUITY_FEE_POLICY,
    calculate_cash_equity_fees,
)
from platform_app.modules.experiments.daily_ranking_sample import (
    HISTORY_SESSIONS,
    build_daily_ranking_features,
)
from platform_app.modules.experiments.joint_bundle import JointBundle
from platform_app.modules.experiments.market_dataset import _database_sha256
from platform_app.modules.experiments.position_action_model import (
    FEATURE_NAMES,
    PositionActionBundle,
)
from platform_app.modules.experiments.ranking_model_bundle import RankingModelBundle
from platform_app.modules.experiments.ranking_model_trainer import (
    RAW_COLUMNS,
    _date_features,
    _verified_ranking_database,
)
from platform_app.modules.experiments.ranking_dataset import FEATURE_COLUMNS
from platform_app.modules.research.contracts import AssessmentOutput
from platform_app.modules.research.models import Assessment, Evidence

RUNTIME_FEATURE_POLICY_VERSION = "position-runtime-features.v1"


class PositionRuntimeError(ValueError):
    pass


@lru_cache(maxsize=4)
def _verified_artifacts(
    pointer_path: str,
    pointer_mtime_ns: int,
    ranking_model_root: str,
    position_model_root: str,
    ranking_dataset_root: str,
    market_dataset_root: str,
):
    del pointer_mtime_ns
    release_manifest = JointBundle(
        Path(pointer_path),
        require_ready=False,
    ).manifest
    ranking = RankingModelBundle(
        Path(ranking_model_root),
        require_ready=False,
    )
    position = PositionActionBundle(
        Path(position_model_root),
        require_ready=False,
    )
    ranking_manifest, _ = _verified_ranking_database(
        Path(ranking_dataset_root)
    )
    market_root = Path(market_dataset_root)
    try:
        market_manifest = json.loads(
            (market_root / "manifest.json").read_text()
        )
        market_path = market_root / market_manifest["database"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise PositionRuntimeError("POSITION_RUNTIME_MARKET_DATASET_INVALID") from exc
    if (
        market_manifest.get("schemaVersion") != "market-dataset.v4"
        or not market_path.is_file()
        or _database_sha256(market_path)
        != market_manifest.get("databaseSha256")
        or market_manifest.get("databaseSha256")
        != ranking_manifest.get("marketDatabaseSha256")
    ):
        raise PositionRuntimeError("POSITION_RUNTIME_MARKET_DATASET_INVALID")
    return (
        release_manifest,
        ranking,
        position,
        ranking_manifest,
        market_manifest,
        market_path,
    )


@lru_cache(maxsize=8)
def _sealed_feature_snapshot(
    market_path: str,
    decision_date: str,
    causal_cutoff: str,
):
    with sqlite3.connect(
        f"{Path(market_path).resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    ) as market:
        market.row_factory = sqlite3.Row
        rows, prices, available, terminal_date = _current_feature_rows(
            market,
            decision_date,
            datetime.fromisoformat(causal_cutoff),
        )
    feature_matrix, _ = _date_features(rows)
    return rows, prices, available, terminal_date, feature_matrix


def _fees(action: str, shares: int, price: Decimal, board: str, trade_date: str):
    if action == "HOLD" or shares == 0:
        return "0"
    side = "BUY" if action == "ADD" else "SELL"
    return calculate_cash_equity_fees(
        side=side,
        gross_amount=price * shares,
        board=board,
        trade_date=trade_date,
    )["totalCny"]


def _targets(current: int, sellable: int, capacity: int) -> dict[str, int]:
    if current < 2:
        raise PositionRuntimeError("POSITION_QUANTITY_TOO_SMALL_FOR_ACTION_VECTOR")
    lot = 100
    add_shares = max(
        lot,
        min(max(capacity, lot), max(lot, current // lot * lot)),
    )
    reduce_shares = min(sellable, max(1, current // 2))
    reduce_target = max(1, current - reduce_shares)
    return {
        "HOLD": current,
        "ADD": current + add_shares,
        "REDUCE": reduce_target,
        "EXIT": 0,
    }


def _current_feature_rows(market, decision_date: str, as_of: datetime):
    open_dates = [
        row[0]
        for row in market.execute(
            "SELECT cal_date FROM trade_calendar "
            "WHERE exchange = 'SSE' AND is_open = 1 AND cal_date <= ? "
            "ORDER BY cal_date DESC LIMIT ?",
            (decision_date, HISTORY_SESSIONS),
        )
    ][::-1]
    if len(open_dates) != HISTORY_SESSIONS:
        raise PositionRuntimeError("POSITION_RUNTIME_HISTORY_INCOMPLETE")
    future_dates = [
        row[0]
        for row in market.execute(
            "SELECT cal_date FROM trade_calendar "
            "WHERE exchange = 'SSE' AND is_open = 1 AND cal_date > ? "
            "ORDER BY cal_date LIMIT 5",
            (decision_date,),
        )
    ]
    candidate = datetime.strptime(decision_date, "%Y%m%d").date()
    while len(future_dates) < 5:
        candidate += timedelta(days=1)
        status = scheduled_day("SH", candidate, as_of=as_of)
        if status.is_trading_day is None:
            raise PositionRuntimeError("POSITION_RUNTIME_HORIZON_UNAVAILABLE")
        rendered = candidate.strftime("%Y%m%d")
        if status.is_trading_day and rendered not in future_dates:
            future_dates.append(rendered)
    bars = defaultdict(dict)
    for row in market.execute(
        "SELECT d.instrument_id,d.trade_date,d.open,d.high,d.low,d.close,"
        "d.previous_close,d.amount_cny,d.available_at AS daily_available_at,"
        "a.factor,a.available_at AS factor_available_at "
        "FROM daily_bars d JOIN adjustment_factors a "
        "ON a.instrument_id=d.instrument_id AND a.trade_date=d.trade_date "
        "WHERE d.trade_date BETWEEN ? AND ?",
        (open_dates[0], open_dates[-1]),
    ):
        bars[row["instrument_id"]][row["trade_date"]] = dict(row)
    rows = []
    prices = {}
    feature_available = {}
    decision_day = datetime.strptime(decision_date, "%Y%m%d").date()
    instruments = market.execute(
        "SELECT instrument_id,board,list_date,delist_date FROM instruments "
        "WHERE list_date <= ? AND (delist_date IS NULL OR delist_date > ?) "
        "AND board IN ('MAIN','CHINEXT','STAR','BEIJING') "
        "ORDER BY board,instrument_id",
        (decision_date, decision_date),
    )
    for instrument in instruments:
        history_by_date = bars.get(instrument["instrument_id"], {})
        history = [history_by_date.get(value) for value in open_dates]
        if any(value is None for value in history):
            continue
        try:
            result = build_daily_ranking_features(
                history=history,
                listing_age_days=(
                    decision_day
                    - datetime.strptime(
                        instrument["list_date"],
                        "%Y%m%d",
                    ).date()
                ).days
                + 1,
            )
            available_at = datetime.fromisoformat(result["featureAvailableAt"])
        except (TypeError, ValueError):
            continue
        if available_at.tzinfo is None or available_at > as_of:
            continue
        features = result["features"]
        rows.append(
            {
                "instrument_id": instrument["instrument_id"],
                "board": instrument["board"],
                **{
                    raw: features[contract]
                    for raw, contract in zip(
                        RAW_COLUMNS,
                        FEATURE_COLUMNS,
                        strict=True,
                    )
                },
                "forward_return_next_open_5": "0",
            }
        )
        prices[instrument["instrument_id"]] = history[-1]["close"]
        feature_available[instrument["instrument_id"]] = available_at
    return rows, prices, feature_available, future_dates[-1]


def build_position_value_reference(
    request: PositionDecisionRequest,
    config: Settings,
) -> PositionValueReference:
    pointer = config.joint_bundle_root.expanduser().resolve()
    (
        release_manifest,
        ranking,
        position,
        ranking_manifest,
        market_manifest,
        market_path,
    ) = _verified_artifacts(
        str(pointer),
        pointer.stat().st_mtime_ns,
        str(config.ranking_model_root.expanduser().resolve()),
        str(config.position_model_root.expanduser().resolve()),
        str(config.ranking_dataset_root.expanduser().resolve()),
        str(config.market_dataset_root.expanduser().resolve()),
    )
    components = release_manifest["components"]
    if (
        ranking.manifest["bundleId"] != components["rankingModelBundleId"]
        or ranking.manifest["artifactSha256"]
        != components["rankingModelArtifactSha256"]
        or ranking.manifest["bundleId"]
        != request.release.ranking_model_bundle_id
        or ranking.manifest["artifactSha256"]
        != request.release.ranking_model_artifact_sha256
        or components["quantModelBundleId"]
        != request.release.quant_model_bundle_id
        or components["quantModelArtifactSha256"]
        != request.release.quant_model_artifact_sha256
        or position.manifest["bundleId"] != components["positionModelBundleId"]
        or position.manifest["artifactSha256"]
        != components["positionModelArtifactSha256"]
        or position.manifest["artifactSha256"]
        != request.release.position_model_artifact_sha256
    ):
        raise PositionRuntimeError("POSITION_RUNTIME_RELEASE_MISMATCH")
    if (
        ranking_manifest["databaseSha256"]
        != ranking.manifest["rankingDatabaseSha256"]
        or ranking_manifest["databaseSha256"]
        != position.manifest["rankingDatabaseSha256"]
    ):
        raise PositionRuntimeError("POSITION_RUNTIME_DATASET_MISMATCH")
    local_as_of = request.as_of.astimezone(ZoneInfo("Asia/Shanghai"))
    candidate_date = local_as_of.date()
    if local_as_of.hour < 17:
        candidate_date -= timedelta(days=1)
    with sqlite3.connect(
        f"{market_path.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    ) as market:
        decision_date = market.execute(
            "SELECT MAX(trade_date) FROM daily_bars WHERE trade_date <= ?",
            (candidate_date.strftime("%Y%m%d"),),
        ).fetchone()[0]
    causal_cutoff = (
        local_as_of.replace(hour=17, minute=0, second=0, microsecond=0)
        if candidate_date == local_as_of.date()
        else local_as_of.replace(hour=0, minute=0, second=0, microsecond=0)
    )
    rows, prices, available, terminal_date, feature_matrix = (
        _sealed_feature_snapshot(
            str(market_path),
            decision_date,
            causal_cutoff.isoformat(),
        )
    )
    matching = [
        index
        for index, row in enumerate(rows)
        if row["instrument_id"] == request.constraints.instrument_id
    ]
    if not matching:
        raise PositionRuntimeError("POSITION_RUNTIME_FEATURES_UNAVAILABLE")
    index = matching[0]
    row = rows[index]
    if available[row["instrument_id"]] > request.as_of:
        raise PositionRuntimeError("POSITION_RUNTIME_FEATURES_NOT_CAUSAL")
    rank_prediction = ranking.predict_matrix(feature_matrix[index : index + 1])
    price = Decimal(prices[row["instrument_id"]])
    if price <= 0:
        raise PositionRuntimeError("POSITION_RUNTIME_PRICE_INVALID")
    current = request.constraints.current_quantity_shares
    median_amount = math.expm1(float(feature_matrix[index, 11]))
    estimated_capacity = int(
        (
            Decimal(str(median_amount))
            / price
            * Decimal("0.0125")
            / Decimal(100)
        ).to_integral_value(rounding=ROUND_FLOOR)
    ) * 100
    state = [
        math.log1p(current),
        math.log1p(float(price) * current),
        math.log(
            max(float(price) * current / max(median_amount, 1), 1e-12)
        ),
        estimated_capacity / current,
    ]
    model_values = [*feature_matrix[index], *state]
    if len(model_values) != len(FEATURE_NAMES):
        raise PositionRuntimeError("POSITION_RUNTIME_FEATURE_CONTRACT_MISMATCH")
    predicted = position.predict_matrix([model_values])["deltaReturnVsHold"]
    targets = _targets(
        current,
        request.constraints.sellable_quantity_shares,
        estimated_capacity,
    )
    trend_value = float(rank_prediction["expectedGrossReturn"][0])
    trend = (
        "BULLISH"
        if trend_value > 0.01
        else "BEARISH"
        if trend_value < -0.01
        else "NEUTRAL"
    )
    values = []
    for action in ("HOLD", "ADD", "REDUCE", "EXIT"):
        target = targets[action]
        delta = abs(target - current)
        missing = ["stopHazard", "support"]
        quantiles = {"q10": None, "q50": None, "q90": None}
        if action == "HOLD":
            quantiles = {"q10": 0.0, "q50": 0.0, "q90": 0.0}
        else:
            missing = ["q10", "q50", "q90", *missing]
        values.append(
            ActionValueEstimate(
                action=action,
                target_quantity_shares=target,
                expected_delta_return_vs_hold=float(predicted[action][0]),
                q10_delta_return_vs_hold=quantiles["q10"],
                q50_delta_return_vs_hold=quantiles["q50"],
                q90_delta_return_vs_hold=quantiles["q90"],
                stop_hazard=None,
                support=None,
                missing_prediction_fields=missing,
                execution_path=(
                    None if action == "HOLD" else "SHADOW_MARKET_REFERENCE"
                ),
                price_lower=None if action == "HOLD" else price,
                price_upper=None if action == "HOLD" else price,
                price_basis=(
                    None
                    if action == "HOLD"
                    else f"SEALED_CLOSE:{decision_date}"
                ),
                trigger_conditions=(
                    [] if action == "HOLD" else ["SHADOW_SIMULATION_ONLY"]
                ),
                estimated_costs=_fees(
                    action,
                    delta,
                    price,
                    row["board"],
                    decision_date,
                ),
            )
        )
    return PositionValueReference(
        model_bundle_id=position.manifest["bundleId"],
        model_artifact_sha256=position.manifest["artifactSha256"],
        feature_schema_version=RUNTIME_FEATURE_POLICY_VERSION,
        context_id=request.context_id,
        account_id=request.constraints.account_id,
        account_version=request.constraints.account_version,
        instrument_id=request.constraints.instrument_id,
        as_of=request.as_of,
        valid_until=request.valid_until,
        horizon="5_TRADING_DAYS",
        horizon_end_date=date.fromisoformat(terminal_date),
        market_snapshot_ref=(
            f"{market_manifest['datasetId']}:{decision_date}:"
            f"{market_manifest['databaseSha256']}"
        ),
        trend=trend,
        current_quantity_shares=current,
        values=values,
        cost_assumptions_ref=CASH_EQUITY_FEE_POLICY["policyVersion"],
        calibration_ref=position.manifest["bundleId"],
    )


def build_position_assessment(
    owner_id: str,
    request: PositionDecisionRequest,
) -> PositionAssessment:
    with sessions()() as db:
        candidates = list(
            db.scalars(
                select(Assessment)
                .where(
                    Assessment.owner_id == owner_id,
                    Assessment.instrument_id
                    == request.constraints.instrument_id,
                    Assessment.as_of <= request.as_of,
                )
                .order_by(Assessment.created_at.desc())
                .limit(20)
            )
        )
        selected = None
        output = None
        for candidate in candidates:
            parsed = AssessmentOutput.model_validate(candidate.output)
            if parsed.valid_until > request.as_of:
                selected, output = candidate, parsed
                break
        if selected is None or output is None:
            raise PositionRuntimeError("POSITION_AGENT_ASSESSMENT_UNAVAILABLE")
        referenced = list(
            dict.fromkeys(
                evidence_id
                for claim in (*output.claims, *output.counter_claims)
                for evidence_id in claim.evidence_ids
            )
        )
        evidence = {
            row.id: row
            for row in db.scalars(
                select(Evidence).where(
                    Evidence.owner_id == owner_id,
                    Evidence.id.in_(referenced),
                    Evidence.available_at <= request.as_of,
                )
            )
        }
    if set(evidence) != set(referenced):
        raise PositionRuntimeError("POSITION_AGENT_EVIDENCE_UNAVAILABLE")
    signals = []
    for evidence_id in referenced:
        row = evidence[evidence_id]
        hostname = urlsplit(row.source_url).hostname or "unknown"
        statements = [
            claim.statement
            for claim in output.claims + output.counter_claims
            if claim.kind == "OBSERVED" and evidence_id in claim.evidence_ids
        ] or [row.quote]
        for statement in statements:
            signals.append(
                PositionEvidenceSignal(
                    evidence_id=row.id,
                    category=(
                        "ANNOUNCEMENT"
                        if hostname.endswith(("sse.com.cn", "szse.cn", "bse.cn"))
                        else "NEWS"
                    ),
                    direction="MIXED",
                    statement=statement,
                    source_id=row.source_key,
                    provider=hostname,
                    methodology=(
                        "用户提交原文并完成逐字引用定位；来源真实性仍需独立核验。"
                        if row.provenance == "USER_SUPPLIED"
                        else "豆包搜索发现的来源摘要；未将搜索命中自动视为已证实事实。"
                    ),
                    published_at=row.published_at,
                    first_seen_at=row.first_seen_at,
                    available_at=row.available_at,
                    validation="UNVERIFIED",
                )
            )
    snapshot_hash = hashlib.sha256(
        json.dumps(
            {
                "assessmentId": selected.id,
                "evidenceIds": referenced,
                "contextId": request.context_id,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    return PositionAssessment(
        assessment_id=selected.id,
        model_id=selected.model_id,
        source_snapshot_id=snapshot_hash,
        context_id=request.context_id,
        account_id=request.constraints.account_id,
        account_version=request.constraints.account_version,
        instrument_id=request.constraints.instrument_id,
        as_of=request.as_of,
        valid_until=min(output.valid_until, request.valid_until),
        thesis_status=output.thesis_status,
        claims=output.claims,
        counter_claims=output.counter_claims,
        signals=signals,
        uncertainties=[
            *output.uncertainties,
            "本次持仓研判缺少结构化主力资金、订单流与实时交易证据。",
            "research-assessment.v1已规范化为影子position-assessment.v1，尚待独立持仓Agent前瞻样本。",
        ],
        invalidation_conditions=[output.invalidation],
        review_after=min(
            output.valid_until,
            request.valid_until,
            request.as_of + timedelta(minutes=10),
        ),
    )


def enrich_shadow_request(
    owner_id: str,
    request: PositionDecisionRequest,
    config: Settings,
) -> PositionDecisionRequest:
    if request.release.status != "SHADOW":
        return request
    return request.model_copy(
        update={
            "quant": build_position_value_reference(request, config),
            "agent": build_position_assessment(owner_id, request),
        }
    )
