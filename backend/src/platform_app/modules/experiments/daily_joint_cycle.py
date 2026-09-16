"""Daily evidence report for retaining or promoting the active joint release."""

import json
import os
import sqlite3
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.modules.experiments.account_backtest import (
    ACCOUNT_BACKTEST_SCHEMA_VERSION,
)
from platform_app.modules.experiments.joint_bundle import (
    JointBundle,
    _file_sha256,
)
from platform_app.modules.learning.models import ProspectiveSample

DAILY_CYCLE_SCHEMA_VERSION = "daily-joint-cycle.v1"


class DailyCycleError(ValueError):
    pass


def _read_json(path: Path, error_code: str) -> dict:
    try:
        value = json.loads(path.expanduser().resolve().read_text())
    except (OSError, TypeError, json.JSONDecodeError) as exc:
        raise DailyCycleError(error_code) from exc
    if not isinstance(value, dict):
        raise DailyCycleError(error_code)
    return value


def _sample_counts() -> dict[str, int]:
    with sessions()() as db:
        rows = db.execute(
            select(ProspectiveSample.status, func.count())
            .group_by(ProspectiveSample.status)
        )
        counts = Counter({status: count for status, count in rows})
    return {
        status: int(counts[status])
        for status in ("PENDING", "MATURED", "EXCLUDED")
    }


def write_daily_joint_cycle(
    *,
    output_root: Path,
    active_release_pointer: Path,
    market_dataset_root: Path,
    account_backtest_path: Path,
    minimum_matured_samples: int = 2000,
    as_of: datetime | None = None,
) -> dict:
    if minimum_matured_samples < 1:
        raise DailyCycleError("DAILY_MINIMUM_SAMPLE_INVALID")
    now = as_of or datetime.now(UTC)
    if now.tzinfo is None:
        raise DailyCycleError("DAILY_AS_OF_TZ_REQUIRED")
    release = JointBundle(
        active_release_pointer,
        require_ready=False,
    ).manifest
    market_root = market_dataset_root.expanduser().resolve()
    market_manifest = _read_json(
        market_root / "manifest.json",
        "DAILY_MARKET_MANIFEST_INVALID",
    )
    market_database = market_root / market_manifest.get("database", "")
    if (
        market_manifest.get("schemaVersion") != "market-dataset.v4"
        or not market_database.is_file()
        or _file_sha256(market_database)
        != market_manifest.get("databaseSha256")
    ):
        raise DailyCycleError("DAILY_MARKET_DATASET_INVALID")
    account_path = account_backtest_path.expanduser().resolve()
    account = _read_json(account_path, "DAILY_ACCOUNT_BACKTEST_INVALID")
    if (
        account.get("schemaVersion") != ACCOUNT_BACKTEST_SCHEMA_VERSION
        or _file_sha256(account_path)
        != release.get("components", {}).get("accountBacktestSha256")
        or account.get("lineage", {}).get("marketDatabaseSha256")
        != market_manifest["databaseSha256"]
    ):
        raise DailyCycleError("DAILY_ACCOUNT_BACKTEST_LINEAGE_MISMATCH")
    sample_counts = _sample_counts()
    local_date = now.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d")
    with sqlite3.connect(
        f"{market_database.as_uri()}?mode=ro&immutable=1",
        uri=True,
    ) as market:
        dataset_end = str(
            market.execute("SELECT MAX(trade_date) FROM daily_bars").fetchone()[0]
            or ""
        )
    blockers = list(release.get("releaseBlockers", []))
    if dataset_end < local_date:
        blockers.append("MARKET_DATASET_END_BEFORE_EVALUATION_DATE")
    if sample_counts["MATURED"] < minimum_matured_samples:
        blockers.append("PROSPECTIVE_AGENT_SAMPLE_SUPPORT_INSUFFICIENT")
    blockers = list(dict.fromkeys(blockers))
    report = {
        "schemaVersion": DAILY_CYCLE_SCHEMA_VERSION,
        "runId": now.strftime("daily-%Y%m%dT%H%M%SZ"),
        "createdAt": now.astimezone(UTC).isoformat(),
        "activeRelease": {
            "releaseId": release["bundleId"],
            "mode": release["releaseStatus"],
            "allowsNewRisk": release.get("allowsNewRisk", False),
        },
        "marketDataset": {
            "datasetId": market_manifest["datasetId"],
            "databaseSha256": market_manifest["databaseSha256"],
            "endDate": dataset_end,
        },
        "accountBacktest": {
            "sha256": _file_sha256(account_path),
            "createdAt": account["createdAt"],
            "coverage": account["coverage"],
            "scenarios": [
                {
                    key: scenario[key]
                    for key in (
                        "initialCashCny",
                        "netReturn",
                        "stressNetReturn",
                        "maximumDrawdown",
                        "stressMaximumDrawdown",
                    )
                }
                for scenario in account["accountScenarios"]
            ],
        },
        "prospectiveSamples": {
            **sample_counts,
            "minimumMaturedForPromotion": minimum_matured_samples,
        },
        "releaseBlockers": blockers,
        "promotionEligible": not blockers,
        "decision": (
            "CREATE_PROMOTION_CANDIDATE"
            if not blockers
            else "KEEP_CURRENT_RELEASE"
        ),
    }
    root = output_root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{report['runId']}.json"
    if target.exists():
        existing = _read_json(target, "DAILY_REPORT_INVALID")
        if existing != report:
            raise DailyCycleError("DAILY_RUN_ALREADY_EXISTS")
        return existing
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, target)
    return report
