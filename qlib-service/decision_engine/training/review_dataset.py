"""Build trigger-review training rows without leaking them into entry scores."""

import numpy as np

from ..heads.review_contract import FEATURE_NAMES, feature_vector


DATASET_SCHEMA_VERSION = "opportunity-review-dataset.v2"


def _event_group_id(outcome):
    code = str(outcome.get("code") or "")
    event_id = str(
        outcome.get("parentDecisionId")
        or outcome.get("decisionId")
        or ""
    )
    return f"{code}:{event_id}" if code and event_id else ""


def build_opportunity_review_dataset(outcomes):
    source = outcomes if isinstance(outcomes, list) else []
    event_ledger = []
    for outcome in source:
        if not isinstance(outcome, dict):
            continue
        event_ledger.append({
            "decisionId": str(outcome.get("decisionId") or ""),
            "code": str(outcome.get("code") or ""),
            "tradeDate": str(outcome.get("tradeDate") or ""),
            "maturity": str(outcome.get("maturity") or "UNKNOWN"),
            "fillStatus": str(
                outcome.get("fillStatus") or "UNKNOWN"
            ),
            "outcome": str(outcome.get("outcome") or "UNKNOWN"),
            "hasReviewInput": isinstance(
                outcome.get("reviewScoreInput"),
                dict,
            ),
        })
    events = []
    conditional = []
    excluded = 0
    conditional_excluded = 0
    for outcome in source:
        if (
            not isinstance(outcome, dict)
            or outcome.get("maturity") != "MATURED"
            or outcome.get("fillStatus")
            not in {"FILLED", "TRIGGERED_UNFILLED"}
        ):
            excluded += 1
            continue
        try:
            vector = feature_vector(outcome.get("reviewScoreInput"))
            label_start = int(
                (outcome.get("reviewScoreInput") or {}).get("asOf")
                or 0
            )
            event_label_end = int(
                (outcome.get("entry") or {}).get("at")
                or outcome.get("evaluatedAt")
                or 0
            )
        except (TypeError, ValueError):
            excluded += 1
            continue
        if (
            label_start <= 0
            or event_label_end < label_start
        ):
            excluded += 1
            continue
        event_index = len(events)
        filled = outcome.get("fillStatus") == "FILLED"
        events.append((
            outcome,
            vector,
            1 if filled else 0,
            label_start,
            event_label_end,
        ))
        if not filled:
            continue
        try:
            net_r = float((outcome.get("metrics") or {}).get("netR"))
            label_end = int(
                (outcome.get("exit") or {}).get("at")
                or outcome.get("evaluatedAt")
                or 0
            )
        except (TypeError, ValueError):
            conditional_excluded += 1
            continue
        label_source = str(outcome.get("labelSource") or "")
        exit_contract = str(
            outcome.get("exitContractVersion") or ""
        )
        if (
            not np.isfinite(net_r)
            or label_end < label_start
            or not label_source
            or not exit_contract
        ):
            conditional_excluded += 1
            continue
        conditional.append((
            event_index,
            outcome,
            vector,
            net_r,
            label_start,
            label_end,
            label_source,
            exit_contract,
        ))
    return {
        "schema_version": DATASET_SCHEMA_VERSION,
        "event_ledger": event_ledger,
        "X_all": np.asarray(
            [item[1] for item in events],
            dtype=np.float32,
        ).reshape((-1, len(FEATURE_NAMES))),
        "dates_all": np.asarray(
            [str(item[0].get("tradeDate") or "") for item in events],
            dtype="<U10",
        ),
        "codes_all": np.asarray(
            [str(item[0].get("code") or "") for item in events],
            dtype="<U6",
        ),
        "event_group_ids_all": np.asarray(
            [_event_group_id(item[0]) for item in events],
            dtype="<U200",
        ),
        "label_start_ms_all": np.asarray(
            [item[3] for item in events],
            dtype=np.int64,
        ),
        "label_end_ms_all": np.asarray(
            [item[4] for item in events],
            dtype=np.int64,
        ),
        "y_fill": np.asarray(
            [item[2] for item in events],
            dtype=np.int8,
        ),
        "conditional_indices": np.asarray(
            [item[0] for item in conditional],
            dtype=np.int64,
        ),
        "X": np.asarray(
            [item[2] for item in conditional],
            dtype=np.float32,
        ).reshape((-1, len(FEATURE_NAMES))),
        "dates": np.asarray(
            [str(item[1].get("tradeDate") or "") for item in conditional],
            dtype="<U10",
        ),
        "codes": np.asarray(
            [str(item[1].get("code") or "") for item in conditional],
            dtype="<U6",
        ),
        "event_group_ids": np.asarray(
            [_event_group_id(item[1]) for item in conditional],
            dtype="<U200",
        ),
        "label_start_ms": np.asarray(
            [item[4] for item in conditional],
            dtype=np.int64,
        ),
        "label_end_ms": np.asarray(
            [item[5] for item in conditional],
            dtype=np.int64,
        ),
        "y_win": np.asarray(
            [1 if item[3] > 0 else 0 for item in conditional],
            dtype=np.int8,
        ),
        "y_net_r": np.asarray(
            [item[3] for item in conditional],
            dtype=np.float32,
        ),
        "label_sources": np.asarray(
            [item[6] for item in conditional],
            dtype="<U40",
        ),
        "exit_contract_versions": np.asarray(
            [item[7] for item in conditional],
            dtype="<U60",
        ),
        "feature_names": np.asarray(FEATURE_NAMES, dtype="<U80"),
        "summary": {
            "input_outcomes": len(event_ledger),
            "status_counts": {
                status: sum(
                    item["fillStatus"] == status
                    for item in event_ledger
                )
                for status in sorted({
                    item["fillStatus"] for item in event_ledger
                })
            },
            "events": len(events),
            "samples": len(conditional),
            "dates": len({
                str(item[1].get("tradeDate") or "")
                for item in conditional
            }),
            "excluded": excluded,
            "conditional_excluded": conditional_excluded,
            "filled": sum(item[2] for item in events),
            "unfilled": sum(1 - item[2] for item in events),
        },
    }
