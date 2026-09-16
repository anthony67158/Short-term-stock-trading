"""Causal full-universe candidate generation from a sealed market dataset."""

import sqlite3
from collections import Counter, defaultdict
from decimal import Decimal, localcontext

from platform_app.modules.experiments.episode_dataset import (
    BOARDS,
    EpisodeDataset,
    EpisodeDatasetError,
    canonical_sha256,
)


def _decimal_string(value: Decimal) -> str:
    rendered = format(value.normalize(), "f")
    return "0" if rendered in {"-0", ""} else rendered


def _median(values: list[Decimal]) -> Decimal:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / Decimal(2)


def _volatility(prices: list[Decimal]) -> Decimal:
    returns = [
        prices[index] / prices[index - 1] - Decimal(1)
        for index in range(1, len(prices))
    ]
    mean = sum(returns, Decimal(0)) / Decimal(len(returns))
    variance = sum((value - mean) ** 2 for value in returns) / Decimal(
        len(returns)
    )
    return variance.sqrt()


class CandidateEpisodeBuilder:
    def __init__(self, dataset: EpisodeDataset, policy: dict):
        self.dataset = dataset
        self.policy = policy
        candidate_policy = policy["candidatePolicy"]
        self.minimum_history = int(candidate_policy["minimumHistorySessions"])
        self.quota_per_board = int(candidate_policy["quotaPerBoard"])
        if self.minimum_history < 61 or self.quota_per_board <= 0:
            raise EpisodeDatasetError("CANDIDATE_POLICY_INVALID")
        uri = f"{dataset.market_database_path.resolve().as_uri()}?mode=ro&immutable=1"
        self.market = sqlite3.connect(uri, uri=True)
        self.market.row_factory = sqlite3.Row

    def close(self) -> None:
        self.market.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def build_range(self, start_date: str, end_date: str) -> list[dict]:
        dates = [
            row["cal_date"]
            for row in self.market.execute(
                "SELECT cal_date FROM trade_calendar "
                "WHERE exchange = 'SSE' AND is_open = 1 "
                "AND cal_date BETWEEN ? AND ? ORDER BY cal_date",
                (start_date, end_date),
            )
        ]
        results = []
        for decision_date in dates:
            if self.dataset.has_candidate_partition(decision_date):
                results.append(
                    {"decisionDate": decision_date, "status": "SKIPPED"}
                )
                continue
            execution = self.market.execute(
                "SELECT cal_date FROM trade_calendar "
                "WHERE exchange = 'SSE' AND is_open = 1 AND cal_date > ? "
                "ORDER BY cal_date LIMIT 1",
                (decision_date,),
            ).fetchone()
            if not execution:
                results.append(
                    {
                        "decisionDate": decision_date,
                        "status": "DEFERRED",
                        "reason": "NEXT_SESSION_UNAVAILABLE",
                    }
                )
                continue
            results.append(self.build_partition(decision_date, execution["cal_date"]))
        return results

    def build_partition(self, decision_date: str, execution_date: str) -> dict:
        history_dates = [
            row["cal_date"]
            for row in self.market.execute(
                "SELECT cal_date FROM trade_calendar "
                "WHERE exchange = 'SSE' AND is_open = 1 AND cal_date <= ? "
                "ORDER BY cal_date DESC LIMIT ?",
                (decision_date, self.minimum_history),
            )
        ]
        history_dates.reverse()
        universe = self.market.execute(
            "SELECT instrument_id, board FROM instruments "
            "WHERE list_date <= ? AND (delist_date IS NULL OR delist_date > ?) "
            "ORDER BY instrument_id",
            (decision_date, decision_date),
        ).fetchall()
        if any(row["board"] not in BOARDS for row in universe):
            raise EpisodeDatasetError("UNSUPPORTED_BOARD_IN_UNIVERSE")
        universe_rows = [
            {"instrumentId": row["instrument_id"], "board": row["board"]}
            for row in universe
        ]
        universe_hash = canonical_sha256(universe_rows)
        by_instrument: dict[str, list[sqlite3.Row]] = defaultdict(list)
        if history_dates:
            rows = self.market.execute(
                "SELECT d.instrument_id, d.trade_date, d.close, d.amount_cny, "
                "d.available_at AS daily_available_at, a.factor, "
                "a.available_at AS factor_available_at "
                "FROM daily_bars d "
                "LEFT JOIN adjustment_factors a "
                "ON a.instrument_id = d.instrument_id AND a.trade_date = d.trade_date "
                "WHERE d.trade_date BETWEEN ? AND ? "
                "ORDER BY d.instrument_id, d.trade_date",
                (history_dates[0], decision_date),
            )
            for row in rows:
                by_instrument[row["instrument_id"]].append(row)

        suspended = {
            row["instrument_id"]
            for row in self.market.execute(
                "SELECT DISTINCT instrument_id FROM suspensions WHERE trade_date = ?",
                (decision_date,),
            )
        }
        listing_suspended = {
            row["instrument_id"]
            for row in self.market.execute(
                "SELECT instrument_id FROM listing_status_periods "
                "WHERE effective_from <= ? AND effective_to > ?",
                (decision_date, decision_date),
            )
        }
        rejection_counts: Counter[tuple[str, str]] = Counter()
        eligible: dict[str, list[dict]] = defaultdict(list)

        with localcontext() as context:
            context.prec = 28
            for instrument in universe_rows:
                instrument_id = instrument["instrumentId"]
                board = instrument["board"]
                history = by_instrument.get(instrument_id, [])
                reason = None
                if instrument_id in listing_suspended:
                    reason = "LISTING_SUSPENDED"
                elif instrument_id in suspended:
                    reason = "SUSPENDED"
                elif not history or history[-1]["trade_date"] != decision_date:
                    reason = "NO_DECISION_DATE_BAR"
                elif any(row["factor"] is None for row in history):
                    reason = "MISSING_ADJUSTMENT_FACTOR"
                elif len(history) < self.minimum_history:
                    reason = "INSUFFICIENT_HISTORY"
                if reason:
                    rejection_counts[(board, reason)] += 1
                    continue

                prices = [
                    Decimal(row["close"]) * Decimal(row["factor"])
                    for row in history
                ]
                amounts = [Decimal(row["amount_cny"]) for row in history[-20:]]
                if any(value <= 0 for value in prices) or _median(amounts) <= 0:
                    rejection_counts[(board, "NON_POSITIVE_PRICE_OR_LIQUIDITY")] += 1
                    continue
                median_amount = _median(amounts)
                features = {
                    "adjustedReturn5": _decimal_string(prices[-1] / prices[-6] - 1),
                    "adjustedReturn20": _decimal_string(prices[-1] / prices[-21] - 1),
                    "adjustedReturn60": _decimal_string(prices[-1] / prices[-61] - 1),
                    "medianAmount20Cny": _decimal_string(median_amount),
                    "realizedVolatility20": _decimal_string(_volatility(prices[-21:])),
                }
                eligible[board].append(
                    {
                        "instrumentId": instrument_id,
                        "board": board,
                        "featureAvailableAt": max(
                            history[-1]["daily_available_at"],
                            history[-1]["factor_available_at"],
                        ),
                        "featureSchemaVersion": self.policy["featureSchemaVersion"],
                        "features": features,
                        "selectionScore": _decimal_string(median_amount),
                    }
                )

        candidates = []
        for board in sorted(BOARDS):
            ranked = sorted(
                eligible[board],
                key=lambda row: (
                    -Decimal(row["selectionScore"]),
                    row["instrumentId"],
                ),
            )
            selected = ranked[: self.quota_per_board]
            for rank, row in enumerate(selected, start=1):
                candidates.append(
                    {
                        **row,
                        "rankWithinBoard": rank,
                        "sampleBucket": "LIQUIDITY_TOP",
                    }
                )
            excluded = len(ranked) - len(selected)
            if excluded:
                rejection_counts[(board, "NOT_SELECTED_BY_BOARD_QUOTA")] += excluded

        rejections = [
            {"board": board, "reason": reason, "instrumentCount": count}
            for (board, reason), count in sorted(rejection_counts.items())
        ]
        if len(candidates) + sum(rejection_counts.values()) != len(universe_rows):
            raise EpisodeDatasetError("CANDIDATE_UNIVERSE_ACCOUNTING_MISMATCH")
        inserted = self.dataset.write_candidate_partition(
            decision_date=decision_date,
            execution_date=execution_date,
            universe_count=len(universe_rows),
            universe_sha256=universe_hash,
            candidates=candidates,
            rejections=rejections,
        )
        return {
            "decisionDate": decision_date,
            "executionDate": execution_date,
            "status": "COMPLETED" if inserted else "SKIPPED",
            "universeCount": len(universe_rows),
            "candidateCount": len(candidates),
            "rejectionCount": sum(rejection_counts.values()),
            "boards": {
                board: sum(row["board"] == board for row in candidates)
                for board in sorted(BOARDS)
            },
        }
