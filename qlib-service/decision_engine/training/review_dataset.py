"""Build trigger-review training rows without leaking them into entry scores."""

from collections import Counter

import numpy as np

from ..heads.review_contract import FEATURE_NAMES, feature_vector
from .opportunity_reward import cost_aware_opportunity_reward


DATASET_SCHEMA_VERSION = "opportunity-review-dataset.v2"
MAIN_BOARD_CODE_PREFIXES = (
    "000",
    "001",
    "002",
    "003",
    "600",
    "601",
    "603",
    "605",
)


def is_main_board_code(value):
    code = str(value or "")
    return (
        len(code) == 6
        and code.isdigit()
        and code.startswith(MAIN_BOARD_CODE_PREFIXES)
    )


def _event_group_id(outcome):
    code = str(outcome.get("code") or "")
    event_id = str(
        outcome.get("parentDecisionId")
        or outcome.get("decisionId")
        or ""
    )
    return f"{code}:{event_id}" if code and event_id else ""


def _count_by(values, field):
    counts = Counter(
        str(value.get(field) or "UNKNOWN")
        for value in values
    )
    return dict(sorted(counts.items()))


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
            "source": str(
                outcome.get("labelSource")
                or (outcome.get("context") or {}).get("source")
                or "UNKNOWN"
            ),
            "strategy": (
                f"{str(outcome.get('playbookId') or 'UNKNOWN')}:"
                f"{str(outcome.get('route') or 'UNKNOWN')}"
            ),
            "eventGroupId": _event_group_id(outcome),
            "mainBoardEligible": is_main_board_code(
                outcome.get("code")
            ),
            "hasReviewInput": isinstance(
                outcome.get("reviewScoreInput"),
                dict,
            ),
        })
    events = []
    conditional = []
    excluded = 0
    non_main_board_excluded = 0
    conditional_excluded = 0
    for outcome in source:
        if (
            not isinstance(outcome, dict)
            or not is_main_board_code(outcome.get("code"))
        ):
            excluded += 1
            non_main_board_excluded += 1
            continue
        if (
            outcome.get("maturity") != "MATURED"
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
    conditional_by_event = {
        item[0]: item
        for item in conditional
    }
    opportunity = []
    for event_index, event in enumerate(events):
        filled = event[2] == 1
        conditional_row = conditional_by_event.get(event_index)
        if filled and conditional_row is None:
            continue
        opportunity.append((
            event[0],
            event[1],
            (
                cost_aware_opportunity_reward(
                    conditional_row[1].get("metrics"),
                    filled=True,
                    base_r=float(conditional_row[3]),
                )
                if filled
                else 0.0
            ),
            event[3],
            conditional_row[5] if filled else event[4],
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
        "X_opportunity": np.asarray(
            [item[1] for item in opportunity],
            dtype=np.float32,
        ).reshape((-1, len(FEATURE_NAMES))),
        "dates_opportunity": np.asarray(
            [str(item[0].get("tradeDate") or "") for item in opportunity],
            dtype="<U10",
        ),
        "codes_opportunity": np.asarray(
            [str(item[0].get("code") or "") for item in opportunity],
            dtype="<U6",
        ),
        "event_group_ids_opportunity": np.asarray(
            [_event_group_id(item[0]) for item in opportunity],
            dtype="<U200",
        ),
        "decision_ids_opportunity": np.asarray(
            [str(item[0].get("decisionId") or "") for item in opportunity],
            dtype="<U220",
        ),
        "label_start_ms_opportunity": np.asarray(
            [item[3] for item in opportunity],
            dtype=np.int64,
        ),
        "label_end_ms_opportunity": np.asarray(
            [item[4] for item in opportunity],
            dtype=np.int64,
        ),
        "y_opportunity_r": np.asarray(
            [item[2] for item in opportunity],
            dtype=np.float32,
        ),
        "sector_phases_opportunity": np.asarray(
            [
                str(
                    (item[0].get("context") or {}).get(
                        "sectorPhase"
                    )
                    or "UNKNOWN"
                ).upper()
                for item in opportunity
            ],
            dtype="<U20",
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
            "audit_counts": {
                "by_source": _count_by(event_ledger, "source"),
                "by_date": _count_by(event_ledger, "tradeDate"),
                "by_strategy": _count_by(event_ledger, "strategy"),
            },
            "events": len(events),
            "samples": len(conditional),
            "opportunity_samples": len(opportunity),
            "universe": {
                "schema_version": "cn-main-board.v1",
                "code_prefixes": list(MAIN_BOARD_CODE_PREFIXES),
            },
            "dates": len({
                str(item[1].get("tradeDate") or "")
                for item in conditional
            }),
            "excluded": excluded,
            "non_main_board_excluded": non_main_board_excluded,
            "conditional_excluded": conditional_excluded,
            "filled": sum(item[2] for item in events),
            "unfilled": sum(1 - item[2] for item in events),
        },
    }
