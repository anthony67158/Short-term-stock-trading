"""Point-in-time cross-sectional factor research with sealed split reporting."""

import argparse
import json
import math
import os
from collections import defaultdict

import numpy as np


SPLIT_ORDER = ("TRAIN", "CALIBRATION", "SEALED_TEST")


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _rounded(value):
    if value is None or not math.isfinite(float(value)):
        return None
    return round(float(value), 6)


def _pearson(left, right):
    x = np.asarray(left, dtype=float)
    y = np.asarray(right, dtype=float)
    if len(x) < 2 or len(x) != len(y):
        return None
    if float(np.std(x)) == 0 or float(np.std(y)) == 0:
        return None
    value = float(np.corrcoef(x, y)[0, 1])
    return value if math.isfinite(value) else None


def _ranks(values):
    values = np.asarray(values, dtype=float)
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(len(values), dtype=float)
    ranks[order] = np.arange(len(values), dtype=float)
    unique, inverse, counts = np.unique(
        values,
        return_inverse=True,
        return_counts=True,
    )
    del unique
    for group, count in enumerate(counts):
        if count <= 1:
            continue
        indexes = np.where(inverse == group)[0]
        ranks[indexes] = float(np.mean(ranks[indexes]))
    return ranks


def _correlation(left, right, *, rank=False):
    if rank:
        return _pearson(_ranks(left), _ranks(right))
    return _pearson(left, right)


def _summary(values):
    clean = [float(value) for value in values if value is not None]
    if not clean:
        return {
            "observations": 0,
            "mean": None,
            "std": None,
            "icir": None,
            "positiveRate": None,
        }
    mean = float(np.mean(clean))
    deviation = float(np.std(clean))
    return {
        "observations": len(clean),
        "mean": _rounded(mean),
        "std": _rounded(deviation),
        "icir": _rounded(
            mean / deviation * math.sqrt(len(clean))
            if deviation > 0
            else None
        ),
        "positiveRate": _rounded(
            sum(value > 0 for value in clean) / len(clean)
        ),
    }


def _validate_records(records, factor_names):
    if not isinstance(records, list) or not records:
        raise ValueError("factor records must be a non-empty list")
    if not factor_names or len(set(factor_names)) != len(factor_names):
        raise ValueError("factor_names must be unique and non-empty")
    dates_by_split = {name: set() for name in SPLIT_ORDER}
    normalized = []
    seen = set()
    for item in records:
        split = str(item.get("split", ""))
        date = str(item.get("date", "")).replace("-", "")
        code = str(item.get("code", "")).upper()
        if split not in dates_by_split:
            raise ValueError("unknown research split")
        if not date or not code:
            raise ValueError("factor record requires date and code")
        key = (split, date, code)
        if key in seen:
            raise ValueError("duplicate factor record")
        seen.add(key)
        dates_by_split[split].add(date)
        factors = item.get("factors") or {}
        if any(_finite(factors.get(name)) is None for name in factor_names):
            raise ValueError("factor record contains missing values")
        forwards = item.get("forwardReturns") or {}
        if _finite(forwards.get("1")) is None:
            raise ValueError("factor record requires one-period forward return")
        if (
            not str(item.get("industry", "")).strip()
            or _finite(item.get("marketCap")) is None
            or _finite(item.get("adv20")) is None
        ):
            raise ValueError("neutralization fields are incomplete")
        normalized.append(dict(item))

    if any(not dates_by_split[name] for name in SPLIT_ORDER):
        raise ValueError("every research split must contain observations")
    if any(
        dates_by_split[left] & dates_by_split[right]
        for index, left in enumerate(SPLIT_ORDER)
        for right in SPLIT_ORDER[index + 1:]
    ):
        raise ValueError("research split dates must not overlap")
    if not (
        max(dates_by_split["TRAIN"]) < min(dates_by_split["CALIBRATION"])
        < min(dates_by_split["SEALED_TEST"])
    ):
        raise ValueError("research split order must be TRAIN then CALIBRATION then SEALED_TEST")
    return normalized, dates_by_split


def _group_by_date(records):
    grouped = defaultdict(list)
    for item in records:
        grouped[str(item["date"]).replace("-", "")].append(item)
    return dict(sorted(grouped.items()))


def _daily_correlations(grouped, factor_name, horizon, *, rank=False):
    values = []
    for rows in grouped.values():
        pairs = [
            (
                _finite(item["factors"].get(factor_name)),
                _finite((item.get("forwardReturns") or {}).get(str(horizon))),
            )
            for item in rows
        ]
        pairs = [
            (factor, future)
            for factor, future in pairs
            if factor is not None and future is not None
        ]
        if len(pairs) < 2:
            continue
        factor_values, future_values = zip(*pairs)
        value = _correlation(
            factor_values,
            future_values,
            rank=rank,
        )
        if value is not None:
            values.append(value)
    return values


def _neutralized_factor_rows(grouped, factor_name):
    output = {}
    for date, rows in grouped.items():
        industries = sorted({str(item["industry"]) for item in rows})
        baseline = industries[0]
        design = []
        values = []
        valid_rows = []
        for item in rows:
            market_cap = _finite(item.get("marketCap"))
            adv20 = _finite(item.get("adv20"))
            factor = _finite(item["factors"].get(factor_name))
            if (
                market_cap is None
                or market_cap <= 0
                or adv20 is None
                or adv20 <= 0
                or factor is None
            ):
                continue
            row = [
                1.0,
                math.log(market_cap),
                math.log(adv20),
            ]
            row.extend(
                1.0 if item["industry"] == industry else 0.0
                for industry in industries
                if industry != baseline
            )
            design.append(row)
            values.append(factor)
            valid_rows.append(item)
        if len(values) < 3:
            continue
        matrix = np.asarray(design, dtype=float)
        target = np.asarray(values, dtype=float)
        beta = np.linalg.lstsq(matrix, target, rcond=None)[0]
        residuals = target - matrix @ beta
        output[date] = [
            {
                **item,
                "factors": {
                    **item["factors"],
                    factor_name: float(residual),
                },
            }
            for item, residual in zip(valid_rows, residuals)
        ]
    return output


def _quantile_analysis(grouped, factor_name, quantiles, cost_bps):
    returns = [[] for _ in range(quantiles)]
    previous_top = None
    turnovers = []
    for rows in grouped.values():
        ordered = sorted(
            rows,
            key=lambda item: (
                float(item["factors"][factor_name]),
                str(item["code"]),
            ),
        )
        buckets = [[] for _ in range(quantiles)]
        for index, item in enumerate(ordered):
            bucket = min(quantiles - 1, index * quantiles // len(ordered))
            future = _finite(item["forwardReturns"].get("1"))
            if future is not None:
                buckets[bucket].append(future)
        for index, values in enumerate(buckets):
            if values:
                returns[index].append(float(np.mean(values)))
        current_top = {
            item["code"]
            for item in ordered[
                max(0, len(ordered) - math.ceil(len(ordered) / quantiles)):
            ]
        }
        if previous_top is not None:
            overlap = len(current_top & previous_top)
            denominator = max(1, len(current_top | previous_top))
            turnovers.append(1.0 - overlap / denominator)
        previous_top = current_top
    means = [
        _rounded(float(np.mean(values)) if values else None)
        for values in returns
    ]
    long_short = (
        means[-1] - means[0]
        if means and means[-1] is not None and means[0] is not None
        else None
    )
    turnover = float(np.mean(turnovers)) if turnovers else 0.0
    cost_drag = turnover * float(cost_bps) / 10_000.0
    return {
        "quantiles": [
            {"quantile": index + 1, "meanReturn": value}
            for index, value in enumerate(means)
        ],
        "longShortReturn": _rounded(long_short),
        "costDrag": _rounded(cost_drag),
        "netLongShortReturn": _rounded(
            long_short - cost_drag if long_short is not None else None
        ),
        "turnoverRate": _rounded(turnover),
    }


def _factor_report(grouped, factor_name, quantiles, cost_bps):
    ic_values = _daily_correlations(grouped, factor_name, "1")
    rank_values = _daily_correlations(
        grouped,
        factor_name,
        "1",
        rank=True,
    )
    neutralized = _neutralized_factor_rows(grouped, factor_name)
    horizons = sorted({
        str(horizon)
        for rows in grouped.values()
        for item in rows
        for horizon in (item.get("forwardReturns") or {})
    }, key=lambda value: int(value))
    quantile = _quantile_analysis(
        grouped,
        factor_name,
        quantiles,
        cost_bps,
    )
    return {
        "ic": _summary(ic_values),
        "rankIc": _summary(rank_values),
        "neutralized": {
            "controls": ["industry", "logMarketCap", "logAdv20"],
            "ic": _summary(
                _daily_correlations(
                    neutralized,
                    factor_name,
                    "1",
                )
            ),
            "rankIc": _summary(
                _daily_correlations(
                    neutralized,
                    factor_name,
                    "1",
                    rank=True,
                )
            ),
        },
        "quantile": quantile,
        "turnoverRate": quantile["turnoverRate"],
        "decay": {
            horizon: _summary(
                _daily_correlations(
                    grouped,
                    factor_name,
                    horizon,
                    rank=True,
                )
            )["mean"]
            for horizon in horizons
        },
    }


def _factor_correlations(records, factor_names):
    matrix = {}
    redundant = []
    for left in factor_names:
        matrix[left] = {}
        for right in factor_names:
            pairs = [
                (
                    _finite(item["factors"].get(left)),
                    _finite(item["factors"].get(right)),
                )
                for item in records
            ]
            pairs = [
                pair for pair in pairs
                if pair[0] is not None and pair[1] is not None
            ]
            correlation = _correlation(
                [pair[0] for pair in pairs],
                [pair[1] for pair in pairs],
            )
            matrix[left][right] = _rounded(correlation)
    for left_index, left in enumerate(factor_names):
        for right in factor_names[left_index + 1:]:
            correlation = matrix[left][right]
            if correlation is not None and abs(correlation) >= 0.8:
                redundant.append({
                    "left": left,
                    "right": right,
                    "correlation": correlation,
                })
    return matrix, redundant


def analyze_factors(
    records,
    *,
    factor_names,
    quantiles=5,
    cost_bps=10,
):
    if not isinstance(quantiles, int) or quantiles < 2:
        raise ValueError("quantiles must be an integer of at least two")
    if _finite(cost_bps) is None or float(cost_bps) < 0:
        raise ValueError("cost_bps must be non-negative")
    normalized, dates_by_split = _validate_records(records, factor_names)
    split_reports = {}
    for split in SPLIT_ORDER:
        rows = [item for item in normalized if item["split"] == split]
        grouped = _group_by_date(rows)
        split_reports[split] = {
            "dateRange": {
                "start": min(dates_by_split[split]),
                "end": max(dates_by_split[split]),
            },
            "observations": len(rows),
            "factors": {
                name: _factor_report(
                    grouped,
                    name,
                    quantiles,
                    cost_bps,
                )
                for name in factor_names
            },
        }
    matrix, redundant = _factor_correlations(normalized, factor_names)
    return {
        "schemaVersion": "factor-research.v2",
        "splitPolicy": {
            "order": list(SPLIT_ORDER),
            "overlapAllowed": False,
            "sealedTestUsedForSelection": False,
        },
        "factorNames": list(factor_names),
        "costBps": float(cost_bps),
        "quantiles": quantiles,
        "splits": split_reports,
        "correlationMatrix": matrix,
        "redundantPairs": redundant,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", required=True)
    parser.add_argument("--factors", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--quantiles", type=int, default=5)
    parser.add_argument("--cost-bps", type=float, default=10)
    args = parser.parse_args(argv)
    with open(args.records, encoding="utf-8") as handle:
        payload = json.load(handle)
    records = payload.get("records") if isinstance(payload, dict) else payload
    report = analyze_factors(
        records,
        factor_names=[
            item.strip()
            for item in args.factors.split(",")
            if item.strip()
        ],
        quantiles=args.quantiles,
        cost_bps=args.cost_bps,
    )
    output = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps({
        "out": output,
        "factors": report["factorNames"],
        "sealedObservations": report["splits"]["SEALED_TEST"]["observations"],
    }, ensure_ascii=False, indent=2))
    print("FACTOR_RESEARCH_V2_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
