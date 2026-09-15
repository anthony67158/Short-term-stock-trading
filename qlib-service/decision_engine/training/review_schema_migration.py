"""One-time, same-event gate for migrating review models from V3 to V4."""

from __future__ import annotations

import argparse
import copy
import gzip
import json
import time

import numpy as np

from ..heads.review_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)
from ..heads.review_contract_v4 import (
    FEATURE_NAMES_V4,
    FEATURE_SCHEMA_VERSION_V4,
)
from .review_dataset import (
    build_opportunity_review_dataset,
    is_main_board_code,
    load_opportunity_review_dataset,
    normalize_review_history_outcomes,
)
from .review_release import (
    REVIEW_RELEASE_THRESHOLDS,
    _confirmation_partitions,
    _load_bundle,
    _write_json,
    evaluate_review_release,
    fresh_evidence_blockers,
    review_promotion_gate,
)


MIGRATION_SCHEMA_VERSION = "review-schema-migration.v1"


def _read_payload(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def project_v4_outcomes_to_v3(outcomes):
    projected = []
    for value in outcomes:
        review = (value or {}).get("reviewScoreInput")
        factors = (review or {}).get("factors")
        factor_values = (review or {}).get("factorValues")
        if (
            not isinstance(review, dict)
            or review.get("schemaVersion") != FEATURE_SCHEMA_VERSION_V4
        ):
            continue
        if isinstance(factors, dict) and tuple(factors) == FEATURE_NAMES_V4:
            projected_review = {
                **review,
                "schemaVersion": FEATURE_SCHEMA_VERSION,
                "factors": {
                    name: factors[name]
                    for name in FEATURE_NAMES
                },
            }
        elif (
            "factors" not in review
            and isinstance(factor_values, list)
            and len(factor_values) == len(FEATURE_NAMES_V4)
        ):
            projected_review = {
                key: item
                for key, item in review.items()
                if key != "factorValues"
            }
            projected_review.update({
                "schemaVersion": FEATURE_SCHEMA_VERSION,
                "factorValues": factor_values[:len(FEATURE_NAMES)],
            })
        else:
            continue
        item = copy.deepcopy(value)
        item["reviewScoreInput"] = projected_review
        projected.append(item)
    return projected


def project_v4_dataset_to_v3(dataset):
    if dataset.get("feature_schema") != "v4":
        raise ValueError("迁移数组必须使用V4复核特征合同")
    projected = dict(dataset)
    projected.update({
        "feature_schema": "v3",
        "feature_names": np.asarray(FEATURE_NAMES),
        "X_all": np.asarray(
            dataset["X_all"][:, :len(FEATURE_NAMES)],
            dtype=np.float32,
        ),
        "X": np.asarray(
            dataset["X"][:, :len(FEATURE_NAMES)],
            dtype=np.float32,
        ),
        "X_opportunity": np.asarray(
            dataset["X_opportunity"][:, :len(FEATURE_NAMES)],
            dtype=np.float32,
        ),
    })
    return projected


def build_migration_datasets(path):
    if str(path).endswith(".npz"):
        v4 = load_opportunity_review_dataset(path)
        v3 = project_v4_dataset_to_v3(v4)
    else:
        outcomes = normalize_review_history_outcomes(_read_payload(path))
        v4 = build_opportunity_review_dataset(
            outcomes,
            feature_schema="v4",
        )
        v3 = build_opportunity_review_dataset(
            project_v4_outcomes_to_v3(outcomes),
            feature_schema="v3",
        )
    for field in (
        "dates",
        "codes",
        "event_group_ids",
        "y_win",
        "y_net_r",
        "dates_all",
        "codes_all",
        "event_group_ids_all",
        "y_fill",
        "dates_opportunity",
        "codes_opportunity",
        "event_group_ids_opportunity",
        "y_opportunity_r",
    ):
        if not np.array_equal(v3[field], v4[field]):
            raise ValueError(f"V3/V4迁移数据未按同一事件对齐: {field}")
    return v3, v4


def _confirmation_evidence(dataset, partitions):
    opportunity = partitions["opportunityConfirmation"]
    dates = sorted(set(
        dataset["dates_opportunity"][opportunity].astype(str).tolist()
    ))
    return {
        "championCutoffDate": None,
        "startDate": dates[0] if dates else None,
        "endDate": dates[-1] if dates else None,
        "dates": len(dates),
        "conditionalSamples": int(len(partitions["confirmation"])),
        "fillSamples": int(len(partitions["fillConfirmation"])),
        "opportunitySamples": int(len(opportunity)),
    }


def select_review_schema_migration(
    dataset_path,
    champion_directory,
    challenger_directory,
    *,
    decision_output,
):
    champion_members, champion_metadata = _load_bundle(
        champion_directory
    )
    challenger_members, challenger_metadata = _load_bundle(
        challenger_directory
    )
    v3, v4 = build_migration_datasets(dataset_path)
    partitions = _confirmation_partitions(v4)
    evidence = _confirmation_evidence(v4, partitions)
    blockers = []
    if (
        champion_metadata.get("featureSchemaVersion")
        != FEATURE_SCHEMA_VERSION
        or tuple(champion_metadata.get("featureNames") or ())
        != FEATURE_NAMES
    ):
        blockers.append("迁移源必须是V3复核冠军")
    if (
        challenger_metadata.get("featureSchemaVersion")
        != FEATURE_SCHEMA_VERSION_V4
        or tuple(challenger_metadata.get("featureNames") or ())
        != FEATURE_NAMES_V4
        or tuple(FEATURE_NAMES_V4[:len(FEATURE_NAMES)]) != FEATURE_NAMES
    ):
        blockers.append("迁移目标必须是以V3为前缀的V4复核模型")
    challenger_production_eligible = (
        challenger_metadata.get("productionEligible") is True
    )
    universe = (v4.get("summary") or {}).get("universe") or {}
    if (
        universe.get("schema_version") != "cn-main-board.v1"
        or any(
            not is_main_board_code(code)
            for field in ("codes", "codes_all", "codes_opportunity")
            for code in np.asarray(v4[field]).astype(str)
        )
    ):
        blockers.append("V4迁移数据未通过沪深主板边界校验")
    blockers.extend(fresh_evidence_blockers(evidence))

    champion_evaluation = None
    challenger_evaluation = None
    improvements = []
    if not blockers:
        champion_evaluation = evaluate_review_release(
            v3,
            partitions,
            champion_members,
            champion_metadata,
        )
        challenger_evaluation = evaluate_review_release(
            v4,
            partitions,
            challenger_members,
            challenger_metadata,
        )
        gate = review_promotion_gate(
            champion_evaluation,
            challenger_evaluation,
            evidence,
        )
        blockers.extend(gate["blockers"])
        improvements = gate["improvements"]
    if not challenger_production_eligible:
        blockers.append("V4挑战者未通过自身生产门禁")

    action = "PUBLISH" if not blockers else "KEEP_CURRENT"
    decision = {
        "schemaVersion": MIGRATION_SCHEMA_VERSION,
        "generatedAt": int(time.time() * 1000),
        "action": action,
        "eligible": action == "PUBLISH",
        "reason": (
            "V4在同一未见事件上优于V3并通过全部风险门禁"
            if action == "PUBLISH"
            else "V4未能在同一未见事件上证明优于V3"
        ),
        "championVersion": champion_metadata["modelVersion"],
        "challengerVersion": challenger_metadata["modelVersion"],
        "selectedVersion": (
            challenger_metadata["modelVersion"]
            if action == "PUBLISH"
            else champion_metadata["modelVersion"]
        ),
        "championFeatureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "challengerFeatureSchemaVersion": FEATURE_SCHEMA_VERSION_V4,
        "freshHoldout": evidence,
        "thresholds": REVIEW_RELEASE_THRESHOLDS,
        "evaluation": {
            "champion": champion_evaluation,
            "challenger": challenger_evaluation,
        },
        "compatibility": {
            "passed": action == "PUBLISH",
            "blockers": list(dict.fromkeys(blockers)),
            "improvements": improvements,
        },
        "migration": {
            "schemaVersion": "review-feature-migration.v1",
            "source": FEATURE_SCHEMA_VERSION,
            "target": FEATURE_SCHEMA_VERSION_V4,
            "sameEventComparison": True,
            "v3Samples": int(len(v3["X_all"])),
            "v4Samples": int(len(v4["X_all"])),
        },
    }
    _write_json(decision_output, decision)
    return decision


def main():
    parser = argparse.ArgumentParser(
        description="在同一历史事件上执行首次V3到V4复核模型迁移门禁",
    )
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--champion", required=True)
    parser.add_argument("--challenger", required=True)
    parser.add_argument("--decision-output", required=True)
    args = parser.parse_args()
    decision = select_review_schema_migration(
        args.dataset,
        args.champion,
        args.challenger,
        decision_output=args.decision_output,
    )
    print(json.dumps({
        "action": decision["action"],
        "eligible": decision["eligible"],
        "blockers": decision["compatibility"]["blockers"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
