"""Evaluate daily V2 holdout predictions with conservative A-share fills."""

import argparse
import json
import os

import numpy as np


def select_top_k_profit(
    *,
    dates,
    profit_prob,
    predicted_class,
    top_k=3,
    minimum_probability=0.5,
):
    dates = np.asarray(dates).astype(str)
    probabilities = np.asarray(profit_prob, dtype=float)
    predictions = np.asarray(predicted_class, dtype=int)
    if not (len(dates) == len(probabilities) == len(predictions)):
        raise ValueError("prediction arrays must have equal length")
    if not isinstance(top_k, int) or top_k <= 0:
        raise ValueError("top_k must be a positive integer")
    if not 0 <= minimum_probability <= 1:
        raise ValueError("minimum_probability must be between zero and one")

    selected = []
    for date in np.unique(dates):
        candidates = np.flatnonzero(
            (dates == date)
            & (predictions == 2)
            & (probabilities >= minimum_probability)
        )
        ranking = np.argsort(-probabilities[candidates], kind="stable")
        selected.extend(candidates[ranking[:top_k]])
    return np.asarray(selected, dtype=int)


def maximum_drawdown(trade_returns):
    returns = np.asarray(trade_returns, dtype=float)
    if not len(returns):
        return 0.0
    equity = np.concatenate(([1.0], np.cumprod(1.0 + returns)))
    peaks = np.maximum.accumulate(equity)
    return float(np.min(equity / peaks - 1.0))


def non_overlapping_cohort_returns(
    *,
    signal_dates,
    trade_returns,
    calendar_dates,
    holding_period,
):
    signal_dates = np.asarray(signal_dates).astype(str)
    returns = np.asarray(trade_returns, dtype=float)
    calendar = np.unique(np.asarray(calendar_dates).astype(str))
    if len(signal_dates) != len(returns):
        raise ValueError("signal_dates and trade_returns must have equal length")
    if not isinstance(holding_period, int) or holding_period <= 0:
        raise ValueError("holding_period must be a positive integer")

    date_positions = {date: index for index, date in enumerate(calendar)}
    if any(date not in date_positions for date in signal_dates):
        raise ValueError("every signal date must exist in calendar_dates")

    cohorts = []
    next_allowed_position = 0
    for date in np.unique(signal_dates):
        position = date_positions[date]
        if position < next_allowed_position:
            continue
        cohorts.append(float(np.mean(returns[signal_dates == date])))
        next_allowed_position = position + holding_period
    return np.asarray(cohorts, dtype=float)


def _load_panel(panel_dir, code):
    path = os.path.join(panel_dir, code.replace(".", "_") + ".npz")
    with np.load(path, allow_pickle=True) as data:
        return {
            "dates": data["dates"].astype(str),
            "opens": data["o"].astype(float),
            "closes": data["c"].astype(float),
            "volumes": data["v"].astype(float),
        }


def evaluate_holdout(
    predictions_path,
    panel_dir,
    *,
    top_k=3,
    minimum_probability=0.5,
    capital_per_trade=100_000.0,
    exit_horizon=5,
    slippage_bps=5,
):
    from ashare_execution import execution_price, simulate_long_trade

    with np.load(predictions_path, allow_pickle=True) as predictions:
        dates = predictions["dates"].astype(str)
        codes = predictions["codes"].astype(str)
        actual_barrier = predictions["actual_barrier"].astype(int)
        predicted_barrier = predictions["predicted_barrier"].astype(int)
        barrier_prob = predictions["barrier_prob"].astype(float)

    selected = select_top_k_profit(
        dates=dates,
        profit_prob=barrier_prob[:, 2],
        predicted_class=predicted_barrier,
        top_k=top_k,
        minimum_probability=minimum_probability,
    )
    returns = []
    closed_signal_dates = []
    closed = entry_unfilled = exit_unfilled = skipped = 0
    panels = {}
    for prediction_index in selected:
        code = codes[prediction_index]
        if code not in panels:
            panels[code] = _load_panel(panel_dir, code)
        panel = panels[code]
        positions = np.flatnonzero(panel["dates"] == dates[prediction_index])
        if not len(positions):
            skipped += 1
            continue
        signal_index = int(positions[-1])
        requested_exit_index = signal_index + exit_horizon
        if requested_exit_index >= len(panel["dates"]):
            skipped += 1
            continue

        expected_entry = execution_price(
            panel["opens"][signal_index + 1],
            "buy",
            slippage_bps,
        )
        quantity = int(capital_per_trade // (expected_entry * 100)) * 100
        if quantity < 100:
            skipped += 1
            continue
        result = simulate_long_trade(
            code=code,
            dates=panel["dates"],
            opens=panel["opens"],
            closes=panel["closes"],
            volumes=panel["volumes"],
            signal_index=signal_index,
            requested_exit_index=requested_exit_index,
            quantity=quantity,
            slippage_bps=slippage_bps,
        )
        if result["status"] == "closed":
            closed += 1
            returns.append(result["net_return"])
            closed_signal_dates.append(dates[prediction_index])
        elif result["status"] == "entry_unfilled":
            entry_unfilled += 1
        else:
            exit_unfilled += 1

    net_returns = np.asarray(returns, dtype=float)
    cohort_returns = non_overlapping_cohort_returns(
        signal_dates=np.asarray(closed_signal_dates),
        trade_returns=net_returns,
        calendar_dates=np.unique(dates),
        holding_period=exit_horizon,
    )
    actual_profit_precision = (
        float(np.mean(actual_barrier[selected] == 2)) if len(selected) else 0.0
    )
    return {
        "top_k": top_k,
        "minimum_probability": minimum_probability,
        "selected_signals": int(len(selected)),
        "actual_profit_precision": actual_profit_precision,
        "closed_trades": closed,
        "entry_unfilled": entry_unfilled,
        "exit_unfilled": exit_unfilled,
        "skipped": skipped,
        "win_rate": (
            float(np.mean(net_returns > 0)) if len(net_returns) else 0.0
        ),
        "mean_trade_net_return": (
            float(np.mean(net_returns)) if len(net_returns) else 0.0
        ),
        "median_trade_net_return": (
            float(np.median(net_returns)) if len(net_returns) else 0.0
        ),
        "non_overlapping_cohorts": int(len(cohort_returns)),
        "mean_cohort_net_return": (
            float(np.mean(cohort_returns)) if len(cohort_returns) else 0.0
        ),
        "compounded_net_return": (
            float(np.prod(1.0 + cohort_returns) - 1.0)
            if len(cohort_returns)
            else 0.0
        ),
        "maximum_drawdown": maximum_drawdown(cohort_returns),
        "slippage_bps": slippage_bps,
        "capital_per_trade": capital_per_trade,
        "exit_horizon": exit_horizon,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--predictions",
        default="full477/daily_v2/holdout_predictions.npz",
    )
    parser.add_argument("--panel", default="panel_full477")
    parser.add_argument(
        "--out",
        default="full477/daily_v2/daily_v2_backtest.json",
    )
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--minimum-probability", type=float, default=0.5)
    args = parser.parse_args()

    metrics = evaluate_holdout(
        args.predictions,
        args.panel,
        top_k=args.top_k,
        minimum_probability=args.minimum_probability,
    )
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(metrics, handle, ensure_ascii=False, indent=2)
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print("DAILY_V2_BACKTEST_OK")


if __name__ == "__main__":
    main()
