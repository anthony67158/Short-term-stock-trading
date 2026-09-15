"""Resumable full-market ingestion with point-in-time coverage checks."""

import json
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from platform_app.adapters.market_tushare import (
    BSE_MAPPING_FIELDS,
    DAILY_FIELDS,
    MINUTE_FIELDS,
    STOCK_BASIC_FIELDS,
    HistoricalMarketError,
    TushareClient,
    instrument_parts,
    normalize_adjustment_factor,
    normalize_bse_mapping,
    normalize_daily,
    normalize_instrument,
    normalize_minute,
    normalize_name_change,
    normalize_suspension,
    normalize_trade_calendar,
)
from platform_app.modules.experiments.official_market_facts import (
    OFFICIAL_CODE_MIGRATIONS,
    OFFICIAL_LISTING_STATUS_PERIODS,
    OFFICIAL_RETIRED_SOURCE_CODES,
)
from platform_app.modules.experiments.market_dataset import (
    MarketDataset,
    MarketDatasetError,
    canonical_sha256,
)

SOURCE = "TUSHARE_COMPATIBLE"
CALENDAR_FIELDS = "exchange,cal_date,is_open,pretrade_date"
ADJUSTMENT_FIELDS = "ts_code,trade_date,adj_factor"
SUSPENSION_FIELDS = "ts_code,trade_date,suspend_timing,suspend_type"
NAME_CHANGE_FIELDS = "ts_code,name,start_date,end_date,ann_date,change_reason"
NAME_CHANGE_PAGE_SIZE = 5000
MINUTE_AMOUNT_TOLERANCE_RATE = Decimal("0.0005")
MINUTE_AMOUNT_TOLERANCE_CNY = Decimal("2")
MINUTE_VOLUME_TOLERANCE_SHARES = Decimal("100")
ALIAS_DECIMAL_TOLERANCE = Decimal("0.0005")


def _observed_at() -> str:
    return datetime.now(UTC).isoformat()


def _historical_available_at(trade_date: str, kind: str) -> str:
    if kind == "adj_factor":
        time = "09:20:00"
    elif kind == "minute":
        time = "21:00:00"
    else:
        time = "16:30:00"
    return f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]}T{time}+08:00"


def _unique(rows: list[dict], key) -> None:
    values = [key(row) for row in rows]
    if len(values) != len(set(values)):
        raise MarketDatasetError("UPSTREAM_DUPLICATE_KEYS")


def _validate_partition_rows(rows: list[dict], trade_date: str) -> list[dict]:
    for row in rows:
        if str(row.get("trade_date") or "") != trade_date:
            raise MarketDatasetError("UPSTREAM_PARTITION_DATE_MISMATCH")
    return rows


def _expected_minute_bar_ends(trade_date: str) -> list[str]:
    date = datetime.strptime(trade_date, "%Y%m%d").strftime("%Y-%m-%d")
    starts = (
        datetime.fromisoformat(f"{date} 09:35:00"),
        datetime.fromisoformat(f"{date} 13:05:00"),
    )
    return [
        (start + timedelta(minutes=5 * offset)).strftime("%Y-%m-%d %H:%M:%S")
        for start in starts
        for offset in range(24)
    ]


def _minute_aggregation(rows: list[dict], daily: dict) -> dict:
    opening = Decimal(rows[0]["open"])
    closing = Decimal(rows[-1]["close"])
    high = max(Decimal(row["high"]) for row in rows)
    low = min(Decimal(row["low"]) for row in rows)
    daily_open = Decimal(daily["open"])
    daily_close = Decimal(daily["close"])
    daily_high = Decimal(daily["high"])
    daily_low = Decimal(daily["low"])
    if opening != daily_open or closing != daily_close:
        raise MarketDatasetError("MINUTE_DAILY_OPEN_CLOSE_MISMATCH")
    if high > daily_high or low < daily_low:
        raise MarketDatasetError("MINUTE_OUTSIDE_DAILY_RANGE")

    volume = sum(Decimal(row["volumeShares"]) for row in rows)
    amount = sum(Decimal(row["amountCny"]) for row in rows)
    daily_volume = Decimal(daily["volume_shares"])
    daily_amount = Decimal(daily["amount_cny"])
    volume_delta = volume - daily_volume
    amount_delta = amount - daily_amount
    if abs(volume_delta) >= MINUTE_VOLUME_TOLERANCE_SHARES:
        raise MarketDatasetError("MINUTE_DAILY_VOLUME_MISMATCH")
    amount_tolerance = max(
        MINUTE_AMOUNT_TOLERANCE_CNY,
        abs(daily_amount) * MINUTE_AMOUNT_TOLERANCE_RATE,
    )
    if abs(amount_delta) > amount_tolerance:
        raise MarketDatasetError("MINUTE_DAILY_AMOUNT_MISMATCH")
    return {
        "open": format(opening, "f"),
        "high": format(high, "f"),
        "low": format(low, "f"),
        "close": format(closing, "f"),
        "volumeShares": format(volume, "f"),
        "amountCny": format(amount, "f"),
        "volumeDeltaShares": format(volume_delta, "f"),
        "amountDeltaCny": format(amount_delta, "f"),
        "amountToleranceCny": format(amount_tolerance, "f"),
    }


def _filter_non_a_share_rows(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    kept = []
    discarded = []
    for row in rows:
        source_code = str(row.get("ts_code") or "").upper()
        code, separator, exchange = source_code.partition(".")
        is_b_share = (
            separator == "."
            and len(code) == 6
            and code.isdigit()
            and (
                (exchange == "SH" and code.startswith("900"))
                or (exchange == "SZ" and code.startswith("200"))
            )
        )
        (discarded if is_b_share else kept).append(row)
    return kept, discarded


def _filter_retired_source_rows(
    rows: list[dict], trade_date: str
) -> tuple[list[dict], list[dict]]:
    retired_from = {
        fact["source_code"]: fact["retired_from"] for fact in OFFICIAL_RETIRED_SOURCE_CODES
    }
    kept = []
    discarded = []
    for row in rows:
        source_code = str(row.get("ts_code") or "").upper()
        is_retired = source_code in retired_from and trade_date >= retired_from[source_code]
        (discarded if is_retired else kept).append(row)
    return kept, discarded


def _filter_pre_listing_bse_rows(
    rows: list[dict],
    *,
    trade_date: str,
    aliases: dict[str, str],
    lifecycles: dict[str, dict[str, str | None]],
) -> tuple[list[dict], list[dict]]:
    kept = []
    discarded = []
    for row in rows:
        source_code = str(row.get("ts_code") or "").upper()
        canonical_code = aliases.get(source_code, source_code)
        code, exchange, _ = instrument_parts(canonical_code)
        instrument_id = f"{exchange}.{code}"
        lifecycle = lifecycles.get(instrument_id)
        if lifecycle and lifecycle["board"] == "BEIJING" and trade_date < lifecycle["list_date"]:
            discarded.append(row)
        else:
            kept.append(row)
    return kept, discarded


def _filter_post_delisting_adjustments(
    raw_rows: list[dict],
    normalized_rows: list[dict],
    *,
    trade_date: str,
    eligible_ids: set[str],
    lifecycles: dict[str, dict[str, str | None]],
) -> tuple[list[dict], list[dict]]:
    kept = []
    discarded = []
    for raw, normalized in zip(raw_rows, normalized_rows, strict=True):
        instrument_id = normalized["instrument_id"]
        lifecycle = lifecycles.get(instrument_id)
        if (
            instrument_id not in eligible_ids
            and lifecycle
            and lifecycle["delist_date"]
            and trade_date >= lifecycle["delist_date"]
        ):
            discarded.append(raw)
        else:
            kept.append(normalized)
    return kept, discarded


def _discard_audit(rows: list[dict]) -> dict:
    ordered = sorted(
        rows,
        key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
    )
    return {"count": len(ordered), "sourceRowsSha256": canonical_sha256(ordered)}


def _deduplicate_exact_rows(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    kept_by_payload = {}
    discarded = []
    for row in rows:
        payload = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if payload in kept_by_payload:
            discarded.append(row)
        else:
            kept_by_payload[payload] = row
    return list(kept_by_payload.values()), discarded


def _deduplicate_alias_rows(
    rows: list[dict],
    *,
    key,
    preferred_source_code,
    decimal_fields: frozenset[str] = frozenset(),
) -> tuple[list[dict], list[dict]]:
    grouped: dict[tuple, list[dict]] = {}
    for row in rows:
        grouped.setdefault(key(row), []).append(row)
    kept = []
    discarded = []
    ignored = {
        "sourceCode",
        "source_code",
        "sourceRowSha256",
        "source_row_sha256",
    }
    for item_key, candidates in grouped.items():
        if len(candidates) == 1:
            kept.append(candidates[0])
            continue
        source_codes = [row.get("sourceCode", row.get("source_code")) for row in candidates]
        if len(source_codes) != len(set(source_codes)):
            raise MarketDatasetError("UPSTREAM_DUPLICATE_KEYS")
        comparable = [
            {field: value for field, value in row.items() if field not in ignored}
            for row in candidates
        ]
        reference = comparable[0]
        conflicts = []
        for candidate in comparable[1:]:
            for field in reference.keys() | candidate.keys():
                if reference.get(field) == candidate.get(field):
                    continue
                if field in decimal_fields:
                    left = Decimal(str(reference.get(field)))
                    right = Decimal(str(candidate.get(field)))
                    shared_exponent = max(left.as_tuple().exponent, right.as_tuple().exponent)
                    quantum = Decimal(1).scaleb(shared_exponent)
                    if (
                        abs(left - right) <= ALIAS_DECIMAL_TOLERANCE
                        and left.quantize(quantum, rounding=ROUND_HALF_UP)
                        == right.quantize(quantum, rounding=ROUND_HALF_UP)
                    ):
                        continue
                conflicts.append(field)
        if conflicts:
            raise MarketDatasetError("UPSTREAM_ALIAS_VALUE_CONFLICT")
        preferred = preferred_source_code(item_key[0], item_key[1])
        selected = [
            row
            for row, source_code in zip(candidates, source_codes, strict=True)
            if source_code == preferred
        ]
        if len(selected) != 1:
            raise MarketDatasetError("UPSTREAM_ALIAS_IDENTITY_CONFLICT")
        kept.append(selected[0])
        discarded.extend(row for row in candidates if row is not selected[0])
    return kept, discarded


def _listing_status_rows(known_ids: set[str], observed_at: str) -> list[dict]:
    rows = []
    for fact in OFFICIAL_LISTING_STATUS_PERIODS:
        if fact["instrument_id"] not in known_ids:
            continue
        source_value = {key: value for key, value in fact.items() if key != "source_urls"}
        source_value["source_urls"] = list(fact["source_urls"])
        rows.append(
            {
                **source_value,
                "source": "OFFICIAL_EXCHANGE",
                "source_urls_json": json.dumps(
                    fact["source_urls"], ensure_ascii=False, separators=(",", ":")
                ),
                "evidence_observed_at": observed_at,
                "source_row_sha256": canonical_sha256(source_value),
            }
        )
        del rows[-1]["source_urls"]
    return rows


def _official_alias_rows(known_ids: set[str], observed_at: str) -> list[dict]:
    rows = []
    for fact in OFFICIAL_CODE_MIGRATIONS:
        if fact["instrument_id"] not in known_ids:
            continue
        source_value = {key: value for key, value in fact.items() if key != "source_urls"}
        source_value["source_urls"] = list(fact["source_urls"])
        rows.append(
            {
                "sourceCode": fact["source_code"],
                "instrumentId": fact["instrument_id"],
                "effectiveFrom": fact["effective_from"],
                "effectiveTo": fact["effective_to"],
                "reason": fact["reason"],
                "source": "OFFICIAL_EXCHANGE",
                "sourceUrlsJson": json.dumps(
                    fact["source_urls"], ensure_ascii=False, separators=(",", ":")
                ),
                "availableAt": observed_at,
                "sourceRowSha256": canonical_sha256(source_value),
            }
        )
    return rows


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
        rows = self.dataset.db.execute("SELECT source_code, instrument_id FROM instrument_aliases")
        return {
            row["source_code"]: (f"{row['instrument_id'][3:]}.{row['instrument_id'][:2]}")
            for row in rows
        }

    def sync_official_listing_statuses(self) -> dict:
        known_ids = {
            row["instrument_id"]
            for row in self.dataset.db.execute("SELECT instrument_id FROM instruments")
        }
        observed_at = self.observed_at()
        rows = _listing_status_rows(known_ids, observed_at)
        payload = [
            {key: value for key, value in row.items() if key != "evidence_observed_at"}
            for row in rows
        ]
        facts_hash = canonical_sha256(payload)
        partition_key = f"listing-status-periods:{facts_hash}"
        if self.dataset.has_checkpoint("official_market_facts", partition_key):
            return {"status": "SKIPPED", "listingStatusPeriods": len(rows)}
        self.dataset.write_facts(
            "listing_status_periods",
            rows,
            key_fields=("instrument_id", "status", "effective_from"),
            ignored_on_replay=("evidence_observed_at",),
        )
        self.dataset.checkpoint(
            "official_market_facts",
            partition_key,
            payload,
            source="OFFICIAL_EXCHANGE",
            first_seen_at=observed_at,
            available_at=observed_at,
            availability_method="DIRECT_OBSERVATION",
        )
        return {"status": "COMPLETED", "listingStatusPeriods": len(rows)}

    def sync_name_changes(self, start_date: str, end_date: str) -> dict:
        partition_key = f"{start_date}:{end_date}"
        if self.dataset.has_checkpoint("name_changes", partition_key):
            return {"status": "SKIPPED"}

        raw_rows = []
        first_page = None
        for page in range(20):
            rows = self.client.rows(
                "namechange",
                {"offset": page * NAME_CHANGE_PAGE_SIZE, "limit": NAME_CHANGE_PAGE_SIZE},
                NAME_CHANGE_FIELDS,
            )
            if len(rows) > NAME_CHANGE_PAGE_SIZE:
                raise MarketDatasetError("NAME_CHANGE_PAGE_MAY_BE_TRUNCATED")
            if first_page is None:
                first_page = rows
            raw_rows.extend(rows)
            if len(rows) < NAME_CHANGE_PAGE_SIZE:
                break
        else:
            raise MarketDatasetError("NAME_CHANGE_PAGINATION_LIMIT")

        replayed_first_page = self.client.rows(
            "namechange",
            {"offset": 0, "limit": NAME_CHANGE_PAGE_SIZE},
            NAME_CHANGE_FIELDS,
        )
        if canonical_sha256(first_page or []) != canonical_sha256(replayed_first_page):
            raise MarketDatasetError("NAME_CHANGE_SOURCE_CHANGED_DURING_SYNC")

        raw_rows, exact_duplicates = _deduplicate_exact_rows(raw_rows)
        aliases = self.aliases()
        known_ids = {
            row["instrument_id"]
            for row in self.dataset.db.execute("SELECT instrument_id FROM instruments")
        }
        normalized = []
        for row in raw_rows:
            effective_date = max(
                str(row.get("start_date") or ""),
                str(row.get("ann_date") or ""),
            )
            item = normalize_name_change(
                row,
                aliases,
                _historical_available_at(effective_date, "name_change"),
            )
            if (
                item["instrument_id"] in known_ids
                and item["start_date"] <= end_date
                and (item["end_date"] is None or item["end_date"] >= start_date)
            ):
                normalized.append(item)
        normalized, alias_duplicates = _deduplicate_alias_rows(
            normalized,
            key=lambda row: (row["instrument_id"], row["start_date"], row["name"]),
            preferred_source_code=self.dataset.source_code_for_date,
        )
        normalized.sort(key=lambda row: (row["instrument_id"], row["start_date"], row["name"]))
        self.dataset.write_facts(
            "name_changes",
            normalized,
            key_fields=("instrument_id", "start_date", "name"),
        )
        self.dataset.checkpoint(
            "name_changes",
            partition_key,
            normalized,
            source=SOURCE,
            first_seen_at=self.observed_at(),
            availability_method="RECONSTRUCTED_FROM_VENDOR_ANNOUNCEMENT_DATE",
            details={
                "rawRows": len(raw_rows) + len(exact_duplicates),
                "discardedExactDuplicates": _discard_audit(exact_duplicates),
                "discardedAliasDuplicates": _discard_audit(alias_duplicates),
            },
        )
        return {
            "status": "COMPLETED",
            "nameChanges": len(normalized),
            "discardedExactDuplicates": len(exact_duplicates),
            "discardedAliasDuplicates": len(alias_duplicates),
        }

    def sync_reference(self, start_date: str, end_date: str) -> dict:
        if self.dataset.has_checkpoint("reference", f"{start_date}:{end_date}"):
            return {"status": "SKIPPED"}
        observed_at = self.observed_at()
        raw_mappings = self.client.rows("bse_mapping", {}, BSE_MAPPING_FIELDS)
        mappings = [normalize_bse_mapping(row, observed_at) for row in raw_mappings]
        _unique(mappings, lambda row: row["sourceCode"])
        aliases = {raw["o_code"]: raw["n_code"] for raw in raw_mappings}
        aliases.update(
            {row["source_code"]: row["canonical_source_code"] for row in OFFICIAL_CODE_MIGRATIONS}
        )

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
            row
            for row in raw_instruments
            if str(row.get("list_date") or "") <= end_date
            and (not row.get("delist_date") or str(row["delist_date"]) > start_date)
        ]
        normalized = [normalize_instrument(row, aliases, observed_at) for row in raw_instruments]
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
        if {row["board"] for row in instruments.values()} != {"MAIN", "CHINEXT", "STAR", "BEIJING"}:
            raise MarketDatasetError("INSTRUMENT_BOARD_COVERAGE_INCOMPLETE")

        raw_calendar = self.client.rows(
            "trade_cal",
            {"exchange": "SSE", "start_date": start_date, "end_date": end_date},
            CALENDAR_FIELDS,
        )
        calendar = [normalize_trade_calendar(row, observed_at) for row in raw_calendar]
        _unique(calendar, lambda row: (row["exchange"], row["cal_date"]))

        self.dataset.write_instruments(
            sorted(instruments.values(), key=lambda row: row["instrumentId"])
        )
        known_ids = set(instruments)
        mappings = [row for row in mappings if row["instrumentId"] in known_ids]
        mappings.extend(_official_alias_rows(known_ids, observed_at))
        _unique(mappings, lambda row: row["sourceCode"])
        listing_statuses = _listing_status_rows(known_ids, observed_at)
        self.dataset.write_aliases(mappings)
        self.dataset.write_facts(
            "trade_calendar",
            calendar,
            key_fields=("exchange", "cal_date"),
            ignored_on_replay=("available_at",),
        )
        self.dataset.write_facts(
            "listing_status_periods",
            listing_statuses,
            key_fields=("instrument_id", "status", "effective_from"),
            ignored_on_replay=("evidence_observed_at",),
        )
        payload = [
            *sorted(instruments.values(), key=lambda row: row["instrumentId"]),
            *mappings,
            *listing_statuses,
        ]
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
            "listingStatusPeriods": len(listing_statuses),
        }

    def sync_daily_partition(self, trade_date: str) -> dict:
        self.sync_official_listing_statuses()
        if self.dataset.has_checkpoint("daily", trade_date):
            return {"status": "SKIPPED", "tradeDate": trade_date}
        observed_at = self.observed_at()
        aliases = self.aliases()
        expected = set(self.dataset.eligible_instruments(trade_date))
        lifecycles = self.dataset.instrument_lifecycles()
        raw_daily = _validate_partition_rows(
            self.client.rows("daily", {"trade_date": trade_date}, DAILY_FIELDS),
            trade_date,
        )
        if len(raw_daily) >= 6000:
            raise MarketDatasetError("DAILY_MAY_BE_TRUNCATED")
        raw_daily, retired_daily = _filter_retired_source_rows(raw_daily, trade_date)
        raw_daily, non_a_share_daily = _filter_non_a_share_rows(raw_daily)
        raw_daily, pre_listing_daily = _filter_pre_listing_bse_rows(
            raw_daily,
            trade_date=trade_date,
            aliases=aliases,
            lifecycles=lifecycles,
        )
        daily = [normalize_daily(row, aliases) for row in raw_daily]
        daily, duplicate_daily = _deduplicate_alias_rows(
            daily,
            key=lambda row: (row["instrumentId"], row["tradeDate"]),
            preferred_source_code=self.dataset.source_code_for_date,
        )

        raw_factors = _validate_partition_rows(
            self.client.rows("adj_factor", {"trade_date": trade_date}, ADJUSTMENT_FIELDS),
            trade_date,
        )
        raw_factors, retired_factors = _filter_retired_source_rows(raw_factors, trade_date)
        raw_factors, non_a_share_factors = _filter_non_a_share_rows(raw_factors)
        raw_factors, pre_listing_factors = _filter_pre_listing_bse_rows(
            raw_factors,
            trade_date=trade_date,
            aliases=aliases,
            lifecycles=lifecycles,
        )
        factors = [
            normalize_adjustment_factor(
                row, aliases, _historical_available_at(trade_date, "adj_factor")
            )
            for row in raw_factors
        ]
        factors, post_delisting_factors = _filter_post_delisting_adjustments(
            raw_factors,
            factors,
            trade_date=trade_date,
            eligible_ids=expected,
            lifecycles=lifecycles,
        )
        factors, duplicate_factors = _deduplicate_alias_rows(
            factors,
            key=lambda row: (row["instrument_id"], row["trade_date"]),
            preferred_source_code=self.dataset.source_code_for_date,
            decimal_fields=frozenset({"factor"}),
        )

        raw_suspensions = _validate_partition_rows(
            self.client.rows("suspend_d", {"trade_date": trade_date}, SUSPENSION_FIELDS),
            trade_date,
        )
        raw_suspensions, retired_suspensions = _filter_retired_source_rows(
            raw_suspensions, trade_date
        )
        raw_suspensions, non_a_share_suspensions = _filter_non_a_share_rows(raw_suspensions)
        raw_suspensions, pre_listing_suspensions = _filter_pre_listing_bse_rows(
            raw_suspensions,
            trade_date=trade_date,
            aliases=aliases,
            lifecycles=lifecycles,
        )
        suspensions = [
            normalize_suspension(row, aliases, _historical_available_at(trade_date, "suspension"))
            for row in raw_suspensions
        ]
        suspensions, duplicate_suspensions = _deduplicate_alias_rows(
            suspensions,
            key=lambda row: (
                row["instrument_id"],
                row["trade_date"],
                row["suspend_type"],
                row["suspend_timing"],
            ),
            preferred_source_code=self.dataset.source_code_for_date,
        )

        bar_ids = {row["instrumentId"] for row in daily}
        factor_ids = {row["instrument_id"] for row in factors}
        suspended = {row["instrument_id"] for row in suspensions if row["suspend_type"] == "S"}
        if bar_ids - expected:
            raise MarketDatasetError("DAILY_HAS_OUT_OF_UNIVERSE_INSTRUMENTS")
        if factor_ids - expected:
            raise MarketDatasetError("ADJUSTMENT_HAS_OUT_OF_UNIVERSE_INSTRUMENTS")
        suspension_ids = {row["instrument_id"] for row in suspensions}
        if suspension_ids - expected:
            raise MarketDatasetError("SUSPENSION_HAS_OUT_OF_UNIVERSE_INSTRUMENTS")
        if bar_ids - factor_ids:
            raise MarketDatasetError("ADJUSTMENT_FACTOR_COVERAGE_INCOMPLETE")
        status_explanations = set(self.dataset.listing_status_explanations(trade_date))
        unexplained = expected - bar_ids - suspended - status_explanations
        if unexplained:
            raise MarketDatasetError(f"DAILY_COVERAGE_INCOMPLETE:{len(unexplained)}")

        available_at = _historical_available_at(trade_date, "daily")
        self.dataset.write_daily_bars(daily, source=SOURCE, available_at=available_at)
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
            details={
                "discardedRetiredSourceRows": {
                    "daily": _discard_audit(retired_daily),
                    "adjustmentFactors": _discard_audit(retired_factors),
                    "suspensions": _discard_audit(retired_suspensions),
                },
                "discardedNonAShareRows": {
                    "daily": _discard_audit(non_a_share_daily),
                    "adjustmentFactors": _discard_audit(non_a_share_factors),
                    "suspensions": _discard_audit(non_a_share_suspensions),
                },
                "discardedPreListingBseRows": {
                    "daily": _discard_audit(pre_listing_daily),
                    "adjustmentFactors": _discard_audit(pre_listing_factors),
                    "suspensions": _discard_audit(pre_listing_suspensions),
                },
                "discardedPostDelistingAdjustmentFactors": _discard_audit(post_delisting_factors),
                "discardedAliasDuplicates": {
                    "daily": _discard_audit(duplicate_daily),
                    "adjustmentFactors": _discard_audit(duplicate_factors),
                    "suspensions": _discard_audit(duplicate_suspensions),
                },
                "listingStatusExplanations": sorted(status_explanations & (expected - bar_ids)),
            },
        )
        return {
            "status": "COMPLETED",
            "tradeDate": trade_date,
            "dailyBars": len(daily),
            "adjustmentFactors": len(factors),
            "suspensions": len(suspensions),
            "discardedRetiredSourceRows": sum(
                map(len, (retired_daily, retired_factors, retired_suspensions))
            ),
            "discardedNonAShareRows": sum(
                map(
                    len,
                    (
                        non_a_share_daily,
                        non_a_share_factors,
                        non_a_share_suspensions,
                    ),
                )
            ),
            "discardedPreListingBseRows": sum(
                map(
                    len,
                    (
                        pre_listing_daily,
                        pre_listing_factors,
                        pre_listing_suspensions,
                    ),
                )
            ),
            "discardedPostDelistingAdjustmentFactors": len(post_delisting_factors),
            "discardedAliasDuplicates": sum(
                map(len, (duplicate_daily, duplicate_factors, duplicate_suspensions))
            ),
        }

    def sync_minute_partition(self, instrument_id: str, trade_date: str) -> dict:
        partition_key = f"{instrument_id}:{trade_date}"
        if self.dataset.has_checkpoint("minute_5min", partition_key):
            return {
                "status": "SKIPPED",
                "instrumentId": instrument_id,
                "tradeDate": trade_date,
            }
        if not self.dataset.has_checkpoint("daily", trade_date):
            raise MarketDatasetError("MINUTE_REQUIRES_VALIDATED_DAILY_PARTITION")
        daily = self.dataset.db.execute(
            "SELECT * FROM daily_bars WHERE instrument_id = ? AND trade_date = ?",
            (instrument_id, trade_date),
        ).fetchone()
        if not daily:
            raise MarketDatasetError("MINUTE_DAILY_BAR_MISSING")

        source_code = self.dataset.db.execute(
            "SELECT source_code FROM instruments WHERE instrument_id = ?",
            (instrument_id,),
        ).fetchone()["source_code"]
        date = datetime.strptime(trade_date, "%Y%m%d").strftime("%Y-%m-%d")
        raw_rows = self.client.rows(
            "stk_mins",
            {
                "ts_code": source_code,
                "freq": "5min",
                "start_date": f"{date} 09:30:00",
                "end_date": f"{date} 15:00:00",
            },
            MINUTE_FIELDS,
        )
        if len(raw_rows) >= 8000:
            raise MarketDatasetError("MINUTE_MAY_BE_TRUNCATED")
        aliases = self.aliases()
        rows = [normalize_minute(row, instrument_id, aliases) for row in raw_rows]
        if any(row["sourceCode"] != source_code for row in rows):
            raise MarketDatasetError("MINUTE_SOURCE_CODE_MISMATCH")
        rows.sort(key=lambda row: row["barEndShanghai"])
        if [row["barEndShanghai"] for row in rows] != _expected_minute_bar_ends(trade_date):
            raise MarketDatasetError("MINUTE_SESSION_INCOMPLETE")
        aggregation = _minute_aggregation(rows, dict(daily))

        observed_at = self.observed_at()
        available_at = _historical_available_at(trade_date, "minute")
        stored = [
            {
                "instrument_id": row["instrumentId"],
                "source_code": row["sourceCode"],
                "bar_end_shanghai": row["barEndShanghai"],
                "frequency": row["frequency"],
                "open": row["open"],
                "high": row["high"],
                "low": row["low"],
                "close": row["close"],
                "volume_shares": row["volumeShares"],
                "amount_cny": row["amountCny"],
                "adjustment": row["adjustment"],
                "source": SOURCE,
                "available_at": available_at,
                "source_row_sha256": row["sourceRowSha256"],
            }
            for row in rows
        ]
        self.dataset.write_facts(
            "minute_bars",
            stored,
            key_fields=("instrument_id", "bar_end_shanghai", "frequency"),
        )
        self.dataset.checkpoint(
            "minute_5min",
            partition_key,
            rows,
            source=SOURCE,
            first_seen_at=observed_at,
            available_at=available_at,
            availability_method="RECONSTRUCTED_FROM_VENDOR_SCHEDULE",
            details={
                "aggregation": aggregation,
                "dailySourceRowSha256": daily["source_row_sha256"],
            },
        )
        return {
            "status": "COMPLETED",
            "instrumentId": instrument_id,
            "tradeDate": trade_date,
            "minuteBars": len(rows),
            "volumeDeltaShares": aggregation["volumeDeltaShares"],
            "amountDeltaCny": aggregation["amountDeltaCny"],
        }


__all__ = ["HistoricalMarketError", "MarketDatasetBuilder", "MarketDatasetError"]
