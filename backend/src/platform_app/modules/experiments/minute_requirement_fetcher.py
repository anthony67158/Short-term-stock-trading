"""Fetch pending episode minutes in bounded, resumable instrument windows."""

import sqlite3
from collections import defaultdict
from datetime import UTC, datetime

from platform_app.adapters.market_tushare import (
    MINUTE_FIELDS,
    HistoricalMarketError,
    normalize_minute,
)
from platform_app.modules.experiments.episode_dataset import (
    EpisodeDataset,
    canonical_sha256,
)
from platform_app.modules.experiments.minute_archive_importer import (
    ingest_minute_requirement,
    reject_minute_requirement,
)

SOURCE_KIND = "TUSHARE_API_STK_MINS_V1"
UPSTREAM_ROW_LIMIT = 8000


class MinuteRequirementFetcher:
    def __init__(self, client, dataset: EpisodeDataset, *, max_sessions: int = 120):
        if not 1 <= max_sessions <= 150:
            raise ValueError("max_sessions must be between 1 and 150")
        self.client = client
        self.dataset = dataset
        self.max_sessions = max_sessions
        uri = f"{dataset.market_database_path.resolve().as_uri()}?mode=ro&immutable=1"
        self.market = sqlite3.connect(uri, uri=True)
        self.market.row_factory = sqlite3.Row

    def close(self) -> None:
        self.market.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def pending_windows(
        self,
        start_date: str,
        end_date: str,
        instrument_ids: list[str] | None = None,
        reasons: list[str] | None = None,
    ) -> list[dict]:
        open_dates = [
            row["cal_date"]
            for row in self.market.execute(
                "SELECT DISTINCT cal_date FROM trade_calendar "
                "WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date",
                (start_date, end_date),
            )
        ]
        date_indexes = {trade_date: index for index, trade_date in enumerate(open_dates)}
        parameters: list[str] = [start_date, end_date]
        instrument_filter = ""
        if instrument_ids:
            placeholders = ",".join("?" for _ in instrument_ids)
            instrument_filter = f" AND r.instrument_id IN ({placeholders})"
            parameters.extend(instrument_ids)
        reason_filter = ""
        if reasons:
            placeholders = ",".join("?" for _ in reasons)
            reason_filter = f" AND r.reason IN ({placeholders})"
            parameters.extend(reasons)
        pending = self.dataset.db.execute(
            "SELECT r.instrument_id, r.trade_date FROM minute_requirements r "
            "LEFT JOIN minute_requirement_resolutions x "
            "ON x.instrument_id = r.instrument_id AND x.trade_date = r.trade_date "
            "WHERE r.status = 'PENDING' AND x.instrument_id IS NULL "
            "AND r.trade_date BETWEEN ? AND ?"
            f"{instrument_filter}{reason_filter} ORDER BY r.instrument_id, r.trade_date",
            parameters,
        ).fetchall()
        canonical_codes = {
            row["instrument_id"]: row["source_code"]
            for row in self.market.execute(
                "SELECT instrument_id, source_code FROM instruments"
            )
        }
        aliases: dict[str, list[sqlite3.Row]] = defaultdict(list)
        for row in self.market.execute(
            "SELECT instrument_id, source_code, effective_from, effective_to "
            "FROM instrument_aliases ORDER BY instrument_id, effective_from"
        ):
            aliases[row["instrument_id"]].append(row)

        by_instrument_source: dict[tuple[str, str], list[str]] = defaultdict(list)
        for row in pending:
            if row["trade_date"] not in date_indexes:
                raise ValueError("MINUTE_REQUIREMENT_DATE_NOT_OPEN")
            if row["instrument_id"] not in canonical_codes:
                raise ValueError("UNKNOWN_INSTRUMENT")
            matching_aliases = [
                alias["source_code"]
                for alias in aliases[row["instrument_id"]]
                if alias["effective_from"] <= row["trade_date"]
                and (
                    alias["effective_to"] is None
                    or row["trade_date"] <= alias["effective_to"]
                )
            ]
            if len(matching_aliases) > 1:
                raise ValueError("MINUTE_SOURCE_ALIAS_AMBIGUOUS")
            source_code = (
                matching_aliases[0]
                if matching_aliases
                else canonical_codes[row["instrument_id"]]
            )
            by_instrument_source[(row["instrument_id"], source_code)].append(
                row["trade_date"]
            )

        windows = []
        for (instrument_id, source_code), dates in by_instrument_source.items():
            remaining = dates
            while remaining:
                first_index = date_indexes[remaining[0]]
                last_index = min(first_index + self.max_sessions - 1, len(open_dates) - 1)
                window_end = open_dates[last_index]
                required_dates = [value for value in remaining if value <= window_end]
                windows.append(
                    {
                        "instrumentId": instrument_id,
                        "sourceCode": source_code,
                        "startDate": open_dates[first_index],
                        "endDate": window_end,
                        "requiredDates": required_dates,
                    }
                )
                remaining = remaining[len(required_dates) :]
        return windows

    def fetch_pending(
        self,
        start_date: str,
        end_date: str,
        *,
        instrument_ids: list[str] | None = None,
        reasons: list[str] | None = None,
        max_windows: int | None = None,
    ):
        windows = self.pending_windows(start_date, end_date, instrument_ids, reasons)
        if max_windows is not None:
            windows = windows[:max_windows]
        for window in windows:
            yield self.fetch_window(window)

    def fetch_window(self, window: dict) -> dict:
        instrument_id = window["instrumentId"]
        source_code = window["sourceCode"]
        start = self._api_time(window["startDate"], "09:30:00")
        end = self._api_time(window["endDate"], "15:00:00")
        params = {"ts_code": source_code, "freq": "5min", "start_date": start, "end_date": end}
        request_hash = canonical_sha256(
            {"apiName": "stk_mins", "fields": MINUTE_FIELDS, "params": params}
        )
        attempted_at = datetime.now(UTC).isoformat()
        try:
            raw_rows = self.client.rows("stk_mins", params, MINUTE_FIELDS)
            if len(raw_rows) >= UPSTREAM_ROW_LIMIT:
                raise HistoricalMarketError("MINUTE_MAY_BE_TRUNCATED")
            if any(str(row.get("ts_code") or "").upper() != source_code for row in raw_rows):
                raise HistoricalMarketError("MINUTE_SOURCE_CODE_MISMATCH")
            raw_rows_by_date: dict[str, list[dict]] = defaultdict(list)
            for row in raw_rows:
                try:
                    timestamp = datetime.strptime(
                        str(row.get("trade_time") or ""),
                        "%Y-%m-%d %H:%M:%S",
                    )
                except ValueError as exc:
                    raise HistoricalMarketError("INVALID_MINUTE_TIME") from exc
                trade_date = timestamp.strftime("%Y%m%d")
                if not window["startDate"] <= trade_date <= window["endDate"]:
                    raise HistoricalMarketError("MINUTE_RESPONSE_OUTSIDE_WINDOW")
                raw_rows_by_date[trade_date].append(row)
        except HistoricalMarketError as exc:
            with self.dataset.db:
                for trade_date in window["requiredDates"]:
                    reject_minute_requirement(
                        self.dataset,
                        instrument_id=instrument_id,
                        trade_date=trade_date,
                        source_kind=SOURCE_KIND,
                        source_asset_sha256=request_hash,
                        reason=str(exc),
                        attempted_at=attempted_at,
                    )
            raise

        response_hash = canonical_sha256(raw_rows)
        aliases = {
            row["source_code"]: f"{row['instrument_id'][3:]}.{row['instrument_id'][:2]}"
            for row in self.market.execute(
                "SELECT source_code, instrument_id FROM instrument_aliases"
            )
        }
        accepted = 0
        rejected = 0
        reasons: dict[str, int] = defaultdict(int)
        for trade_date in window["requiredDates"]:
            with self.dataset.db:
                try:
                    rows = [
                        {
                            **normalize_minute(row, instrument_id, aliases),
                            "tradeDate": trade_date,
                        }
                        for row in raw_rows_by_date[trade_date]
                    ]
                    rows.sort(key=lambda row: row["barEndShanghai"])
                    result = ingest_minute_requirement(
                        self.dataset,
                        self.market,
                        instrument_id=instrument_id,
                        trade_date=trade_date,
                        rows=rows,
                        source_kind=SOURCE_KIND,
                        source_asset_sha256=response_hash,
                        attempted_at=attempted_at,
                    )
                except HistoricalMarketError as exc:
                    result = reject_minute_requirement(
                        self.dataset,
                        instrument_id=instrument_id,
                        trade_date=trade_date,
                        source_kind=SOURCE_KIND,
                        source_asset_sha256=response_hash,
                        reason=str(exc),
                        attempted_at=attempted_at,
                    )
            accepted += result["outcome"] == "ACCEPTED"
            rejected += result["outcome"] == "REJECTED"
            if result["reason"]:
                reasons[result["reason"]] += 1
        return {
            **window,
            "status": "COMPLETED",
            "sourceRows": len(raw_rows),
            "responseSha256": response_hash,
            "accepted": accepted,
            "rejected": rejected,
            "rejectionReasons": dict(sorted(reasons.items())),
        }

    @staticmethod
    def _api_time(trade_date: str, time: str) -> str:
        return f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]} {time}"


__all__ = ["MinuteRequirementFetcher"]
