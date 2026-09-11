"""Deterministic feature routing for task-specific decision heads."""

from __future__ import annotations


ROUTER_VERSION = "action-router.tree-v1"


def selected_category(item, feature_names, prefix):
    factors = item["factors"]
    candidates = [
        name[len(prefix) + 1:]
        for name in feature_names
        if name.startswith(prefix + "_")
        and factors[name] >= 0.5
    ]
    return candidates[0] if candidates else "UNKNOWN"


def route_items(items, feature_names):
    playbook_ids = [
        selected_category(item, feature_names, "playbook")
        for item in items
    ]
    routes = [
        selected_category(item, feature_names, "route")
        for item in items
    ]
    calibration_buckets = [
        ":".join([
            selected_category(item, feature_names, "market"),
            selected_category(item, feature_names, "sector"),
            selected_category(item, feature_names, "time"),
        ])
        for item in items
    ]
    return {
        "playbook_ids": playbook_ids,
        "routes": routes,
        "calibration_buckets": calibration_buckets,
    }
