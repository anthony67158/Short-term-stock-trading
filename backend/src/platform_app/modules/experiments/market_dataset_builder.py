"""Resumable full-market ingestion with point-in-time coverage checks."""

from datetime import UTC, datetime

from platform_app.adapters.market_tushare import (
    BSE_MAPPING_FIELDS,
    DAILY_FIELDS,
    STOCK_BASIC_FIELDS,
    HistoricalMarketError,
    TushareClient,
    normalize_adjustment_factor,
    normalize_bse_mapping,
    normalize_daily,
    normalize_instrument,
    normalize_suspension,
    normalize_trade_calendar,
)
from platform_app.modules.experiments.market_dataset import (
    MarketDataset,
    MarketDatasetError,
)

SOURCE = "TUSHARE_COMPATIBLE"
CALENDAR_FIELDS = "exchange,cal_date,is_open,pretrade_date"
ADJUSTMENT_FIELDS = "ts_code,trade_date,adj_factor"
SUSPENSION_FIELDS = "ts_code,trade_date,suspend_timing,suspend_type"


def _observed_at() -> str:
    return datetime.now(UTC).isoformat()


def _historical_available_at(trade_date: str, kind: str) -> str:
    time = "09:20:00" if kind == "adj_factor" else "16:30:00"
    return f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]}T{time}+08:00"


def _unique(rows: list[dict], key) -> None:
    values = [key(row) for row in rows]
    if len(values) != len(set(values)):
        raise MarketDatasetError("UPSTREAM_DUPLICATE_KEYS")


class MarketDatasetBuilder:
    def __init__(
        self,
        client: TushareClient,
        dataset: MarketDataset,
        *,
        observed_at=_observed_at,
    ):
        self.client = client
        self.dataset = dataset
        self.observed_at = observed_at

    def aliases(self) -> dict[str, str]:
        rows = self.dataset.db.execute(
            "SELECT source_code, instrument_id FROM instrument_aliases"
        )
        return {
            row["source_code"]: f"{row['instrument_id'][3:]}.BJ"
            for row in rows
        }

    def sync_reference(self, start_date: str, end_date: str) -> dict:
        if self.dataset.has_checkpoint("reference", f"{start_date}:{end_date}"):
            return {"status": "SKIPPED"}
        observed_at = self.observed_at()
        raw_mappings = self.client.rows("bse_mapping", {}, BSE_MAPPING_FIELDS)
        mappings = [normalize_bse_mapping(row, observed_at) for row in raw_mappings]
        _unique(mappings, lambda row: row["sourceCode"])
        aliases = {
            raw["o_code"]: raw["n_code"]
            for raw in raw_mappings
        }

        raw_instruments = []
        for status in ("L", "D", "P"):
            rows = self.client.rows(
                "stock_basic",
                {"exchange": "", "list_status": status},
                STOCK_BASIC_FIELDS,
            )
            if len(rows) >= 6000:
                raise MarketDatasetError("STOCK_BASIC_MAY_BE_TRUNCATED")
            raw_instruments.extend(rows)
        raw_instruments = [
            row for row in raw_instruments
            if str(row.get("list_date") or "") <= end_date
            and (
                not row.get("delist_date")
                or str(row["delist_date"]) >= start_date
            )
        ]
        normalized = [
            normalize_instrument(row, aliases, observed_at)
            for row in raw_instruments
        ]
        instruments: dict[str, dict] = {}
        for row in normalized:
            current = instruments.get(row["instrumentId"])
            if current and current["sourceCode"] != row["sourceCode"]:
                canonical_source = f"{row['instrumentId'][3:]}.BJ"
                instruments[row["instrumentId"]] = (
                    row if row["sourceCode"] == canonical_source else current
                )
            elif current and current != row:
                raise MarketDatasetError("INSTRUMENT_SOURCE_CONFLICT")
            else:
                instruments[row["instrumentId"]] = row
        if {row["board"] for row in instruments.values()} != {
            "MAIN", "CHINEXT", "STAR", "BEIJING"
        }:
            raise MarketDatasetError("INSTRUMENT_BOARD_COVERAGE_INCOMPLETE")

        raw_calendar = self.client.rows(
            "trade_cal",
            {"exchange": "SSE", "start_date": start_date, "end_date": end_date},
            CALENDAR_FIELDS,
        )
        calendar = [normalize_trade_calendar(row, observed_at) for row in raw_calendar]
        _unique(calendar, lambda row: (row["exchange"], row["cal_date"]))

        self.dataset.write_instruments(sorted(instruments.values(), key=lambda row: row["instrumentId"]))
        known_ids = set(instruments)
        mappings = [row for row in mappings if row["instrumentId"] in known_ids]
        self.dataset.write_aliases(mappings)
        self.dataset.write_facts(
            "trade_calendar", calendar, key_fields=("exchange", "cal_date")
        )
        payload = [*sorted(instruments.values(), key=lambda row: row["instrumentId"]), *mappings]
        self.dataset.checkpoint(
            "reference",
            f"{start_date}:{end_date}",
            payload,
            source=SOURCE,
            first_seen_at=observed_at,
            available_at=observed_at,
            availability_method="DIRECT_OBSERVATION",
        )
        return {
            "status": "COMPLETED",
            "instruments": len(instruments),
            "aliases": len(mappings),
            "calendarDays": len(calendar),
        }

    def sync_daily_partition(self, trade_date: str) -> dict:
        if self.dataset.has_checkpoint("daily", trade_date):
            return {"status": "SKIPPED", "tradeDate": trade_date}
        observed_at = self.observed_at()
        aliases = self.aliases()
        raw_daily = self.client.rows("daily", {"trade_date": trade_date}, DAILY_FIELDS)
        if len(raw_daily) >= 6000:
            raise MarketDatasetError("DAILY_MAY_BE_TRUNCATED")
        daily = [normalize_daily(row, aliases) for row in raw_daily]
        _unique(daily, lambda row: (row["instrumentId"], row["tradeDate"]))

        raw_factors = self.client.rows(
            "adj_factor", {"trade_date": trade_date}, ADJUSTMENT_FIELDS
        )
        factors = [
            normalize_adjustment_factor(
                row, aliases, _historical_available_at(trade_date, "adj_factor")
            )
            for row in raw_factors
        ]
        _unique(factors, lambda row: (row["instrument_id"], row["trade_date"]))

        raw_suspensions = self.client.rows(
            "suspend_d", {"trade_date": trade_date}, SUSPENSION_FIELDS
        )
        suspensions = [
            normalize_suspension(
                row, aliases, _historical_available_at(trade_date, "suspension")
            )
            for row in raw_suspensions
        ]
        _unique(
            suspensions,
            lambda row: (
                row["instrument_id"], row["trade_date"],
                row["suspend_type"], row["suspend_timing"],
            ),
        )

        expected = set(self.dataset.eligible_instruments(trade_date))
        bar_ids = {row["instrumentId"] for row in daily}
        factor_ids = {row["instrument_id"] for row in factors}
        suspended = {
            row["instrument_id"]
            for row in suspensions
            if row["suspend_type"] == "S"
        }
        if bar_ids - expected:
            raise MarketDatasetError("DAILY_HAS_OUT_OF_UNIVERSE_INSTRUMENTS")
        if bar_ids - factor_ids:
            raise MarketDatasetError("ADJUSTMENT_FACTOR_COVERAGE_INCOMPLETE")
        unexplained = expected - bar_ids - suspended
        if unexplained:
            raise MarketDatasetError(
                f"DAILY_COVERAGE_INCOMPLETE:{len(unexplained)}"
            )

        available_at = _historical_available_at(trade_date, "daily")
        self.dataset.write_daily_bars(
            daily, source=SOURCE, available_at=available_at
        )
        self.dataset.write_facts(
            "adjustment_factors",
            factors,
            key_fields=("instrument_id", "trade_date"),
        )
        self.dataset.write_facts(
            "suspensions",
            suspensions,
            key_fields=("instrument_id", "trade_date", "suspend_type", "suspend_timing"),
        )
        payload = {
            "daily": daily,
            "adjustmentFactors": factors,
            "suspensions": suspensions,
        }
        self.dataset.checkpoint(
            "daily",
            trade_date,
            [payload],
            source=SOURCE,
            first_seen_at=observed_at,
            available_at=available_at,
            availability_method="RECONSTRUCTED_FROM_VENDOR_SCHEDULE",
        )
        return {
            "status": "COMPLETED",
            "tradeDate": trade_date,
            "dailyBars": len(daily),
            "adjustmentFactors": len(factors),
            "suspensions": len(suspensions),
        }


__all__ = ["HistoricalMarketError", "MarketDatasetBuilder", "MarketDatasetError"]
