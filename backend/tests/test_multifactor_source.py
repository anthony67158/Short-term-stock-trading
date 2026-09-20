import json

import pytest

from platform_app.modules.experiments.multifactor_source import (
    PAGE_SIZE,
    _fetch_partition,
    audit_multifactor_source_archive,
    build_multifactor_source_archive,
    dividend_continuity_as_of,
    financial_metric_snapshots_for_dates,
    financial_periods_for_dates,
    industry_members_as_of,
)


class FakeClient:
    def __init__(self):
        self.calls = []

    def rows(self, api_name, params, fields):
        self.calls.append((api_name, dict(params), fields))
        if api_name == "daily_basic":
            return [{
                "ts_code": "600001.SH",
                "trade_date": params["trade_date"],
                "pe_ttm": 10,
                "pb": 1,
                "ps_ttm": 2,
                "dv_ttm": 3,
                "total_mv": 100,
                "circ_mv": 80,
            }]
        if api_name == "income_vip":
            return [_statement_row(
                params["period"],
                revenue=100,
                profit=10,
            )]
        if api_name == "balancesheet_vip":
            return [_statement_row(
                params["period"],
                assets=200,
                liabilities=80,
                equity=120,
            )]
        if api_name == "cashflow_vip":
            return [_statement_row(params["period"], cash=15)]
        if api_name == "dividend":
            return [{
                "ts_code": "600001.SH",
                "end_date": params["end_date"],
                "ann_date": "20250420",
                "div_proc": "\u5b9e\u65bd",
                "cash_div_tax": 0.2,
                "record_date": "20250601",
                "ex_date": "20250602",
                "pay_date": "20250603",
            }]
        return [{
            "l1_code": "801780.SI",
            "l1_name": "BANK",
            "ts_code": "600001.SH",
            "name": "EXAMPLE",
            "in_date": "20000101",
            "out_date": None,
            "is_new": "Y",
        }]


def _statement_row(
    period,
    *,
    available="20250420",
    revenue=None,
    profit=None,
    assets=None,
    liabilities=None,
    equity=None,
    cash=None,
    update_flag="0",
):
    return {
        "ts_code": "600001.SH",
        "ann_date": available,
        "f_ann_date": available,
        "end_date": period,
        "report_type": "1",
        "comp_type": "1",
        "update_flag": update_flag,
        "revenue": revenue,
        "total_revenue": revenue,
        "n_income_attr_p": profit,
        "total_assets": assets,
        "total_liab": liabilities,
        "total_hldr_eqy_exc_min_int": equity,
        "n_cashflow_act": cash,
    }


def test_financial_periods_cover_three_prior_years():
    periods = financial_periods_for_dates(["20240401", "20260911"])

    assert periods[0] == "20210331"
    assert periods[-1] == "20260630"
    assert "20211231" in periods
    assert "20221231" in periods


def test_source_archive_is_resumable_sealed_and_fully_audited(tmp_path):
    client = FakeClient()
    options = {
        "client": client,
        "output_root": tmp_path,
        "decision_dates": ["20250102", "20250103"],
        "financial_periods": ["20241231"],
        "workers": 2,
    }
    first = build_multifactor_source_archive(**options)
    call_count = len(client.calls)
    second = build_multifactor_source_archive(**options)

    assert first["schemaVersion"] == "multifactor-source-archive.v2"
    assert first["partitionCount"] == 7
    assert first["rowCount"] == 7
    assert second == first
    assert len(client.calls) == call_count

    audit = audit_multifactor_source_archive(
        tmp_path,
        expected_decision_dates=options["decision_dates"],
        expected_financial_periods=options["financial_periods"],
    )
    assert audit["state"] == "READY"
    assert audit["partitionHashesValid"] is True
    assert audit["sources"]["daily_basic"]["partitions"] == 2

    with pytest.raises(ValueError, match="ALREADY_SEALED"):
        build_multifactor_source_archive(
            **{**options, "decision_dates": ["20250102"]}
        )


def test_large_source_partition_is_fetched_with_offsets(tmp_path):
    class PagedClient:
        def __init__(self):
            self.offsets = []

        def rows(self, api_name, params, fields):
            self.offsets.append(params["offset"])
            if params["offset"] == 0:
                return [{"row": index} for index in range(PAGE_SIZE)]
            return [{"row": PAGE_SIZE}]

    client = PagedClient()
    result = _fetch_partition(
        client=client,
        root=tmp_path,
        source="income_vip",
        key="20241231",
        params={"period": "20241231"},
        fields="row",
        maximum_attempts=1,
    )

    assert result["rows"] == PAGE_SIZE + 1
    assert client.offsets == [0, PAGE_SIZE]


def test_unbounded_compatible_response_is_not_requested_twice(tmp_path):
    class UnboundedClient:
        def __init__(self):
            self.calls = 0

        def rows(self, api_name, params, fields):
            self.calls += 1
            return [{"row": index} for index in range(PAGE_SIZE + 1)]

    client = UnboundedClient()
    result = _fetch_partition(
        client=client,
        root=tmp_path,
        source="income_vip",
        key="20241231",
        params={"period": "20241231"},
        fields="row",
        maximum_attempts=1,
    )

    assert result["rows"] == PAGE_SIZE + 1
    assert client.calls == 1


def test_source_fetch_failure_identifies_partition_without_credentials(tmp_path):
    class FailedClient:
        def rows(self, api_name, params, fields):
            raise ValueError("MARKET_DATA_API_FAILED:daily_basic:-2001:DENIED")

    with pytest.raises(
        ValueError,
        match=(
            "MULTIFACTOR_SOURCE_FETCH_FAILED:daily_basic:20250102:"
            "MARKET_DATA_API_FAILED"
        ),
    ):
        _fetch_partition(
            client=FailedClient(),
            root=tmp_path,
            source="daily_basic",
            key="20250102",
            params={"trade_date": "20250102"},
            fields="ts_code",
            maximum_attempts=1,
        )


def test_source_audit_rejects_missing_declared_partition(tmp_path):
    options = {
        "client": FakeClient(),
        "output_root": tmp_path,
        "decision_dates": ["20250102"],
        "financial_periods": ["20241231"],
    }
    build_multifactor_source_archive(**options)
    manifest_path = tmp_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["partitions"] = manifest["partitions"][:-1]
    identity = {
        key: manifest[key]
        for key in (
            "schemaVersion",
            "decisionDates",
            "financialPeriods",
            "partitions",
        )
    }
    from platform_app.modules.experiments.multifactor_source import (
        _canonical_bytes,
    )
    import hashlib

    manifest["contentSha256"] = hashlib.sha256(
        _canonical_bytes(identity)
    ).hexdigest()
    manifest_path.write_text(json.dumps(manifest))

    audit = audit_multifactor_source_archive(tmp_path)

    assert audit["state"] == "RESEARCH"
    assert audit["blockers"] == ["SOURCE_PARTITION_COVERAGE_MISMATCH"]


def test_financial_snapshots_use_only_versions_available_at_cutoff():
    periods = ("20231231", "20240331")
    income = [
        _statement_row("20230331", available="20230420", revenue=80, profit=8),
        _statement_row("20231231", available="20240330", revenue=400, profit=40),
        _statement_row("20240331", available="20240420", revenue=100, profit=12),
        _statement_row(
            "20240331",
            available="20240520",
            revenue=100,
            profit=20,
            update_flag="1",
        ),
    ]
    balance = [
        _statement_row(
            period,
            available="20240330" if period == "20231231" else "20240420",
            assets=200,
            liabilities=80,
            equity=120,
        )
        for period in periods
    ]
    cashflow = [
        _statement_row("20230331", available="20230420", cash=10),
        _statement_row("20231231", available="20240330", cash=50),
        _statement_row("20240331", available="20240420", cash=15),
    ]

    snapshots = financial_metric_snapshots_for_dates(
        income,
        balance,
        cashflow,
        ["20240419", "20240420", "20240520"],
    )

    assert snapshots["20240419"]["600001.SH"]["reportPeriod"] == "20231231"
    april = snapshots["20240420"]["600001.SH"]
    assert april["reportAvailableAt"] == "20240420"
    assert april["netProfitMargin"] == pytest.approx(44 / 420 * 100)
    may = snapshots["20240520"]["600001.SH"]
    assert may["netProfitMargin"] == pytest.approx(52 / 420 * 100)


def test_industry_and_dividend_use_historical_effective_dates():
    industries = [
        {
            "ts_code": "600001.SH",
            "l1_name": "OLD",
            "in_date": "20200101",
            "out_date": "20241231",
        },
        {
            "ts_code": "600001.SH",
            "l1_name": "NEW",
            "in_date": "20250101",
            "out_date": None,
        },
    ]
    dividends = [
        {
            "ts_code": "600001.SH",
            "end_date": f"{year}1231",
            "ex_date": ex_date,
            "cash_div_tax": 1,
            "div_proc": "\u5b9e\u65bd\u5b8c\u6210",
        }
        for year, ex_date in (
            (2022, "20230601"),
            (2023, "20240601"),
            (2024, "20250601"),
        )
    ]

    assert industry_members_as_of(industries, "20241230") == {
        "600001.SH": "OLD"
    }
    assert industry_members_as_of(industries, "20250102") == {
        "600001.SH": "NEW"
    }
    assert dividend_continuity_as_of(dividends, "20250531")[
        "600001.SH"
    ] == pytest.approx(2 / 3)
    assert dividend_continuity_as_of(dividends, "20250602")[
        "600001.SH"
    ] == 1
