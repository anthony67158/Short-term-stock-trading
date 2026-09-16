import hashlib
import json
import sqlite3
from datetime import UTC, datetime

from platform_app.modules.experiments import daily_joint_cycle
from platform_app.modules.experiments.daily_joint_cycle import (
    write_daily_joint_cycle,
)
from platform_app.modules.experiments.joint_bundle import AGENT_FEATURE_NAMES


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def fixture_paths(tmp_path):
    market_root = tmp_path / "market"
    market_root.mkdir()
    database = market_root / "market.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE daily_bars (trade_date TEXT NOT NULL)")
        connection.execute("INSERT INTO daily_bars VALUES ('20260915')")
    market_hash = sha256(database)
    (market_root / "manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": "market-dataset.v4",
                "datasetId": "market-v1",
                "database": database.name,
                "databaseSha256": market_hash,
            }
        )
    )
    account = tmp_path / "account.json"
    account.write_text(
        json.dumps(
            {
                "schemaVersion": "account-backtest.v1",
                "createdAt": "2026-09-16T00:00:00+00:00",
                "lineage": {"marketDatabaseSha256": market_hash},
                "coverage": {"selected": 10, "covered": 8},
                "accountScenarios": [
                    {
                        "initialCashCny": "100000.00",
                        "netReturn": 0.01,
                        "stressNetReturn": -0.01,
                        "maximumDrawdown": 0.05,
                        "stressMaximumDrawdown": 0.07,
                    }
                ],
            }
        )
    )
    registry = tmp_path / "registry"
    release_root = registry / "releases" / "shadow-v1"
    release_root.mkdir(parents=True)
    strategy = release_root / "strategy.json"
    strategy.write_text('{"schemaVersion":"strategy-freeze.v1"}')
    ablation = release_root / "ablation.json"
    ablation.write_text('{"schemaVersion":"four-way-ablation.v1"}')
    release = {
        "bundleId": "shadow-v1",
        "schemaVersion": "joint-bundle.v2",
        "releaseStatus": "SHADOW",
        "deploymentMode": "SHADOW",
        "allowsNewRisk": False,
        "releaseBlockers": ["JOINT_ABLATION_PENDING"],
        "missingArtifacts": ["trained-joint-model"],
        "components": {
            "positionModelBundleId": "position-v1",
            "positionModelArtifactSha256": "a" * 64,
            "accountBacktestSha256": sha256(account),
            "strategyArtifact": strategy.name,
            "strategyArtifactSha256": sha256(strategy),
            "ablationArtifact": ablation.name,
            "ablationArtifactSha256": sha256(ablation),
        },
        "agent": {
            "promptSha256": "b" * 64,
            "positionPromptSha256": "c" * 64,
            "featureNames": AGENT_FEATURE_NAMES,
            "positionProtocolVersion": "position-assessment.v1",
        },
    }
    release_path = release_root / "manifest.json"
    release_path.write_text(json.dumps(release))
    registry.joinpath("active-shadow.json").write_text(
        json.dumps(
            {
                "releaseId": "shadow-v1",
                "manifest": "releases/shadow-v1/manifest.json",
                "manifestSha256": sha256(release_path),
            }
        )
    )
    return market_root, account, registry


def test_daily_cycle_keeps_shadow_when_data_or_samples_are_incomplete(
    tmp_path,
    monkeypatch,
):
    market, account, registry = fixture_paths(tmp_path)
    monkeypatch.setattr(
        daily_joint_cycle,
        "_sample_counts",
        lambda: {"PENDING": 12, "MATURED": 0, "EXCLUDED": 1},
    )
    arguments = {
        "output_root": tmp_path / "daily",
        "active_release_pointer": registry / "active-shadow.json",
        "market_dataset_root": market,
        "account_backtest_path": account,
        "minimum_matured_samples": 20,
        "as_of": datetime(2026, 9, 16, 10, tzinfo=UTC),
    }
    report = write_daily_joint_cycle(**arguments)
    assert report["decision"] == "KEEP_CURRENT_RELEASE"
    assert report["promotionEligible"] is False
    assert report["prospectiveSamples"]["PENDING"] == 12
    assert "MARKET_DATASET_END_BEFORE_EVALUATION_DATE" in report["releaseBlockers"]
    assert "PROSPECTIVE_AGENT_SAMPLE_SUPPORT_INSUFFICIENT" in report["releaseBlockers"]
    assert write_daily_joint_cycle(**arguments) == report
