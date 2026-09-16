from datetime import datetime, timedelta
import hashlib
import json
from zoneinfo import ZoneInfo

import numpy as np
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from platform_app.adapters.database import sessions
from platform_app.config import Settings, settings
from platform_app.contracts.base import utcnow
from platform_app.modules.decisions.candidate_contracts import (
    CandidateScan,
    CandidateScanInput,
    JointCandidate,
)
from platform_app.modules.decisions.position_runtime import (
    PositionRuntimeError,
    _latest_market_date,
    _sealed_feature_snapshot,
    _verified_artifacts,
)
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations import jobs
from platform_app.modules.operations.models import Job
from platform_app.modules.research.contracts import AssessmentOutput
from platform_app.modules.research.models import Assessment, Evidence


class CandidateError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        self.code, self.message, self.status = code, message, status


def _latest_agent_events(
    owner_id: str,
    as_of: datetime,
    eligible: set[str],
) -> dict[str, tuple[Assessment, AssessmentOutput, list[str]]]:
    selected = {}
    with sessions()() as db:
        rows = db.scalars(
            select(Assessment)
            .where(
                Assessment.owner_id == owner_id,
                Assessment.instrument_id.in_(eligible),
                Assessment.as_of <= as_of,
            )
            .order_by(Assessment.created_at.desc(), Assessment.id.desc())
        )
        for row in rows:
            if row.instrument_id in selected:
                continue
            try:
                output = AssessmentOutput.model_validate(row.output)
            except ValueError:
                continue
            if (
                output.valid_until <= as_of
                or "EVENT" not in output.strategy_fit
                or output.thesis_status
                not in {"SUPPORTED", "UNCERTAIN"}
            ):
                continue
            evidence_ids = list(
                dict.fromkeys(
                    evidence_id
                    for claim in (*output.claims, *output.counter_claims)
                    for evidence_id in claim.evidence_ids
                )
            )
            causal_evidence = set(
                db.scalars(
                    select(Evidence.id).where(
                        Evidence.owner_id == owner_id,
                        Evidence.id.in_(evidence_ids),
                        Evidence.available_at <= as_of,
                    )
                )
            )
            if causal_evidence != set(evidence_ids):
                continue
            selected[row.instrument_id] = (
                row,
                output,
                evidence_ids,
            )
    return selected


def _merge_candidates(
    rows: tuple | list,
    rank_scores: np.ndarray,
    expected_returns: np.ndarray,
    agent_events: dict,
    names: dict[str, str],
    decision_date: str,
    limit: int,
) -> list[JointCandidate]:
    ranked = np.argsort(rank_scores)[::-1]
    model_indexes = list(ranked[:limit])
    index_by_instrument = {
        row["instrument_id"]: index for index, row in enumerate(rows)
    }
    selected_ids = [rows[index]["instrument_id"] for index in model_indexes]
    for instrument_id in sorted(agent_events):
        if instrument_id not in selected_ids:
            selected_ids.append(instrument_id)
    candidates = []
    model_ids = {rows[index]["instrument_id"] for index in model_indexes}
    for instrument_id in selected_ids:
        index = index_by_instrument[instrument_id]
        row = rows[index]
        agent = agent_events.get(instrument_id)
        sources = []
        if instrument_id in model_ids:
            sources.append("MODEL")
        if agent is not None:
            sources.append("AGENT_EVENT")
        candidates.append(
            JointCandidate(
                instrument_id=instrument_id,
                name=names.get(instrument_id),
                board=row["board"],
                decision_date=decision_date,
                recall_sources=sources,
                rank_score=float(rank_scores[index]),
                expected_gross_return=float(expected_returns[index]),
                assessment_id=agent[0].id if agent else None,
                thesis_status=agent[1].thesis_status if agent else None,
                evidence_ids=agent[2] if agent else [],
            )
        )
    return candidates


def build_candidate_scan(
    owner_id: str,
    as_of: datetime,
    limit: int,
    config: Settings,
) -> CandidateScan:
    pointer = config.joint_bundle_root
    if pointer is None:
        raise CandidateError(
            "JOINT_RELEASE_NOT_CONFIGURED",
            "尚未配置联合发布版本",
            503,
        )
    pointer = pointer.expanduser().resolve()
    (
        release_manifest,
        ranking,
        _position,
        _ranking_manifest,
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
    status = release_manifest.get("releaseStatus")
    if status not in {"READY", "SHADOW"}:
        raise CandidateError(
            "JOINT_RELEASE_UNAVAILABLE",
            "联合发布版本当前不可用于候选扫描",
            503,
        )
    components = release_manifest["components"]
    if (
        ranking.manifest["bundleId"]
        != components["rankingModelBundleId"]
        or ranking.manifest["artifactSha256"]
        != components["rankingModelArtifactSha256"]
    ):
        raise CandidateError(
            "JOINT_RELEASE_REFERENCE_MISMATCH",
            "联合发布版本与排序模型不一致",
            503,
        )
    local_as_of = as_of.astimezone(ZoneInfo("Asia/Shanghai"))
    candidate_date = local_as_of.date()
    if local_as_of.hour < 17:
        candidate_date -= timedelta(days=1)
    decision_date = _latest_market_date(
        str(market_path),
        candidate_date.strftime("%Y%m%d"),
    )
    causal_cutoff = (
        local_as_of.replace(hour=17, minute=0, second=0, microsecond=0)
        if candidate_date == local_as_of.date()
        else local_as_of.replace(hour=0, minute=0, second=0, microsecond=0)
    )
    rows, _prices, _available, _terminal, matrix = (
        _sealed_feature_snapshot(
            str(market_path),
            decision_date,
            causal_cutoff.isoformat(),
        )
    )
    predictions = ranking.predict_matrix(matrix)
    eligible = {row["instrument_id"] for row in rows}
    agent_events = _latest_agent_events(owner_id, as_of, eligible)
    with sessions()() as db:
        names = dict(
            db.execute(
                select(Instrument.id, Instrument.name).where(
                    Instrument.id.in_(
                        {
                            *eligible,
                            *agent_events,
                        }
                    )
                )
            ).all()
        )
    candidates = _merge_candidates(
        rows,
        predictions["rankScore"],
        predictions["expectedGrossReturn"],
        agent_events,
        names,
        decision_date,
        limit,
    )
    return CandidateScan(
        release_id=release_manifest["bundleId"],
        release_status=status,
        as_of=as_of,
        decision_date=decision_date,
        market_snapshot_ref=(
            f"{market_manifest['datasetId']}:{decision_date}:"
            f"{market_manifest['databaseSha256']}"
        ),
        eligible_instruments=len(rows),
        model_recall_count=min(limit, len(rows)),
        agent_event_recall_count=len(agent_events),
        candidates=candidates,
        blocker_codes=list(release_manifest.get("releaseBlockers", [])),
    )


def submit_scan(
    owner_id: str,
    body: CandidateScanInput,
    key: str,
) -> Job:
    from platform_app.modules.decisions.service import active_release

    release = active_release()
    if release.status not in {"READY", "SHADOW"}:
        raise CandidateError(
            "JOINT_RELEASE_UNAVAILABLE",
            "联合发布版本当前不可用于候选扫描",
            503,
        )
    digest = hashlib.sha256(
        json.dumps(
            {
                "request": body.model_dump(mode="json"),
                "release": release.model_dump(mode="json"),
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()
    payload = {
            "schemaVersion": "candidate-scan-request.v1",
            "asOf": utcnow().isoformat(),
            "limit": body.limit,
            "release": release.model_dump(mode="json"),
        }
    with sessions().begin() as db:
        db.execute(
            insert(Job)
            .values(
                owner_id=owner_id,
                kind="CANDIDATE_SCAN",
                business_key=key,
                input_hash=digest,
                payload=payload,
            )
            .on_conflict_do_nothing(
                index_elements=["owner_id", "kind", "business_key"]
            )
        )
        job = db.scalar(
            select(Job).where(
                Job.owner_id == owner_id,
                Job.kind == "CANDIDATE_SCAN",
                Job.business_key == key,
            )
        )
        if job.input_hash != digest:
            raise CandidateError(
                "IDEMPOTENCY_CONFLICT",
                "同一请求编号的内容发生变化",
                409,
            )
        return job


def process_one() -> bool:
    from platform_app.modules.decisions.service import active_release

    job = jobs.claim(["CANDIDATE_SCAN"], lease_seconds=180)
    if job is None:
        return False
    if active_release().model_dump(mode="json") != job.payload["release"]:
        jobs.finish(job, error="JOINT_RELEASE_CHANGED")
        return True
    try:
        scan = build_candidate_scan(
            job.owner_id,
            datetime.fromisoformat(job.payload["asOf"]),
            job.payload["limit"],
            settings(),
        )
    except CandidateError as exc:
        jobs.finish(job, error=exc.code)
        return True
    except PositionRuntimeError as exc:
        jobs.finish(job, error=str(exc))
        return True
    jobs.finish(
        job,
        result={"scan": scan.model_dump(mode="json")},
    )
    return True


def latest_scan(owner_id: str) -> CandidateScan | None:
    with sessions()() as db:
        job = db.scalar(
            select(Job)
            .where(
                Job.owner_id == owner_id,
                Job.kind == "CANDIDATE_SCAN",
                Job.status == "SUCCEEDED",
            )
            .order_by(Job.updated_at.desc(), Job.id.desc())
            .limit(1)
        )
        if job is None or not job.result:
            return None
        return CandidateScan.model_validate(job.result["scan"])
