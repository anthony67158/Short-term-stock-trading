"""Review head contract.

The first production version keeps the existing deterministic fallback:
when no trained review head is present, a triggered review always requests
one fresh pass through all decision heads.
"""

from __future__ import annotations


HEAD_VERSION = "review-head.fallback-v1"


def review_decision(*, triggered, model_output=None):
    if not triggered:
        return {
            "stableProbability": None,
            "recomputeValueR": None,
            "recompute": False,
            "source": "NOT_TRIGGERED",
        }
    if not isinstance(model_output, dict):
        return {
            "stableProbability": None,
            "recomputeValueR": None,
            "recompute": True,
            "source": "DETERMINISTIC_FALLBACK",
        }
    stable = model_output.get("stableProbability")
    value = model_output.get("recomputeValueR")
    if not isinstance(stable, (int, float)):
        stable = None
    if not isinstance(value, (int, float)):
        value = None
    return {
        "stableProbability": stable,
        "recomputeValueR": value,
        "recompute": (
            stable is None
            or value is None
            or stable < 0.75
            or value > 0
        ),
        "source": "MODEL",
    }
