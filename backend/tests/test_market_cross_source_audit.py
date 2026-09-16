from platform_app.modules.experiments.market_cross_source_audit import audit_cross_sources
from platform_app.modules.experiments.market_dataset import MarketDataset, canonical_sha256


class FakeHistoryClient:
    def __init__(self, source, rows):
        self.source = source
        self.rows = rows
        self.calls = []

    def bars(self, instrument_id, *dates):
        self.calls.append((instrument_id, dates))
        return self.rows.get(instrument_id, {})


def instrument(instrument_id, source_code, board):
    return {
        "instrumentId": instrument_id,
        "sourceCode": source_code,
        "exchange": instrument_id[:2],
        "board": board,
        "name": instrument_id,
        "listStatus": "L",
        "listDate": "20211115",
        "sourceListDate": "20211115",
        "delistDate": None,
        "source": "TUSHARE_COMPATIBLE",
        "availableAt": "2026-09-16T00:00:00+00:00",
        "sourceRowSha256": f"instrument-{instrument_id}",
    }


def daily(instrument_id, source_code, trade_date, *, high="11"):
    return {
        "instrumentId": instrument_id,
        "sourceCode": source_code,
        "tradeDate": trade_date,
        "open": "10",
        "high": high,
        "low": "9",
        "close": "10.5",
        "previousClose": "10",
        "volumeShares": "10000",
        "amountCny": "100000",
        "adjustment": "RAW",
        "sourceRowSha256": f"daily-{instrument_id}-{trade_date}",
    }


def public_bar(trade_date, *, high="11", volume="10050", amount=None):
    row = {
        "tradeDate": trade_date,
        "open": "10",
        "high": high,
        "low": "9",
        "close": "10.5",
        "volumeShares": volume,
    }
    if amount is not None:
        row["amountCny"] = amount
    return row


def dataset(tmp_path):
    root = tmp_path / "dataset"
    with MarketDataset(root, dataset_id="cross-source", source="TUSHARE_COMPATIBLE") as ds:
        ds.write_instruments(
            [
                instrument("SH.600000", "600000.SH", "MAIN"),
                instrument("BJ.920000", "920000.BJ", "BEIJING"),
            ]
        )
        ds.write_daily_bars(
            [
                daily("SH.600000", "600000.SH", "20260915"),
                daily("BJ.920000", "920000.BJ", "20260915"),
            ],
            source="TUSHARE_COMPATIBLE",
            available_at="2026-09-15T16:30:00+08:00",
        )
    return root


def test_cross_source_audit_requires_one_complete_independent_confirmation(tmp_path):
    root = dataset(tmp_path)
    sina = FakeHistoryClient(
        "SINA",
        {
            "SH.600000": {"20260915": public_bar("20260915")},
            "BJ.920000": {"20260915": public_bar("20260915")},
        },
    )
    tencent = FakeHistoryClient(
        "TENCENT",
        {"SH.600000": {"20260915": public_bar("20260915", volume="9950")}},
    )
    eastmoney = FakeHistoryClient(
        "EASTMONEY",
        {
            "SH.600000": {"20260915": public_bar("20260915")},
            "BJ.920000": {"20260915": public_bar("20260915")},
        },
    )

    report = audit_cross_sources(
        root,
        [("SH.600000", "20260915"), ("BJ.920000", "20260915")],
        sina=sina,
        tencent=tencent,
        eastmoney=eastmoney,
        observed_at=lambda: "2026-09-16T02:00:00+00:00",
    )

    assert report["passed"]
    assert report["summary"] == {
        "samples": 2,
        "passed": 2,
        "failed": 0,
        "withSourceConflicts": 0,
        "boards": ["BEIJING", "MAIN"],
    }
    assert report["samples"][1]["matchingIndependentSources"] == ["SINA", "EASTMONEY"]
    assert report["samples"][1]["sources"][1] == {
        "source": "TENCENT",
        "available": False,
        "reason": "DATE_NOT_RETURNED",
    }
    report_hash = report.pop("reportSha256")
    assert report_hash == canonical_sha256(report)


def test_cross_source_audit_discloses_conflict_when_another_source_corroborates(tmp_path):
    root = dataset(tmp_path)
    sina = FakeHistoryClient("SINA", {"SH.600000": {"20260915": public_bar("20260915", high="12")}})
    matching = {"SH.600000": {"20260915": public_bar("20260915")}}

    report = audit_cross_sources(
        root,
        [("SH.600000", "20260915")],
        sina=sina,
        tencent=FakeHistoryClient("TENCENT", matching),
        eastmoney=FakeHistoryClient("EASTMONEY", matching),
    )

    assert report["passed"]
    assert report["summary"]["withSourceConflicts"] == 1
    assert report["samples"][0]["conflictingIndependentSources"] == ["SINA"]


def test_cross_source_audit_fails_price_mismatch(tmp_path):
    root = dataset(tmp_path)
    sina = FakeHistoryClient("SINA", {"SH.600000": {"20260915": public_bar("20260915", high="12")}})
    tencent = FakeHistoryClient(
        "TENCENT", {"SH.600000": {"20260915": public_bar("20260915", high="12")}}
    )
    eastmoney = FakeHistoryClient(
        "EASTMONEY", {"SH.600000": {"20260915": public_bar("20260915", high="12")}}
    )

    report = audit_cross_sources(
        root,
        [("SH.600000", "20260915")],
        sina=sina,
        tencent=tencent,
        eastmoney=eastmoney,
    )

    assert not report["passed"]
    assert report["summary"]["failed"] == 1
    assert not report["samples"][0]["sources"][0]["priceMatches"]["high"]


def test_cross_source_audit_fails_uncorroborated_amount(tmp_path):
    root = dataset(tmp_path)
    mismatched = {"SH.600000": {"20260915": public_bar("20260915", amount="200000")}}

    report = audit_cross_sources(
        root,
        [("SH.600000", "20260915")],
        sina=FakeHistoryClient("SINA", mismatched),
        tencent=FakeHistoryClient("TENCENT", mismatched),
        eastmoney=FakeHistoryClient("EASTMONEY", mismatched),
    )

    assert not report["passed"]
    source = report["samples"][0]["sources"][0]
    assert source["amountDeltaCny"] == "100000"
    assert not source["amountWithinTolerance"]
