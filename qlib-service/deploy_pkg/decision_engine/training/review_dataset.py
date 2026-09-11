"""Build trigger-review training rows without leaking them into entry scores."""

import numpy as np

from ..heads.review_contract import FEATURE_NAMES, feature_vector


DATASET_SCHEMA_VERSION = "opportunity-review-dataset.v1"


def build_opportunity_review_dataset(outcomes):
    rows = []
    excluded = 0
    for outcome in outcomes if isinstance(outcomes, list) else []:
        if (
            not isinstance(outcome, dict)
            or outcome.get("maturity") != "MATURED"
            or outcome.get("fillStatus") != "FILLED"
        ):
            excluded += 1
            continue
        net_r = (outcome.get("metrics") or {}).get("netR")
        try:
            net_r = float(net_r)
            vector = feature_vector(outcome.get("reviewScoreInput"))
            label_start = int(
                (outcome.get("reviewScoreInput") or {}).get("asOf")
                or 0
            )
            label_end = int(
                (outcome.get("exit") or {}).get("at")
                or outcome.get("evaluatedAt")
                or 0
            )
        except (TypeError, ValueError):
            excluded += 1
            continue
        if (
            not np.isfinite(net_r)
            or label_start <= 0
            or label_end < label_start
        ):
            excluded += 1
            continue
        rows.append((outcome, vector, net_r, label_start, label_end))
    return {
        "schema_version": DATASET_SCHEMA_VERSION,
        "X": np.asarray(
            [item[1] for item in rows],
            dtype=np.float32,
        ).reshape((-1, len(FEATURE_NAMES))),
        "dates": np.asarray(
            [str(item[0].get("tradeDate") or "") for item in rows],
            dtype="<U10",
        ),
        "codes": np.asarray(
            [str(item[0].get("code") or "") for item in rows],
            dtype="<U6",
        ),
        "label_start_ms": np.asarray(
            [item[3] for item in rows],
            dtype=np.int64,
        ),
        "label_end_ms": np.asarray(
            [item[4] for item in rows],
            dtype=np.int64,
        ),
        "y_win": np.asarray(
            [1 if item[2] > 0 else 0 for item in rows],
            dtype=np.int8,
        ),
        "y_net_r": np.asarray(
            [item[2] for item in rows],
            dtype=np.float32,
        ),
        "feature_names": np.asarray(FEATURE_NAMES, dtype="<U80"),
        "summary": {
            "samples": len(rows),
            "dates": len({
                str(item[0].get("tradeDate") or "")
                for item in rows
            }),
            "excluded": excluded,
        },
    }
