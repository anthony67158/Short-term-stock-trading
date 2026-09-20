import hashlib
import json
import sqlite3

import numpy as np
import pytest

from platform_app.modules.experiments.action_value_factor_dataset import (
    ActionValueFactorDataset,
    ActionValueFactorDatasetError,
    FEATURE_NAMES,
    load_factor_vectors,
    verify_action_value_factor_dataset,
)
from platform_app.modules.experiments.multifactor_source import (
    build_multifactor_source_archive,
    financial_periods_for_dates,
)


DATES = ("20250102", "20250103")


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _seal_manifest(root, *, dataset_id, schema, database, **extra):
    path = root / database
    payload = {
        "datasetId": dataset_id,
        "schemaVersion": schema,
        "database": database,
        "databaseSha256": _sha256(path),
        **extra,
    }
    (root / "manifest.json").write_text(json.dumps(payload))
    return payload


def _sealed_upstreams(tmp_path):
    market_root = tmp_path / "market"
    market_root.mkdir()
    with sqlite3.connect(market_root / "market.sqlite3") as database:
        database.executescript(
            """
            CREATE TABLE dataset_metadata (
                singleton INTEGER PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                schema_version TEXT NOT NULL
            );
            CREATE TABLE instruments (
                source_code TEXT NOT NULL,
                instrument_id TEXT NOT NULL
            );
            CREATE TABLE instrument_aliases (
                source_code TEXT NOT NULL,
                instrument_id TEXT NOT NULL,
                effective_from TEXT,
                effective_to TEXT
            );
            """
        )
        database.execute(
            "INSERT INTO dataset_metadata VALUES (1, ?, ?)",
            ("market-v1", "market-dataset.v4"),
        )
        database.executemany(
            "INSERT INTO instruments VALUES (?,?)",
            [
                ("600001.SH", "SH.600001"),
                ("920001.BJ", "BJ.920001"),
            ],
        )
        database.execute(
            "INSERT INTO instrument_aliases VALUES (?,?,?,?)",
            ("830001.BJ", "BJ.920001", "20211115", "20251008"),
        )
    market = _seal_manifest(
        market_root,
        dataset_id="market-v1",
        schema="market-dataset.v4",
        database="market.sqlite3",
    )

    ranking_root = tmp_path / "ranking"
    ranking_root.mkdir()
    with sqlite3.connect(ranking_root / "ranking.sqlite3") as database:
        database.executescript(
            """
            CREATE TABLE ranking_dataset_metadata (
                singleton INTEGER PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                schema_version TEXT NOT NULL
            );
            CREATE TABLE ranking_samples (
                instrument_id TEXT NOT NULL,
                decision_date TEXT NOT NULL,
                adjusted_return_20 TEXT NOT NULL,
                adjusted_return_60 TEXT NOT NULL,
                realized_volatility_20 TEXT NOT NULL,
                realized_volatility_60 TEXT NOT NULL
            );
            """
        )
        database.execute(
            "INSERT INTO ranking_dataset_metadata VALUES (1, ?, ?)",
            ("ranking-v1", "ranking-dataset.v1"),
        )
        database.executemany(
            "INSERT INTO ranking_samples VALUES (?,?,?,?,?,?)",
            [
                (code, date, return20, return60, vol20, vol60)
                for date in DATES
                for code, return20, return60, vol20, vol60 in (
                    ("SH.600001", "0.1", "0.2", "0.01", "0.02"),
                    ("BJ.920001", "-0.1", "-0.2", "0.04", "0.05"),
                )
            ],
        )
    ranking = _seal_manifest(
        ranking_root,
        dataset_id="ranking-v1",
        schema="ranking-dataset.v1",
        database="ranking.sqlite3",
        marketDatabaseSha256=market["databaseSha256"],
    )

    episode_root = tmp_path / "episode"
    episode_root.mkdir()
    with sqlite3.connect(episode_root / "episodes.sqlite3") as database:
        database.executescript(
            """
            CREATE TABLE episode_dataset_metadata (
                singleton INTEGER PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                schema_version TEXT NOT NULL
            );
            CREATE TABLE candidate_episodes (
                episode_id TEXT PRIMARY KEY,
                decision_date TEXT NOT NULL,
                instrument_id TEXT NOT NULL
            );
            """
        )
        database.execute(
            "INSERT INTO episode_dataset_metadata VALUES (1, ?, ?)",
            ("episodes-v1", "episode-dataset.v4"),
        )
        database.executemany(
            "INSERT INTO candidate_episodes VALUES (?,?,?)",
            [
                ("episode-1", DATES[0], "BJ.920001"),
                ("episode-2", DATES[1], "SH.600001"),
            ],
        )
    episode = _seal_manifest(
        episode_root,
        dataset_id="episodes-v1",
        schema="episode-dataset.v4",
        database="episodes.sqlite3",
        marketDatabaseSha256=market["databaseSha256"],
    )
    return market_root, ranking_root, episode_root, market, ranking, episode


class FakeClient:
    def rows(self, api_name, params, fields):
        if api_name == "daily_basic":
            return [
                {
                    "ts_code": code,
                    "trade_date": params["trade_date"],
                    "pe_ttm": pe,
                    "pb": pb,
                    "ps_ttm": ps,
                    "dv_ttm": dividend,
                    "total_mv": 100,
                    "circ_mv": size,
                }
                for code, pe, pb, ps, dividend, size in (
                    ("600001.SH", 8, 1, 2, 3, 80),
                    ("830001.BJ", 30, 4, 6, 0, 30),
                )
            ]
        if api_name in {
            "income_vip",
            "balancesheet_vip",
            "cashflow_vip",
        }:
            rows = []
            for code, strength in (("600001.SH", 2), ("830001.BJ", 1)):
                rows.append({
                    "ts_code": code,
                    "ann_date": params["period"],
                    "f_ann_date": params["period"],
                    "end_date": params["period"],
                    "report_type": "1",
                    "comp_type": "1",
                    "update_flag": "0",
                    "revenue": 100 * strength,
                    "total_revenue": 100 * strength,
                    "n_income_attr_p": 20 * strength,
                    "total_assets": 200,
                    "total_liab": 50 if strength == 2 else 120,
                    "total_hldr_eqy_exc_min_int": 150,
                    "n_cashflow_act": 25 * strength,
                })
            return rows
        if api_name == "dividend":
            return [
                {
                    "ts_code": code,
                    "end_date": params["end_date"],
                    "ann_date": params["end_date"],
                    "div_proc": "\u5b9e\u65bd",
                    "cash_div_tax": 0.2,
                    "record_date": params["end_date"],
                    "ex_date": params["end_date"],
                    "pay_date": params["end_date"],
                }
                for code in ("600001.SH", "830001.BJ")
            ]
        return [
            {
                "l1_code": "801780.SI",
                "l1_name": industry,
                "ts_code": code,
                "name": code,
                "in_date": "20200101",
                "out_date": None,
                "is_new": "Y",
            }
            for code, industry in (
                ("600001.SH", "BANK"),
                ("830001.BJ", "INDUSTRIAL"),
            )
        ]


def _source_archive(tmp_path):
    root = tmp_path / "source"
    build_multifactor_source_archive(
        client=FakeClient(),
        output_root=root,
        decision_dates=list(DATES),
        financial_periods=financial_periods_for_dates(list(DATES)),
        workers=2,
    )
    return root


def test_factor_dataset_seals_full_episode_coverage_and_aliases(tmp_path):
    market_root, ranking_root, episode_root, *_ = _sealed_upstreams(tmp_path)
    source_root = _source_archive(tmp_path)
    root = tmp_path / "factors"
    with ActionValueFactorDataset(
        root,
        dataset_id="factors-v1",
        source_root=source_root,
        episode_dataset_root=episode_root,
        ranking_dataset_root=ranking_root,
        market_dataset_root=market_root,
    ) as dataset:
        results = list(dataset.build())
        manifest = dataset.seal()

    assert len(results) == 2
    assert manifest["rows"] == 2
    assert manifest["readyRows"] == 2
    assert manifest["readyCoverage"] == 1
    assert manifest["featureNames"] == list(FEATURE_NAMES)
    verified, database = verify_action_value_factor_dataset(root)
    assert verified == manifest
    with sqlite3.connect(database) as connection:
        aliased = connection.execute(
            "SELECT instrument_id,state FROM factor_rows "
            "WHERE episode_id='episode-1'"
        ).fetchone()
    assert aliased == ("BJ.920001", "READY")

    vectors, lineage = load_factor_vectors(root)
    assert lineage["databaseSha256"] == manifest["databaseSha256"]
    assert set(vectors) == {"episode-1", "episode-2"}
    assert all(len(vector) == len(FEATURE_NAMES) for vector in vectors.values())
    assert all(np.all(np.isfinite(vector)) for vector in vectors.values())


def test_factor_dataset_rejects_source_date_coverage_drift(tmp_path):
    market_root, ranking_root, episode_root, *_ = _sealed_upstreams(tmp_path)
    source_root = tmp_path / "source"
    build_multifactor_source_archive(
        client=FakeClient(),
        output_root=source_root,
        decision_dates=[DATES[0]],
        financial_periods=financial_periods_for_dates(list(DATES)),
    )

    with pytest.raises(
        ActionValueFactorDatasetError,
        match="SOURCE_NOT_READY",
    ):
        ActionValueFactorDataset(
            tmp_path / "factors",
            dataset_id="factors-v1",
            source_root=source_root,
            episode_dataset_root=episode_root,
            ranking_dataset_root=ranking_root,
            market_dataset_root=market_root,
        )


def test_factor_dataset_verification_rejects_manifest_drift(tmp_path):
    market_root, ranking_root, episode_root, *_ = _sealed_upstreams(tmp_path)
    root = tmp_path / "factors"
    with ActionValueFactorDataset(
        root,
        dataset_id="factors-v1",
        source_root=_source_archive(tmp_path),
        episode_dataset_root=episode_root,
        ranking_dataset_root=ranking_root,
        market_dataset_root=market_root,
    ) as dataset:
        list(dataset.build())
        dataset.seal()
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["rows"] += 1
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(
        ActionValueFactorDatasetError,
        match="MANIFEST_MISMATCH",
    ):
        verify_action_value_factor_dataset(root)
