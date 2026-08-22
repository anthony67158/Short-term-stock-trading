import copy
import json
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
PROJECT_ROOT = os.path.abspath(os.path.join(SERVICE_ROOT, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from strategy_contract_v2 import (
    SCHEMA_VERSION,
    strategy_fingerprint_v2,
    validate_strategy_spec_v2,
)


def load_fixture():
    path = os.path.join(
        PROJECT_ROOT,
        "shared",
        "fixtures",
        "strategy-spec-v2-conformance.json",
    )
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def patched(source, dotted_path, value):
    output = copy.deepcopy(source)
    target = output
    keys = dotted_path.split(".")
    for key in keys[:-1]:
        target = target[key]
    target[keys[-1]] = value
    output.pop("specVersion", None)
    output["specVersion"] = strategy_fingerprint_v2(output)
    return output


class StrategyContractV2Test(unittest.TestCase):
    def test_matches_javascript_fixture_and_schema_required_fields(self):
        fixture = load_fixture()
        case = next(item for item in fixture["cases"] if item["valid"])
        validated = validate_strategy_spec_v2(case["spec"])

        self.assertEqual(SCHEMA_VERSION, "strategy-spec.v2")
        self.assertEqual(
            strategy_fingerprint_v2(case["spec"]),
            case["expectedSpecVersion"],
        )
        self.assertEqual(validated["specVersion"], case["expectedSpecVersion"])

        schema_path = os.path.join(
            PROJECT_ROOT,
            "shared",
            "contracts",
            "strategy-spec.v2.schema.json",
        )
        with open(schema_path, encoding="utf-8") as handle:
            schema = json.load(handle)
        self.assertEqual(
            set(schema["required"]),
            set(validated),
        )

    def test_rejects_each_invalid_cross_runtime_fixture(self):
        fixture = load_fixture()
        valid = next(item for item in fixture["cases"] if item["valid"])["spec"]

        for case in (item for item in fixture["cases"] if not item["valid"]):
            dotted_path, value = next(iter(case["patch"].items()))
            with self.subTest(case=case["name"]):
                with self.assertRaises(ValueError):
                    validate_strategy_spec_v2(
                        patched(valid, dotted_path, value)
                    )

    def test_preserves_the_36_feature_production_dependency(self):
        fixture = load_fixture()
        source = next(
            item for item in fixture["cases"] if item["valid"]
        )["spec"]
        broken = copy.deepcopy(source)
        broken["modelDependencies"][0]["featureCount"] = 37
        broken["specVersion"] = strategy_fingerprint_v2(broken)

        with self.assertRaisesRegex(ValueError, "36"):
            validate_strategy_spec_v2(broken)


if __name__ == "__main__":
    unittest.main()
