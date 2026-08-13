"""Build the fixed, pre-registered Phase 2 strategy candidate catalog."""

import argparse
import copy
import json
import os

from strategy_contract import (
    load_strategy_spec,
    strategy_fingerprint,
    validate_strategy_spec,
)


def _set_threshold(node, field, value):
    if node.get("type"):
        changed = False
        for child in node.get("conditions", []):
            changed = _set_threshold(child, field, value) or changed
        return changed
    if node.get("field") == field and node.get("op") == "GTE":
        node["value"] = value
        return True
    return False


def _variant(source, thresholds):
    spec = copy.deepcopy(source)
    for field, value in thresholds.items():
        if not _set_threshold(spec["entry"], field, value):
            raise ValueError("base strategy missing GTE condition: %s" % field)
    spec.pop("specVersion", None)
    spec["specVersion"] = strategy_fingerprint(spec)
    return validate_strategy_spec(spec)


def build_candidate_catalog(base_strategy):
    base = validate_strategy_spec(base_strategy)
    candidates = [
        {
            "candidateId": "current-baseline",
            "hypothesis": (
                "现行55/55阈值作为不改变生产策略的基线"
            ),
            "strategy": _variant(
                base,
                {"marketScore": 55, "quant.score": 55},
            ),
        },
        {
            "candidateId": "balanced-confirmation-60",
            "hypothesis": (
                "市场与量化同时达到60可减少低确定性拥挤信号"
            ),
            "strategy": _variant(
                base,
                {"marketScore": 60, "quant.score": 60},
            ),
        },
        {
            "candidateId": "quant-confirmation-65",
            "hypothesis": (
                "保持市场门槛55，仅提高量化确认到65可保留行情覆盖"
            ),
            "strategy": _variant(
                base,
                {"marketScore": 55, "quant.score": 65},
            ),
        },
    ]
    return {
        "schemaVersion": "strategy-candidate-catalog.v1",
        "registrationPolicy": "FIXED_THREE_CONFIRMATION_HYPOTHESES_V1",
        "baseStrategyId": base["strategyId"],
        "baseSpecVersion": base["specVersion"],
        "candidates": candidates,
    }


def _write_json(path, payload):
    output = os.path.abspath(path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temporary = "%s.tmp.%d" % (output, os.getpid())
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--strategy", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    catalog = build_candidate_catalog(load_strategy_spec(args.strategy))
    _write_json(args.out, catalog)
    print(json.dumps({
        "out": os.path.abspath(args.out),
        "baseSpecVersion": catalog["baseSpecVersion"],
        "candidates": [
            {
                "candidateId": item["candidateId"],
                "specVersion": item["strategy"]["specVersion"],
            }
            for item in catalog["candidates"]
        ],
    }, ensure_ascii=False, indent=2))
    print("STRATEGY_CANDIDATE_CATALOG_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
