"""Build the leak-free dataset for the opportunity-ranking sidecar."""

import argparse
import json
import os

import numpy as np

from opportunity_contract import FEATURE_NAMES, feature_vector


DATASET_SCHEMA_VERSION = "opportunity-dataset.v1"
MINIMUM_SAMPLES = 1000
MINIMUM_FILLED_SAMPLES = 300
MINIMUM_DATES = 60


def _valid_date(value):
    text = str(value or "")
    if (
        len(text) == 10
        and text[4] == "-"
        and text[7] == "-"
        and text.replace("-", "").isdigit()
    ):
        return text
    return None


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def build_opportunity_dataset(outcomes):
    unique = {}
    duplicates = 0
    excluded = 0
    for outcome in outcomes if isinstance(outcomes, list) else []:
        if (
            not isinstance(outcome, dict)
            or outcome.get("maturity") != "MATURED"
        ):
            excluded += 1
            continue
        decision_id = str(outcome.get("decisionId") or "")
        trade_date = _valid_date(outcome.get("tradeDate"))
        if not decision_id or not trade_date:
            excluded += 1
            continue
        if decision_id in unique:
            duplicates += 1
            continue
        try:
            vector = feature_vector(outcome.get("scoreInput"))
        except ValueError:
            excluded += 1
            continue
        unique[decision_id] = (outcome, trade_date, vector)

    rows = list(unique.values())
    X = np.asarray(
        [row[2] for row in rows],
        dtype=np.float32,
    )
    if not len(rows):
        X = np.empty((0, len(FEATURE_NAMES)), dtype=np.float32)
    dates = np.asarray([row[1] for row in rows], dtype="<U10")
    codes = np.asarray([
        str(row[0]["scoreInput"]["code"])
        for row in rows
    ], dtype="<U6")
    formula_ids = np.asarray([
        str(row[0]["scoreInput"]["formulaId"])
        for row in rows
    ], dtype="<U60")
    y_fill = np.asarray([
        1 if row[0].get("fillStatus") == "FILLED" else 0
        for row in rows
    ], dtype=np.int8)
    y_win = np.full(len(rows), np.nan, dtype=np.float32)
    y_net_r = np.full(len(rows), np.nan, dtype=np.float32)
    for index, (outcome, _, _) in enumerate(rows):
        if outcome.get("fillStatus") != "FILLED":
            continue
        net_r = _finite((outcome.get("metrics") or {}).get("netR"))
        net_pnl = _finite((outcome.get("metrics") or {}).get("netPnl"))
        if net_r is None or net_pnl is None:
            continue
        y_win[index] = 1.0 if net_pnl > 0 else 0.0
        y_net_r[index] = net_r

    labeled_trades = int(np.isfinite(y_net_r).sum())
    return {
        "schema_version": DATASET_SCHEMA_VERSION,
        "X": X,
        "dates": dates,
        "codes": codes,
        "formula_ids": formula_ids,
        "y_fill": y_fill,
        "y_win": y_win,
        "y_net_r": y_net_r,
        "feature_names": np.asarray(FEATURE_NAMES, dtype="<U80"),
        "summary": {
          "samples": int(len(rows)),
          "filled": int(y_fill.sum()),
          "labeled_trades": labeled_trades,
          "excluded": int(excluded),
          "duplicates": int(duplicates),
          "dates": int(len(set(dates.tolist()))),
        },
    }


def opportunity_dataset_readiness(
    dataset,
    *,
    minimum_samples=MINIMUM_SAMPLES,
    minimum_filled_samples=MINIMUM_FILLED_SAMPLES,
    minimum_dates=MINIMUM_DATES,
):
    dates = np.asarray(dataset.get("dates", [])).astype(str)
    y_fill = np.asarray(dataset.get("y_fill", []))
    y_win = np.asarray(dataset.get("y_win", []), dtype=float)
    y_net_r = np.asarray(dataset.get("y_net_r", []), dtype=float)
    filled_mask = np.isfinite(y_win) & np.isfinite(y_net_r)
    blockers = []
    if len(y_fill) < int(minimum_samples):
        blockers.append(f"成熟候选少于{int(minimum_samples)}")
    if len(set(dates.tolist())) < int(minimum_dates):
        blockers.append(f"独立交易日少于{int(minimum_dates)}")
    if int(filled_mask.sum()) < int(minimum_filled_samples):
        blockers.append(
            f"完成成交样本少于{int(minimum_filled_samples)}"
        )
    if len(set(y_fill.astype(int).tolist())) < 2:
        blockers.append("pFill标签缺少正负两类")
    conditional_win = y_win[filled_mask].astype(int)
    if len(set(conditional_win.tolist())) < 2:
        blockers.append("pWinGivenFill标签缺少正负两类")
    if filled_mask.any() and float(np.std(y_net_r[filled_mask])) == 0:
        blockers.append("expectedNetR标签没有变化")
    return {
        "ready": not blockers,
        "samples": int(len(y_fill)),
        "filled_samples": int(filled_mask.sum()),
        "dates": int(len(set(dates.tolist()))),
        "blockers": blockers,
    }


def build_opportunity_dataset_file(source_path, output_path):
    with open(source_path, encoding="utf-8") as handle:
        payload = json.load(handle)
    outcomes = (
        payload.get("outcomes")
        if isinstance(payload, dict)
        else payload
    )
    dataset = build_opportunity_dataset(outcomes)
    output = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temporary = output + ".part"
    with open(temporary, "wb") as handle:
        np.savez_compressed(
            handle,
            X=dataset["X"],
            dates=dataset["dates"],
            codes=dataset["codes"],
            formula_ids=dataset["formula_ids"],
            y_fill=dataset["y_fill"],
            y_win=dataset["y_win"],
            y_net_r=dataset["y_net_r"],
            feature_names=dataset["feature_names"],
        )
    os.replace(temporary, output)
    return dataset["summary"]


def main():
    parser = argparse.ArgumentParser(
        description="构建机会雷达旁路训练数据集",
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = build_opportunity_dataset_file(args.input, args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
