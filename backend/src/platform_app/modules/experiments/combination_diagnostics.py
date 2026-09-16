"""Model contribution, strata and minute-coverage diagnostics; no release decision."""

import argparse
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

import numpy as np

from platform_app.modules.experiments.ranking_walk_forward import block_bootstrap_interval


def run(experiment: Path, episode_root: Path, output: Path):
    records, candidates, returns = [], [], {}
    for folder in sorted(experiment.glob("fold-*")):
        records.extend(json.loads((folder / "evaluation.json").read_text())["records"])
        local = json.loads((folder / "candidate-union.json").read_text())["candidates"]
        candidates.extend(local)
        wanted = {(int(r["decisionDate"]), r["instrumentId"].encode()) for r in local}
        with np.load(folder / "oof.npz") as data:
            returns.update({
                (int(d), instrument.decode()): float(value)
                for d, instrument, value in zip(
                    data["dates"], data["instruments"], data["targetReturn"], strict=True,
                ) if (int(d), instrument) in wanted
            })
    by_model = defaultdict(dict)
    for row in records:
        by_model[row["model"]][row["date"]] = row
    ablation = {}
    for name in ("rank5", "rank20", "rank100", "return"):
        left, right = by_model["equal"], by_model[f"equal_without_{name}"]
        ablation[name] = block_bootstrap_interval(np.array([
            left[d]["top10GrossReturn"] - right[d]["top10GrossReturn"] for d in sorted(left)
        ]))
    strata = {}
    for name, daily in by_model.items():
        strata[name] = {
            "years": {
                year: {"meanRankIc": float(np.mean([r["rankIc"] for r in daily.values()
                                                   if str(r["date"])[:4] == year])),
                       "meanTop10GrossReturn": float(np.mean([
                           r["top10GrossReturn"] for r in daily.values()
                           if str(r["date"])[:4] == year]))}
                for year in sorted({str(d)[:4] for d in daily})
            },
            "folds": {
                str(fold): float(np.mean([r["top10GrossReturn"] for r in daily.values()
                                         if r["fold"] == fold]))
                for fold in range(1, 6)
            },
            "boards": {},
        }
        for board in range(4):
            selected = [r for r in candidates if r["boardCode"] == board and name in r["selectedBy"]]
            strata[name]["boards"][str(board)] = {
                "selections": len(selected),
                "meanSelectedGrossReturn": float(np.mean([
                    returns[(int(r["decisionDate"]), r["instrumentId"])] for r in selected
                ])) if selected else None,
            }
    coverage = {}
    path = episode_root / "episodes.sqlite3"
    with sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True) as db:
        complete = {
            (str(date), instrument)
            for date, instrument in db.execute(
                "SELECT e.decision_date,e.instrument_id FROM candidate_episodes e "
                "JOIN episode_minute_requirements l ON l.episode_id=e.episode_id "
                "JOIN minute_requirements r ON r.instrument_id=l.instrument_id "
                "AND r.trade_date=l.trade_date GROUP BY e.episode_id "
                "HAVING count(*)=5 AND sum(r.status='COMPLETED')=5"
            )
        }
        for name in by_model:
            selected = [r for r in candidates if name in r["selectedBy"]]
            covered = [r for r in selected if (r["decisionDate"], r["instrumentId"]) in complete]
            coverage[name] = {
                "selected": len(selected), "completePaths": len(covered),
                "coverage": len(covered) / len(selected),
            }
    report = {
        "usage": "DEVELOPMENT_ONLY", "metric": "FIVE_SESSION_GROSS_RETURN_NOT_ACCOUNT_RETURN",
        "marginalEqualWeightContribution": ablation, "strata": strata,
        "minuteCoverageAtReportTime": coverage,
        "releaseStatus": "UNAVAILABLE",
    }
    output.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("experiment", "episode-root", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    run(args.experiment, args.episode_root, args.output)
