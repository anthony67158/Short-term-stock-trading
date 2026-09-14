"""Build trigger-review training rows without leaking them into entry scores."""

from collections import Counter
import copy

import numpy as np

from ..heads.review_contract import FEATURE_NAMES, feature_vector
from ..heads.review_contract_v4 import (
    FEATURE_NAMES_V4,
    feature_vector_v4,
)
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


def _outcomes(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("outcomes"), list):
        return payload["outcomes"]
    raise ValueError("复核历史样本结构无效")


def _review_risk_outcome(value):
    repaired = copy.deepcopy(value)
    if repaired.get("fillStatus") != "FILLED":
        return repaired
    metrics = repaired.get("metrics")
    contract = (repaired.get("reviewScoreInput") or {}).get("priceContract")
    entry = repaired.get("entry") or {}
    try:
        net_pnl = float((metrics or {}).get("netPnl"))
        quantity = float(entry.get("quantity"))
        risk_per_share = float(
            (contract or {}).get("priceRiskMilliCny")
        ) / 1000
    except (TypeError, ValueError):
        return repaired
    risk_cash = quantity * risk_per_share
    if (
        not all(np.isfinite(item) for item in (
            net_pnl,
            quantity,
            risk_per_share,
            risk_cash,
        ))
        or quantity <= 0
        or risk_per_share <= 0
        or risk_cash <= 0
    ):
        return repaired
    repaired["metrics"] = {
        **metrics,
        "netR": round(net_pnl / risk_cash, 6),
        "initialRiskCash": round(risk_cash, 2),
        "riskBasis": "REVIEW_PRICE_CONTRACT_V2",
    }
    return repaired


def normalize_review_history_outcomes(payload):
    unique = {}
    for value in _outcomes(payload):
        if (
            not isinstance(value, dict)
            or value.get("maturity") != "MATURED"
        ):
            continue
        decision_id = str(value.get("decisionId") or "")
        if not decision_id.startswith("formula:"):
            continue
        unique[decision_id] = _review_risk_outcome(value)
    return sorted(
        unique.values(),
        key=lambda value: (
            str(value.get("tradeDate") or ""),
            str(value.get("decisionId") or ""),
        ),
    )


def _stress_net_r(outcome, base_r, *, base_bps=5.0, stress_bps=10.0):
    if stress_bps <= base_bps:
        return float(base_r), True
    metrics = (outcome or {}).get("metrics") or {}
    entry = (outcome or {}).get("entry") or {}
    exit_ = (outcome or {}).get("exit") or {}
    try:
        initial_risk_cash = float(metrics.get("initialRiskCash"))
        entry_gross = float(entry.get("grossAmount"))
        exit_gross = float(exit_.get("grossAmount"))
    except (TypeError, ValueError):
        return float(base_r), False
    if (
        not all(np.isfinite(value) for value in (
            initial_risk_cash,
            entry_gross,
            exit_gross,
        ))
        or initial_risk_cash <= 0
        or entry_gross <= 0
        or exit_gross <= 0
    ):
        return float(base_r), False
    extra_cost = (
        (entry_gross + exit_gross)
        * (stress_bps - base_bps)
        / 10_000
    )
    return float(base_r) - extra_cost / initial_risk_cash, True


def build_opportunity_review_dataset(outcomes, *, feature_schema="v3"):
    if feature_schema == "v4":
        active_feature_names = FEATURE_NAMES_V4
        active_feature_vector = feature_vector_v4
    elif feature_schema == "v3":
        active_feature_names = FEATURE_NAMES
        active_feature_vector = feature_vector
    else:
        raise ValueError("feature_schema 仅支持 v3 或 v4")
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
            vector = active_feature_vector(
                outcome.get("reviewScoreInput")
            )
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
        # 费后奖励塑形：默认全 0 权重时等于原始 netR，y_opportunity_r 逐字节不变；
        # 未成交事件仍恒为 0。惩罚系数只在离线搜索到的挑战者训练中显式开启。
        shaped_r = (
            cost_aware_opportunity_reward(
                (event[0] or {}).get("metrics"),
                filled=True,
                base_r=float(conditional_row[3]),
            )
            if filled
            else 0.0
        )
        stress_r, stress_available = (
            _stress_net_r(
                event[0],
                shaped_r,
            )
            if filled
            else (0.0, True)
        )
        opportunity.append((
            event[0],
            event[1],
            shaped_r,
            event[3],
            conditional_row[5] if filled else event[4],
            stress_r,
            stress_available,
        ))
    return {
        "schema_version": DATASET_SCHEMA_VERSION,
        "feature_schema": feature_schema,
        "event_ledger": event_ledger,
        "X_all": np.asarray(
            [item[1] for item in events],
            dtype=np.float32,
        ).reshape((-1, len(active_feature_names))),
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
        ).reshape((-1, len(active_feature_names))),
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
        ).reshape((-1, len(active_feature_names))),
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
        "y_opportunity_r_stress10": np.asarray(
            [item[5] for item in opportunity],
            dtype=np.float32,
        ),
        "stress10_available_opportunity": np.asarray(
            [item[6] for item in opportunity],
            dtype=np.int8,
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
        "feature_names": np.asarray(active_feature_names, dtype="<U80"),
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
