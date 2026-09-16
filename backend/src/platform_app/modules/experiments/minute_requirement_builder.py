"""Expand candidate episodes into resumable five-session minute requirements."""

import sqlite3

from platform_app.modules.experiments.episode_dataset import EpisodeDataset


class MinuteRequirementBuilder:
    def __init__(self, dataset: EpisodeDataset):
        self.dataset = dataset
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
            row["decision_date"]
            for row in self.dataset.db.execute(
                "SELECT decision_date FROM candidate_partitions "
                "WHERE decision_date BETWEEN ? AND ? ORDER BY decision_date",
                (start_date, end_date),
            )
        ]
        return [self.build_partition(decision_date) for decision_date in dates]

    def build_partition(self, decision_date: str) -> dict:
        if self.dataset.has_minute_requirement_partition(decision_date):
            return {"decisionDate": decision_date, "status": "SKIPPED"}

        episodes = self.dataset.db.execute(
            "SELECT episode_id, instrument_id, board, execution_date "
            "FROM candidate_episodes WHERE decision_date = ? ORDER BY episode_id",
            (decision_date,),
        ).fetchall()
        if not episodes:
            self.dataset.write_minute_requirement_partition(
                decision_date=decision_date,
                episode_schedules=[],
                deferred_episode_ids=[],
            )
            return {
                "decisionDate": decision_date,
                "status": "COMPLETED",
                "episodeCount": 0,
                "requirementLinks": 0,
                "deferredEpisodes": 0,
            }

        execution_date = episodes[0]["execution_date"]
        trade_dates = [
            row["cal_date"]
            for row in self.market.execute(
                "SELECT cal_date FROM trade_calendar "
                "WHERE exchange = 'SSE' AND is_open = 1 AND cal_date >= ? "
                "ORDER BY cal_date LIMIT 5",
                (execution_date,),
            )
        ]
        if len(trade_dates) < 5:
            deferred = [row["episode_id"] for row in episodes]
            schedules = []
        else:
            instrument_ids = [row["instrument_id"] for row in episodes]
            instrument_placeholders = ",".join("?" for _ in instrument_ids)
            date_placeholders = ",".join("?" for _ in trade_dates)
            available = {
                (row["instrument_id"], row["trade_date"])
                for row in self.market.execute(
                    "SELECT instrument_id, trade_date FROM daily_bars "
                    f"WHERE instrument_id IN ({instrument_placeholders}) "
                    f"AND trade_date IN ({date_placeholders})",
                    (*instrument_ids, *trade_dates),
                )
            }
            schedules = [
                {
                    "episodeId": row["episode_id"],
                    "instrumentId": row["instrument_id"],
                    "board": row["board"],
                    "tradeDates": trade_dates,
                    "dailyAvailability": [
                        (row["instrument_id"], trade_date) in available
                        for trade_date in trade_dates
                    ],
                }
                for row in episodes
            ]
            deferred = []

        self.dataset.write_minute_requirement_partition(
            decision_date=decision_date,
            episode_schedules=schedules,
            deferred_episode_ids=deferred,
        )
        return {
            "decisionDate": decision_date,
            "status": "DEFERRED" if deferred else "COMPLETED",
            "episodeCount": len(episodes),
            "requirementLinks": len(schedules) * 5,
            "deferredEpisodes": len(deferred),
        }


__all__ = ["MinuteRequirementBuilder"]
