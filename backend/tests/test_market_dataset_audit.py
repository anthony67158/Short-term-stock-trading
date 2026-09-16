from platform_app.modules.experiments.market_dataset import MarketDataset
from platform_app.modules.experiments.market_dataset_audit import audit_market_dataset

HASH = "a" * 64
AVAILABLE = "2026-09-15T16:30:00+08:00"


def build_dataset(tmp_path):
    root = tmp_path / "canonical"
    with MarketDataset(root, dataset_id="audit-fixture", source="TUSHARE_COMPATIBLE") as dataset:
        dataset.write_instruments(
            [
                {
                    "instrumentId": "SH.600000",
                    "sourceCode": "600000.SH",
                    "exchange": "SH",
                    "board": "MAIN",
                    "name": "浦发银行",
                    "listStatus": "L",
                    "listDate": "20260915",
                    "sourceListDate": "20260915",
                    "delistDate": None,
                    "source": "TUSHARE_COMPATIBLE",
                    "availableAt": "2026-09-16T00:00:00+00:00",
                    "sourceRowSha256": HASH,
                }
            ]
        )
        dataset.write_aliases(
            [
                {
                    "sourceCode": "500000.SH",
                    "instrumentId": "SH.600000",
                    "effectiveFrom": "20200101",
                    "effectiveTo": "20260915",
                    "reason": "SECURITY_CODE_CHANGE",
                    "source": "OFFICIAL_EXCHANGE_NOTICE",
                    "sourceUrlsJson": "[]",
                    "availableAt": "2026-09-16T00:00:00+00:00",
                    "sourceRowSha256": HASH,
                }
            ]
        )
        dataset.write_facts(
            "trade_calendar",
            [
                {
                    "exchange": "SSE",
                    "cal_date": "20260915",
                    "is_open": 1,
                    "previous_open_date": "20260914",
                    "source": "TUSHARE_COMPATIBLE",
                    "available_at": AVAILABLE,
                    "source_row_sha256": HASH,
                }
            ],
            key_fields=("exchange", "cal_date"),
        )
        dataset.write_daily_bars(
            [
                {
                    "instrumentId": "SH.600000",
                    "sourceCode": "600000.SH",
                    "tradeDate": "20260915",
                    "open": "10",
                    "high": "11",
                    "low": "9",
                    "close": "10.5",
                    "previousClose": "10",
                    "volumeShares": "10000",
                    "amountCny": "100000",
                    "adjustment": "RAW",
                    "sourceRowSha256": HASH,
                }
            ],
            source="TUSHARE_COMPATIBLE",
            available_at=AVAILABLE,
        )
        dataset.write_facts(
            "adjustment_factors",
            [
                {
                    "instrument_id": "SH.600000",
                    "source_code": "600000.SH",
                    "trade_date": "20260915",
                    "factor": "1",
                    "source": "TUSHARE_COMPATIBLE",
                    "available_at": "2026-09-15T09:20:00+08:00",
                    "source_row_sha256": HASH,
                }
            ],
            key_fields=("instrument_id", "trade_date"),
        )
        dataset.checkpoint("reference", "20260915:20260915", [{}])
        dataset.checkpoint("daily", "20260915", [{}])
        dataset.checkpoint("block_trades", "20260915", [])
    return root


def test_canonical_dataset_audit_passes_complete_fixture(tmp_path):
    report = audit_market_dataset(
        build_dataset(tmp_path),
        observed_at=lambda: "2026-09-16T10:00:00+00:00",
    )

    assert report["passed"]
    assert report["range"]["openDates"] == 1
    assert report["range"]["blockTradeCheckpoints"] == 1
    assert report["totals"]["dailyBars"] == 1
    assert report["blockTrades"]["transactions"] == 0
    assert report["violations"] == {}


def test_canonical_dataset_audit_reports_value_and_coverage_failures(tmp_path):
    root = build_dataset(tmp_path)
    with MarketDataset(root, dataset_id="audit-fixture", source="TUSHARE_COMPATIBLE") as dataset:
        dataset.db.execute(
            "UPDATE daily_bars SET high = '8' "
            "WHERE instrument_id = 'SH.600000' AND trade_date = '20260915'"
        )
        dataset.db.execute(
            "DELETE FROM adjustment_factors "
            "WHERE instrument_id = 'SH.600000' AND trade_date = '20260915'"
        )
        dataset.db.commit()

    report = audit_market_dataset(root)

    assert not report["passed"]
    assert report["violations"]["invalidDailyOHLC"]["count"] == 1
    assert report["violations"]["dailyMissingAdjustmentFactor"]["count"] == 1


def test_canonical_dataset_audit_validates_block_trade_checkpoint_counts(tmp_path):
    root = build_dataset(tmp_path)
    with MarketDataset(root, dataset_id="audit-fixture", source="TUSHARE_COMPATIBLE") as dataset:
        dataset.write_facts(
            "block_trade_summaries",
            [
                {
                    "instrument_id": "SH.600000",
                    "source_code": "600000.SH",
                    "trade_date": "20260915",
                    "transaction_count": 1,
                    "low_price": "10",
                    "high_price": "10",
                    "volume_shares": "10000",
                    "amount_cny": "100000",
                    "source": "TUSHARE_COMPATIBLE",
                    "available_at": "2026-09-15T21:00:00+08:00",
                    "source_rows_sha256": HASH,
                }
            ],
            key_fields=("instrument_id", "trade_date"),
        )

    report = audit_market_dataset(root)

    assert not report["passed"]
    assert report["violations"]["blockTradeCheckpointCountMismatch"]["count"] == 1
