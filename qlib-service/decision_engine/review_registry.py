"""Hot-reloaded registry for trigger-review action-value models."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
import time

from model_lib import _oss_bucket

from .heads.review_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
)
from .registry import CatBoostJsonRanker


REVIEW_MANIFEST_SCHEMA_VERSION = "decision-review-model-manifest.v2"
REVIEW_MODEL_SCHEMA_VERSION = "decision-review-model.v2"
REVIEW_ARTIFACT_SCHEMA_VERSION = "decision-review-ensemble.v2"
REVIEW_PREDICTION_CONTRACT = "trigger-review-action-value.v2"
REVIEW_LABEL_CONTRACT_VERSION = "trigger-review-label.v3"
REVIEW_EXIT_POLICY_VERSION = "trailing-exit.v1"
REVIEW_RISK_PROFILE_VERSION = "account-risk-profiles.v1"
REVIEW_OBSERVATION_POLICY_VERSION = "trigger-review-observation.v1"
REVIEW_OBSERVATION_DURATION_MS = 10 * 60 * 1000
REVIEW_ENTRY_TIMING = "NEXT_BAR_AFTER_OBSERVATION"
REVIEW_ARTIFACT_FILENAMES = {
    "ensemble": "review_seed_ensemble.json",
    "meta": "review_meta.json",
}
REVIEW_MODEL_PREFIX = os.environ.get(
    "DECISION_REVIEW_MODEL_PREFIX",
    "opportunitymodel/review/",
)
REVIEW_MANIFEST_KEY = REVIEW_MODEL_PREFIX + "manifest.json"
LOCAL_RELEASE_ROOT = "/tmp/decision-review-model-releases"
MODEL_TTL_SECONDS = 60

_MODELS = None
_META = None
_LAST_CHECK_AT = 0.0
_LOAD_LOCK = threading.Lock()


def _valid_feature_support(value):
    if not isinstance(value, dict):
        return False
    lower = value.get("lower")
    upper = value.get("upper")
    indices = value.get("missingFeatureIndices")
    patterns = value.get("missingPatterns")
    threshold = value.get("maximumOutlierFraction")
    if (
        value.get("schemaVersion") != "review-feature-support.v1"
        or not isinstance(lower, list)
        or not isinstance(upper, list)
        or len(lower) != len(FEATURE_NAMES)
        or len(upper) != len(FEATURE_NAMES)
        or not isinstance(indices, list)
        or not isinstance(patterns, list)
        or not patterns
        or not isinstance(threshold, (int, float))
        or not 0 < threshold <= 1
    ):
        return False
    if any(
        not isinstance(item, (int, float)) or not math.isfinite(item)
        for item in (*lower, *upper)
    ) or any(left > right for left, right in zip(lower, upper)):
        return False
    if (
        len(indices) != len(set(indices))
        or any(
            not isinstance(index, int)
            or index < 0
            or index >= len(FEATURE_NAMES)
            for index in indices
        )
    ):
        return False
    return all(
        isinstance(pattern, str)
        and len(pattern) == len(indices)
        and set(pattern).issubset({"0", "1"})
        for pattern in patterns
    )


def _valid_confirmation_audit(value):
    return (
        isinstance(value, dict)
        and value.get("schemaVersion")
        == "review-confirmation-audit.v1"
        and value.get("reusePolicy") == "SINGLE_SELECTION"
        and all(
            re.fullmatch(r"[0-9a-f]{64}", str(value.get(field) or ""))
            for field in (
                "selectionDataHash",
                "candidateHash",
                "confirmationDataHash",
            )
        )
    )


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_review_metadata(metadata, model_version=None):
    observation = (
        metadata.get("observationPolicy")
        if isinstance(metadata, dict)
        else None
    )
    if (
        not isinstance(metadata, dict)
        or metadata.get("schemaVersion") != REVIEW_MODEL_SCHEMA_VERSION
        or metadata.get("featureSchemaVersion") != FEATURE_SCHEMA_VERSION
        or tuple(metadata.get("featureNames") or ()) != FEATURE_NAMES
        or metadata.get("predictionContract")
        != REVIEW_PREDICTION_CONTRACT
        or metadata.get("priceContractSchemaVersion")
        != REVIEW_PRICE_CONTRACT_SCHEMA_VERSION
        or metadata.get("labelContractVersion")
        != REVIEW_LABEL_CONTRACT_VERSION
        or metadata.get("exitPolicyVersion")
        != REVIEW_EXIT_POLICY_VERSION
        or metadata.get("riskProfileVersion")
        != REVIEW_RISK_PROFILE_VERSION
        or metadata.get("valueHead") not in {"DECOMPOSED", "DIRECT"}
        or not str(metadata.get("modelVersion") or "")
        or not isinstance(
            metadata.get("fillCalibrationSampleCount"),
            int,
        )
        or metadata["fillCalibrationSampleCount"] <= 0
        or not _valid_feature_support(metadata.get("featureSupport"))
        or not _valid_confirmation_audit(
            metadata.get("confirmationAudit")
        )
        or not isinstance(observation, dict)
        or observation.get("schemaVersion")
        != REVIEW_OBSERVATION_POLICY_VERSION
        or observation.get("durationMs")
        != REVIEW_OBSERVATION_DURATION_MS
        or observation.get("entryTiming") != REVIEW_ENTRY_TIMING
    ):
        raise ValueError("触价复核模型元数据无效")
    members = metadata.get("ensembleMembers")
    size = int(metadata.get("ensembleSize") or 0)
    if (
        not isinstance(members, list)
        or not 2 <= size <= 5
        or len(members) != size
        or any(
            not isinstance(member, dict)
            or not isinstance(member.get("activeFeatures"), list)
            or not isinstance(member.get("activeFillFeatures"), list)
            or not isinstance(member.get("pFillCalibration"), dict)
            or not isinstance(member.get("pWinCalibration"), dict)
            or not isinstance(member.get("q10CalibrationOffset"), (int, float))
            for member in members
        )
    ):
        raise ValueError("触价复核模型集成元数据无效")
    for member in members:
        active = member["activeFeatures"]
        active_fill = member["activeFillFeatures"]
        fill_calibration = member["pFillCalibration"]
        calibration = member["pWinCalibration"]
        if (
            not active
            or len(active) != len(set(active))
            or any(
                not isinstance(index, int)
                or index < 0
                or index >= len(FEATURE_NAMES)
                for index in active
            )
            or not active_fill
            or len(active_fill) != len(set(active_fill))
            or any(
                not isinstance(index, int)
                or index < 0
                or index >= len(FEATURE_NAMES)
                for index in active_fill
            )
            or fill_calibration.get("method")
            not in {"sigmoid", "isotonic"}
            or calibration.get("method") not in {"sigmoid", "isotonic"}
        ):
            raise ValueError("触价复核模型成员配置无效")
    if model_version and metadata["modelVersion"] != model_version:
        raise ValueError("触价复核模型版本不一致")
    return metadata


def validate_review_manifest(manifest):
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion")
        != REVIEW_MANIFEST_SCHEMA_VERSION
        or manifest.get("predictionContract")
        != REVIEW_PREDICTION_CONTRACT
        or manifest.get("featureSchemaVersion")
        != FEATURE_SCHEMA_VERSION
        or manifest.get("priceContractSchemaVersion")
        != REVIEW_PRICE_CONTRACT_SCHEMA_VERSION
        or manifest.get("labelContractVersion")
        != REVIEW_LABEL_CONTRACT_VERSION
        or manifest.get("exitPolicyVersion")
        != REVIEW_EXIT_POLICY_VERSION
        or manifest.get("riskProfileVersion")
        != REVIEW_RISK_PROFILE_VERSION
        or not _valid_confirmation_audit(
            manifest.get("confirmationAudit")
        )
    ):
        raise ValueError("触价复核模型清单版本无效")
    run_id = str(manifest.get("runId") or "")
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,95}", run_id)
        or ".." in run_id
    ):
        raise ValueError("触价复核模型runId无效")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != set(
        REVIEW_ARTIFACT_FILENAMES
    ):
        raise ValueError("触价复核模型文件清单不完整")
    expected_prefix = (
        f"{REVIEW_MODEL_PREFIX.rstrip('/')}/runs/{run_id}/"
    )
    for slot, filename in REVIEW_ARTIFACT_FILENAMES.items():
        item = files.get(slot) or {}
        key = str(item.get("key") or "")
        checksum = str(item.get("sha256") or "")
        if (
            not key.startswith(expected_prefix)
            or not key.endswith(filename)
            or ".." in key
            or not re.fullmatch(r"[0-9a-f]{64}", checksum)
        ):
            raise ValueError("触价复核模型文件清单无效")
    return manifest


def load_review_release(artifact_path, metadata_path):
    with open(metadata_path, encoding="utf-8") as handle:
        metadata = validate_review_metadata(json.load(handle))
    with open(artifact_path, encoding="utf-8") as handle:
        artifact = json.load(handle)
    members = artifact.get("members")
    if (
        artifact.get("schemaVersion")
        != REVIEW_ARTIFACT_SCHEMA_VERSION
        or artifact.get("featureSchemaVersion")
        != FEATURE_SCHEMA_VERSION
        or not isinstance(members, list)
        or len(members) != metadata["ensembleSize"]
    ):
        raise ValueError("触价复核模型集成文件无效")
    required = {
        "pFill",
        "pWinGivenFill",
        "winPayoffR",
        "lossPayoffR",
        "directNetR",
        "netRLower10",
    }
    loaded = []
    for index, member in enumerate(members):
        models = member.get("models") or {}
        if (
            set(models) != required
            or int(member.get("seed") or 0)
            != int(metadata["ensembleMembers"][index].get("seed") or 0)
        ):
            raise ValueError("触价复核模型集成成员不完整")
        loaded.append({
            slot: CatBoostJsonRanker(payload=models[slot])
            for slot in required
        })
    return {"ensemble": loaded}, metadata


def _read_remote_manifest(bucket):
    try:
        payload = bucket.get_object(REVIEW_MANIFEST_KEY).read()
    except Exception as error:
        if (
            getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            return None
        raise
    return validate_review_manifest(
        json.loads(payload.decode("utf-8"))
    )


def _download_release():
    bucket = _oss_bucket()
    if bucket is None:
        return None
    manifest = _read_remote_manifest(bucket)
    if manifest is None:
        return None
    run_id = manifest["runId"]
    if _MODELS and (_META or {}).get("modelVersion") == run_id:
        return _MODELS, _META
    release_dir = os.path.join(LOCAL_RELEASE_ROOT, run_id)
    os.makedirs(release_dir, exist_ok=True)
    final_paths = {
        slot: os.path.join(release_dir, filename)
        for slot, filename in REVIEW_ARTIFACT_FILENAMES.items()
    }
    temporary = []
    try:
        for slot, destination in final_paths.items():
            temp = destination + ".part"
            temporary.append(temp)
            payload = bucket.get_object(
                manifest["files"][slot]["key"]
            ).read()
            with open(temp, "wb") as handle:
                handle.write(payload)
            if sha256_file(temp) != manifest["files"][slot]["sha256"]:
                raise ValueError("触价复核模型文件摘要不匹配")
        loaded = load_review_release(
            final_paths["ensemble"] + ".part",
            final_paths["meta"] + ".part",
        )
        validate_review_metadata(loaded[1], run_id)
        for field in (
            "predictionContract",
            "featureSchemaVersion",
            "priceContractSchemaVersion",
            "labelContractVersion",
            "exitPolicyVersion",
            "riskProfileVersion",
        ):
            if manifest.get(field) != loaded[1].get(field):
                raise ValueError("触价复核模型清单与元数据不一致")
        manifest_audit = manifest["confirmationAudit"]
        metadata_audit = loaded[1]["confirmationAudit"]
        if any(
            manifest_audit.get(field) != metadata_audit.get(field)
            for field in (
                "selectionDataHash",
                "candidateHash",
                "confirmationDataHash",
            )
        ):
            raise ValueError("触价复核确认审计不一致")
        metadata = {
            **loaded[1],
            "usagePolicy": manifest.get("usagePolicy", "QUALIFIED"),
            "productionEligible": manifest.get(
                "productionEligible",
                False,
            ),
            "baselineSelected": manifest.get(
                "baselineSelected",
                False,
            ),
        }
        for destination in final_paths.values():
            os.replace(destination + ".part", destination)
        return loaded[0], metadata
    except Exception:
        for path in temporary:
            try:
                os.remove(path)
            except OSError:
                pass
        return None


def get_review_models(force=False):
    global _MODELS, _META, _LAST_CHECK_AT
    now = time.time()
    if (
        not force
        and _LAST_CHECK_AT > 0
        and now - _LAST_CHECK_AT < MODEL_TTL_SECONDS
    ):
        return _MODELS, _META
    with _LOAD_LOCK:
        now = time.time()
        if (
            not force
            and _LAST_CHECK_AT > 0
            and now - _LAST_CHECK_AT < MODEL_TTL_SECONDS
        ):
            return _MODELS, _META
        try:
            loaded = _download_release()
        except Exception:
            loaded = None
        _LAST_CHECK_AT = now
        if loaded is not None:
            _MODELS, _META = loaded
        return _MODELS, _META
