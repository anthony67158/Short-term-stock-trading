import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from decision_engine.heads.review_contract import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)
from decision_engine.heads.review_contract_v4 import (  # noqa: E402
    FEATURE_NAMES_V4,
    FEATURE_SCHEMA_VERSION_V4,
)
from decision_engine.training.review_schema_migration import (  # noqa: E402
    project_v4_outcomes_to_v3,
    select_review_schema_migration,
)


def metadata(version, names, model_version, *, eligible=True):
    return {
        "featureSchemaVersion": version,
        "featureNames": list(names),
        "modelVersion": model_version,
        "productionEligible": eligible,
    }


def dataset():
    size = 500
    dates = np.asarray([
        f"2026-08-{index % 10 + 1:02d}"
        for index in range(size)
    ])
    codes = np.asarray(["600001"] * size)
    groups = np.asarray([f"600001:event-{index}" for index in range(size)])
    return {
        "X_all": np.zeros((size, len(FEATURE_NAMES_V4))),
        "dates_opportunity": dates,
        "codes": codes,
        "codes_all": codes,
        "codes_opportunity": codes,
        "event_group_ids_opportunity": groups,
        "summary": {
            "universe": {"schema_version": "cn-main-board.v1"},
        },
    }


def partitions():
    indices = np.arange(500)
    return {
        "confirmation": indices[:200],
        "fillConfirmation": indices,
        "opportunityConfirmation": indices,
    }


class ReviewSchemaMigrationTest(unittest.TestCase):
    def test_projects_v4_prefix_to_exact_v3_contract(self):
        value = {
            "reviewScoreInput": {
                "schemaVersion": FEATURE_SCHEMA_VERSION_V4,
                "factors": {
                    name: float(index)
                    for index, name in enumerate(FEATURE_NAMES_V4)
                },
            },
        }

        projected = project_v4_outcomes_to_v3([value])

        self.assertEqual(len(projected), 1)
        review = projected[0]["reviewScoreInput"]
        self.assertEqual(review["schemaVersion"], FEATURE_SCHEMA_VERSION)
        self.assertEqual(tuple(review["factors"]), FEATURE_NAMES)

    def test_same_event_v3_to_v4_migration_can_publish(self):
        v3 = dataset()
        v3["X_all"] = np.zeros((500, len(FEATURE_NAMES)))
        v4 = dataset()
        champion = metadata(
            FEATURE_SCHEMA_VERSION,
            FEATURE_NAMES,
            "review.v3",
        )
        challenger = metadata(
            FEATURE_SCHEMA_VERSION_V4,
            FEATURE_NAMES_V4,
            "review.v4",
        )
        with tempfile.TemporaryDirectory() as directory, patch(
            "decision_engine.training.review_schema_migration._load_bundle",
            side_effect=[(["v3"], champion), (["v4"], challenger)],
        ), patch(
            "decision_engine.training.review_schema_migration."
            "build_migration_datasets",
            return_value=(v3, v4),
        ), patch(
            "decision_engine.training.review_schema_migration."
            "_confirmation_partitions",
            return_value=partitions(),
        ), patch(
            "decision_engine.training.review_schema_migration."
            "evaluate_review_release",
            side_effect=[{"version": "v3"}, {"version": "v4"}],
        ), patch(
            "decision_engine.training.review_schema_migration."
            "review_promotion_gate",
            return_value={
                "passed": True,
                "blockers": [],
                "improvements": ["净R下界改善"],
            },
        ):
            decision = select_review_schema_migration(
                "dataset.json.gz",
                "champion",
                "challenger",
                decision_output=os.path.join(directory, "decision.json"),
            )

        self.assertEqual(decision["action"], "PUBLISH")
        self.assertTrue(decision["eligible"])
        self.assertEqual(decision["migration"]["v3Samples"], 500)
        self.assertEqual(decision["migration"]["v4Samples"], 500)

    def test_non_v3_champion_is_blocked(self):
        v4 = dataset()
        champion = metadata(
            FEATURE_SCHEMA_VERSION_V4,
            FEATURE_NAMES_V4,
            "review.v4.old",
        )
        challenger = metadata(
            FEATURE_SCHEMA_VERSION_V4,
            FEATURE_NAMES_V4,
            "review.v4.new",
        )
        with tempfile.TemporaryDirectory() as directory, patch(
            "decision_engine.training.review_schema_migration._load_bundle",
            side_effect=[(["old"], champion), (["new"], challenger)],
        ), patch(
            "decision_engine.training.review_schema_migration."
            "build_migration_datasets",
            return_value=(v4, v4),
        ), patch(
            "decision_engine.training.review_schema_migration."
            "_confirmation_partitions",
            return_value=partitions(),
        ), patch(
            "decision_engine.training.review_schema_migration."
            "evaluate_review_release",
        ) as evaluate:
            decision = select_review_schema_migration(
                "dataset.json.gz",
                "champion",
                "challenger",
                decision_output=os.path.join(directory, "decision.json"),
            )

        self.assertEqual(decision["action"], "KEEP_CURRENT")
        self.assertIn(
            "迁移源必须是V3复核冠军",
            decision["compatibility"]["blockers"],
        )
        evaluate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
