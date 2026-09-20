"""Scoped SHADOW artifact for action-value models; never enables new risk."""

import hashlib
import json
import os
import re
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import joblib
import numpy as np

from platform_app.modules.experiments.action_value_evaluation import (
    fit_action_value_calibration,
)
from platform_app.modules.experiments.action_value_models import (
    ACTION_VALUE_FAMILIES,
    fit_action_value_candidate,
)

SCHEMA_VERSION = "action-value-shadow-bundle.v1"
BOARD_CODES = {"MAIN": 0, "CHINEXT": 1, "STAR": 2, "BEIJING": 3}


class ActionValueShadowError(ValueError):
    pass


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


@dataclass(frozen=True)
class ActionValueSupportDomain:
    feature_names: tuple[str, ...]
    lower_bounds: np.ndarray
    upper_bounds: np.ndarray
    supported_boards: tuple[int, ...]

    def reason_codes(self, features, board) -> list[str]:
        values = np.asarray(features, dtype=np.float64)
        if values.shape != (len(self.feature_names),) or not np.all(np.isfinite(values)):
            return ["FEATURE_CONTRACT_INVALID"]
        board_code = BOARD_CODES.get(board, board)
        try:
            board_code = int(board_code)
        except (TypeError, ValueError):
            return [f"UNSUPPORTED_BOARD:{board}"]
        reasons = []
        if board_code not in self.supported_boards:
            reasons.append(f"UNSUPPORTED_BOARD:{board_code}")
        outside = (values < self.lower_bounds) | (values > self.upper_bounds)
        reasons.extend(
            f"FEATURE_OUT_OF_RANGE:{name}"
            for name, failed in zip(self.feature_names, outside, strict=True)
            if failed
        )
        return reasons


@dataclass(frozen=True)
class ActionValueShadowModel:
    candidate: object
    calibration: object
    domain: ActionValueSupportDomain
    maximum_supported_cash_cny: str

    def predict_action_value(self, *, decision_date, scenario_values, board) -> dict:
        reasons = self.domain.reason_codes(scenario_values, board)
        if reasons:
            return {
                "status": "OOD",
                "releaseStatus": "SHADOW",
                "allowsNewRisk": False,
                "reasonCodes": reasons,
            }
        predictions = self.calibration.predict(
            np.asarray([scenario_values], dtype=np.float32)
        )
        return {
            "status": "SHADOW",
            "releaseStatus": "SHADOW",
            "allowsNewRisk": False,
            "decisionDate": str(decision_date),
            "family": self.candidate.family,
            "selectionThreshold": self.calibration.selection_threshold,
            "dailySelectionLimit": self.calibration.daily_selection_limit,
            "maximumSupportedCashCny": self.maximum_supported_cash_cny,
            **{name: float(values[0]) for name, values in predictions.items()},
        }


def _support_domain(
    data,
    report,
    *,
    minimum_samples,
    minimum_selections,
    minimum_return_lower_bound,
):
    supported = []
    for board, metrics in report["supportByBoard"].items():
        confidence = metrics["dailyNetReturnVsNoTrade"]
        if (
            metrics["samples"] >= minimum_samples
            and metrics["selectedSamples"] >= minimum_selections
            and confidence is not None
            and confidence["oneSided95Lower"] > minimum_return_lower_bound
        ):
            supported.append(int(board))
    if not supported:
        raise ActionValueShadowError("ACTION_VALUE_SUPPORTED_DOMAIN_EMPTY")
    mask = np.isin(data.boards, supported)
    values = np.asarray(data.features[mask], dtype=np.float64)
    lower = np.min(values, axis=0)
    upper = np.max(values, axis=0)
    constant = lower == upper
    lower[constant] -= 1e-9
    upper[constant] += 1e-9
    return ActionValueSupportDomain(
        feature_names=data.feature_names,
        lower_bounds=lower,
        upper_bounds=upper,
        supported_boards=tuple(sorted(supported)),
    )


def fit_action_value_shadow(
    data,
    walk_forward_result,
    *,
    account_gate,
    minimum_domain_samples: int = 100,
    minimum_domain_selections: int = 30,
    minimum_domain_return_lower_bound: float = 0.0,
) -> ActionValueShadowModel:
    report = walk_forward_result.report
    if not report["gate"]["passed"]:
        raise ActionValueShadowError("ACTION_VALUE_DEVELOPMENT_GATE_FAILED")
    if not account_gate.get("passed"):
        raise ActionValueShadowError("ACTION_VALUE_ACCOUNT_GATE_FAILED")
    config = report["protocol"]
    selected = Counter(
        fold["selectedFamily"] for fold in report["foldReports"]
    )
    family = min(
        selected,
        key=lambda name: (-selected[name], ACTION_VALUE_FAMILIES.index(name)),
    )
    unique_dates = np.unique(data.dates)
    calibration_sessions = int(config["calibration_sessions"])
    purge_sessions = int(config["purge_sessions"])
    calibration_start_index = len(unique_dates) - calibration_sessions
    train_end_index = calibration_start_index - purge_sessions - 1
    if train_end_index < int(config["inner_minimum_train_sessions"]) - 1:
        raise ActionValueShadowError("ACTION_VALUE_SHADOW_SUPPORT_INSUFFICIENT")
    train = data.dates <= unique_dates[train_end_index]
    calibration = data.dates >= unique_dates[calibration_start_index]
    candidate = fit_action_value_candidate(
        data,
        train,
        family=family,
        iterations=int(config["iterations"]),
        min_samples_leaf=int(config["min_samples_leaf"]),
        threads=int(config["threads"]),
    )
    calibrated = fit_action_value_calibration(
        candidate,
        data,
        calibration,
        method=config["calibration_method"],
        interval_coverage=float(config["interval_coverage"]),
        stress_cost=float(config["stress_cost"]),
        minimum_selected=int(config["minimum_calibration_selections"]),
    )
    return ActionValueShadowModel(
        candidate=candidate,
        calibration=calibrated,
        domain=_support_domain(
            data,
            report,
            minimum_samples=minimum_domain_samples,
            minimum_selections=minimum_domain_selections,
            minimum_return_lower_bound=minimum_domain_return_lower_bound,
        ),
        maximum_supported_cash_cny=account_gate["maximumSupportedCashCny"],
    )


def write_action_value_shadow_bundle(
    *,
    output_root: Path,
    bundle_id: str,
    model: ActionValueShadowModel,
    walk_forward_report: dict,
    lineage: dict,
) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", bundle_id):
        raise ActionValueShadowError("ACTION_VALUE_BUNDLE_ID_INVALID")
    root = output_root.expanduser().resolve()
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        raise ActionValueShadowError("ACTION_VALUE_SHADOW_ALREADY_EXISTS")
    root.mkdir(parents=True, exist_ok=True)
    artifact_path = root / "model.joblib"
    report_path = root / "walk-forward.json"
    artifact_temporary = artifact_path.with_suffix(".joblib.tmp")
    report_temporary = report_path.with_suffix(".json.tmp")
    joblib.dump(model, artifact_temporary, compress=3)
    report_temporary.write_text(
        json.dumps(walk_forward_report, ensure_ascii=False, sort_keys=True, indent=2)
        + "\n"
    )
    os.replace(artifact_temporary, artifact_path)
    os.replace(report_temporary, report_path)
    excluded_boards = sorted(
        set(int(board) for board in walk_forward_report["supportByBoard"])
        - set(model.domain.supported_boards)
    )
    manifest = {
        "bundleId": bundle_id,
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": datetime.now(UTC).isoformat(),
        "releaseStatus": "SHADOW",
        "deploymentMode": "SHADOW",
        "allowsNewRisk": False,
        "artifact": artifact_path.name,
        "artifactSha256": _file_sha256(artifact_path),
        "walkForwardReport": report_path.name,
        "walkForwardReportSha256": _file_sha256(report_path),
        "featureNames": list(model.domain.feature_names),
        "supportedBoards": list(model.domain.supported_boards),
        "excludedBoards": excluded_boards,
        "maximumSupportedCashCny": model.maximum_supported_cash_cny,
        "lineage": lineage,
        "releaseBlockers": [
            "PROSPECTIVE_FORWARD_GATE_PENDING",
            "JOINT_AGENT_GATE_PENDING",
            "MANUAL_APPROVAL_PENDING",
        ],
    }
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, manifest_path)
    return manifest


class ActionValueShadowBundle:
    def __init__(self, root: Path):
        root = root.expanduser().resolve()
        manifest_path = root / "manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text())
            artifact_path = root / manifest["artifact"]
            report_path = root / manifest["walkForwardReport"]
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise ActionValueShadowError("ACTION_VALUE_SHADOW_MANIFEST_INVALID") from exc
        if (
            manifest.get("schemaVersion") != SCHEMA_VERSION
            or manifest.get("releaseStatus") != "SHADOW"
            or manifest.get("deploymentMode") != "SHADOW"
            or manifest.get("allowsNewRisk") is not False
            or not artifact_path.is_file()
            or not report_path.is_file()
            or _file_sha256(artifact_path) != manifest.get("artifactSha256")
            or _file_sha256(report_path) != manifest.get("walkForwardReportSha256")
        ):
            raise ActionValueShadowError("ACTION_VALUE_SHADOW_MANIFEST_INVALID")
        model = joblib.load(artifact_path)
        if (
            not isinstance(model, ActionValueShadowModel)
            or tuple(manifest.get("featureNames", ())) != model.domain.feature_names
            or tuple(manifest.get("supportedBoards", ()))
            != model.domain.supported_boards
        ):
            raise ActionValueShadowError("ACTION_VALUE_SHADOW_ARTIFACT_INVALID")
        self.manifest = manifest
        self.model = model

    def predict_action_value(self, *, decision_date, scenario_values, board) -> dict:
        return self.model.predict_action_value(
            decision_date=decision_date,
            scenario_values=scenario_values,
            board=board,
        )
