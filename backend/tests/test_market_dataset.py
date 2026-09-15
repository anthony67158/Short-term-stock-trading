import hashlib
import sqlite3

import pytest

from platform_app.modules.experiments.market_dataset import (
    MarketDataset,
    MarketDatasetError,
    canonical_sha256,
)


def instrument(**changes):
    row = {
        "instrumentId": "SZ.000001",
        "sourceCode": "000001.SZ",
        "exchange": "SZ",
        "board": "MAIN",
        "name": "Synthetic Bank",
        "listStatus": "L",
        "listDate": "19910403",
        "delistDate": None,
        "source": "TUSHARE_COMPATIBLE",
        "availableAt": "2026-09-15T16:00:00+08:00",
    }
    row.update(changes)
    row["sourceRowSha256"] = canonical_sha256(row)
    return row


def daily(**changes):
    row = {
        "instrumentId": "SZ.000001",
        "sourceCode": "000001.SZ",
        "tradeDate": "20260915",
        "open": "10.01",
        "high": "10.20",
        "low": "9.90",
        "close": "10.10",
        "previousClose": "10.00",
        "volumeShares": "12345.00",
        "amountCny": "124678.000",
        "adjustment": "RAW",
    }
    row.update(changes)
    row["sourceRowSha256"] = canonical_sha256(row)
    return row


def alias():
    row = {
        "sourceCode": "839729.BJ",
        "instrumentId": "BJ.920729",
        "effectiveFrom": "20200727",
        "effectiveTo": "20251008",
        "reason": "BSE_920_CODE_MIGRATION",
        "source": "TUSHARE_COMPATIBLE",
        "availableAt": "2026-09-15T16:00:00+08:00",
    }
    row["sourceRowSha256"] = canonical_sha256(row)
    return row


def test_dataset_resumes_exact_rows_and_rejects_conflicts_atomically(tmp_path):
    root = tmp_path / "dataset"
    with MarketDataset(root, dataset_id="full-a-share-2016", source="TUSHARE_COMPATIBLE") as ds:
        assert ds.write_instruments([instrument()]) == 1
        assert ds.write_instruments([instrument()]) == 0
        assert (
            ds.write_daily_bars(
                [daily()], source="TUSHARE_COMPATIBLE", available_at="2026-09-15T16:00:00+08:00"
            )
            == 1
        )
        with pytest.raises(MarketDatasetError, match="DATASET_CONFLICT"):
            ds.write_daily_bars(
                [daily(tradeDate="20260916"), daily(close="10.11")],
                source="TUSHARE_COMPATIBLE",
                available_at="2026-09-15T16:00:00+08:00",
            )

    with sqlite3.connect(root / "market.sqlite3") as db:
        assert db.execute("SELECT COUNT(*) FROM daily_bars").fetchone()[0] == 1

    with MarketDataset(root, dataset_id="full-a-share-2016", source="TUSHARE_COMPATIBLE") as ds:
        assert (
            ds.write_daily_bars(
                [daily()], source="TUSHARE_COMPATIBLE", available_at="2026-09-15T16:00:00+08:00"
            )
            == 0
        )
        assert ds.checkpoint("daily", "20260915", [daily()])
        assert ds.has_checkpoint("daily", "20260915")
        assert not ds.checkpoint("daily", "20260915", [daily()])
        with pytest.raises(MarketDatasetError, match="CHECKPOINT_CONFLICT"):
            ds.checkpoint("daily", "20260915", [])


def test_reference_replay_preserves_first_observation_time(tmp_path):
    first = instrument()
    replay = {**first, "availableAt": "2026-09-16T16:00:00+08:00"}
    with MarketDataset(
        tmp_path / "dataset", dataset_id="reference-retry", source="TUSHARE_COMPATIBLE"
    ) as ds:
        assert ds.write_instruments([first]) == 1
        assert ds.write_instruments([replay]) == 0
        stored = ds.db.execute(
            "SELECT available_at FROM instruments WHERE instrument_id = 'SZ.000001'"
        ).fetchone()[0]
        assert stored == first["availableAt"]


def test_sealed_dataset_has_verifiable_database_hash_and_is_immutable(tmp_path):
    root = tmp_path / "dataset"
    with MarketDataset(root, dataset_id="full-a-share-2016", source="TUSHARE_COMPATIBLE") as ds:
        ds.write_instruments(
            [
                instrument(
                    instrumentId="BJ.920729",
                    sourceCode="839729.BJ",
                    exchange="BJ",
                    board="BEIJING",
                    name="Synthetic BSE",
                    listDate="20200727",
                )
            ]
        )
        ds.write_aliases([alias()])
        manifest = ds.seal()
        with pytest.raises(MarketDatasetError, match="DATASET_ALREADY_SEALED"):
            ds.write_aliases([alias()])

    with (root / "market.sqlite3").open("rb") as stream:
        assert manifest["databaseSha256"] == hashlib.file_digest(stream, "sha256").hexdigest()
    assert manifest["tables"]["instruments"] == 1
    assert manifest["tables"]["instrument_aliases"] == 1
    assert (root / "manifest.json").is_file()
    with pytest.raises(MarketDatasetError, match="DATASET_ALREADY_SEALED"):
        MarketDataset(root, dataset_id="full-a-share-2016", source="TUSHARE_COMPATIBLE")


def test_resume_rejects_a_different_dataset_identity(tmp_path):
    root = tmp_path / "dataset"
    with MarketDataset(root, dataset_id="one", source="TUSHARE_COMPATIBLE"):
        pass
    with pytest.raises(MarketDatasetError, match="DATASET_IDENTITY_MISMATCH"):
        MarketDataset(root, dataset_id="two", source="TUSHARE_COMPATIBLE")


def test_point_in_time_universe_and_suspension_explanations(tmp_path):
    root = tmp_path / "dataset"
    rows = [
        instrument(),
        instrument(
            instrumentId="SH.600001",
            sourceCode="600001.SH",
            exchange="SH",
            name="Delisted Synthetic",
            listDate="20100101",
            delistDate="20200131",
            listStatus="D",
        ),
        instrument(
            instrumentId="SZ.300001",
            sourceCode="300001.SZ",
            exchange="SZ",
            board="CHINEXT",
            name="Future Synthetic",
            listDate="20210101",
        ),
    ]
    suspension = {
        "instrument_id": "SH.600001",
        "source_code": "600001.SH",
        "trade_date": "20200102",
        "suspend_type": "S",
        "suspend_timing": "DAY",
        "source": "TUSHARE_COMPATIBLE",
        "available_at": "2020-01-02T09:00:00+08:00",
        "source_row_sha256": canonical_sha256({"synthetic": "suspension"}),
    }
    listing_status = {
        "instrument_id": "SH.600001",
        "status": "SUSPENDED_LISTING",
        "effective_from": "20191201",
        "effective_to": "20200110",
        "source": "OFFICIAL_EXCHANGE",
        "source_urls_json": '["https://example.invalid/official"]',
        "evidence_observed_at": "2026-09-16T00:00:00+00:00",
        "source_row_sha256": canonical_sha256({"synthetic": "listing-status"}),
    }
    with MarketDataset(root, dataset_id="point-in-time", source="TUSHARE_COMPATIBLE") as ds:
        ds.write_instruments(rows)
        ds.write_facts(
            "suspensions",
            [suspension],
            key_fields=("instrument_id", "trade_date", "suspend_type", "suspend_timing"),
        )
        ds.write_facts(
            "listing_status_periods",
            [listing_status],
            key_fields=("instrument_id", "status", "effective_from"),
        )
        assert ds.eligible_instruments("20200102") == ["SH.600001", "SZ.000001"]
        assert ds.eligible_instruments("20200130") == ["SH.600001", "SZ.000001"]
        assert ds.eligible_instruments("20200131") == ["SZ.000001"]
        assert ds.eligible_instruments("20210201") == ["SZ.000001", "SZ.300001"]
        assert ds.suspension_explanations("20200102") == {"SH.600001": ["S:DAY"]}
        assert ds.listing_status_explanations("20200102") == {"SH.600001": ["SUSPENDED_LISTING"]}
        assert ds.listing_status_explanations("20200110") == {}


def test_fact_writer_rejects_unknown_tables(tmp_path):
    with MarketDataset(
        tmp_path / "dataset", dataset_id="safe-table", source="TUSHARE_COMPATIBLE"
    ) as ds:
        with pytest.raises(MarketDatasetError, match="DATASET_TABLE_REJECTED"):
            ds.write_facts("sqlite_master", [], key_fields=("name",))
