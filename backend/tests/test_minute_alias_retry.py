from platform_app.modules.experiments.episode_dataset import EpisodeDataset, canonical_sha256
from platform_app.modules.experiments.minute_requirement_builder import MinuteRequirementBuilder
from platform_app.modules.experiments.minute_requirement_fetcher import MinuteRequirementFetcher
from platform_app.modules.experiments.short_horizon_policy import SHORT_HORIZON_POLICY
from test_minute_requirement_builder import (
    _sealed_market, _tushare_minute_rows, _write_candidate,
)


def test_empty_historical_alias_retries_mapped_current_code_and_validates_day(tmp_path):
    alias = {
        "sourceCode": "000002.SZ", "instrumentId": "SZ.000001",
        "effectiveFrom": "20260102", "effectiveTo": "20260102",
        "reason": "TEST_CODE_MIGRATION", "source": "TEST", "sourceUrlsJson": "[]",
        "availableAt": "2026-01-01T16:30:00+08:00",
        "sourceRowSha256": canonical_sha256({"alias": "000002.SZ"}),
    }
    market, dates = _sealed_market(tmp_path, aliases=[alias])
    calls = []

    class Client:
        def rows(self, api, params, fields):
            calls.append(params["ts_code"])
            return [] if params["ts_code"] == "000002.SZ" else _tushare_minute_rows([dates[1]])

    with EpisodeDataset(
        tmp_path / "episodes", dataset_id="retry",
        market_dataset_root=market, policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        with MinuteRequirementFetcher(Client(), dataset) as fetcher:
            result = list(fetcher.fetch_pending(dates[1], dates[1]))[0]
        assert calls == ["000002.SZ", "000001.SZ"]
        assert result["accepted"] == 1
        assert result["sourceCode"] == "000002.SZ"
        assert result["responseSourceCode"] == "000001.SZ"
        assert dataset.db.execute("SELECT count(*) FROM episode_minute_bars").fetchone()[0] == 48
