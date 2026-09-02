"""OSS-hot-reloaded inference for the shadow-only opportunity model."""

import hashlib
import json
import os
import re
import time

import numpy as np

from model_lib import _ensure_lightgbm_dense_imports, _oss_bucket
from opportunity_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    SCORE_SCHEMA_VERSION,
    feature_vector,
    not_ready_prediction,
    validate_score_request,
)
from opportunity_evaluation import apply_probability_calibrator


MANIFEST_SCHEMA_VERSION = "opportunity-model-manifest.v1"
MODEL_PREFIX = os.environ.get(
    "OPPORTUNITY_MODEL_PREFIX",
    "opportunitymodel/",
)
MANIFEST_KEY = MODEL_PREFIX + "manifest.json"
MODEL_TTL_SECONDS = 3600
LOCAL_RELEASE_ROOT = "/tmp/opportunitymodel-releases"
HERE = os.path.dirname(os.path.abspath(__file__))
ARTIFACT_FILENAMES = {
    "pFill": "opportunity_fill_lgb.txt",
    "pWinGivenFill": "opportunity_win_lgb.txt",
    "expectedNetR": "opportunity_netr_lgb.txt",
    "meta": "opportunity_meta.json",
}

_MODELS = None
_META = None
_LOADED_AT = 0.0


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_opportunity_manifest(manifest):
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION
    ):
        raise ValueError("机会模型清单版本无效")
    run_id = str(manifest.get("runId") or "")
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,95}", run_id)
        or ".." in run_id
    ):
        raise ValueError("机会模型runId无效")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != set(ARTIFACT_FILENAMES):
        raise ValueError("机会模型文件清单不完整")
    expected_prefix = f"{MODEL_PREFIX.rstrip('/')}/runs/{run_id}/"
    for slot in ARTIFACT_FILENAMES:
        item = files.get(slot)
        key = str((item or {}).get("key") or "")
        checksum = str((item or {}).get("sha256") or "")
        if (
            not key.startswith(expected_prefix)
            or not key.endswith(ARTIFACT_FILENAMES[slot])
            or ".." in key
        ):
            raise ValueError("机会模型文件路径无效")
        if not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError("机会模型文件摘要无效")
    return manifest


def validate_opportunity_metadata(metadata, model_version=None):
    if (
        not isinstance(metadata, dict)
        or metadata.get("schemaVersion") != SCORE_SCHEMA_VERSION
        or metadata.get("featureSchemaVersion") != FEATURE_SCHEMA_VERSION
        or tuple(metadata.get("featureNames") or ()) != FEATURE_NAMES
        or metadata.get("shadowEligible") is not True
        or metadata.get("shadowOnly") is not True
    ):
        raise ValueError("机会模型元数据无效")
    if (
        model_version
        and str(metadata.get("modelVersion") or "") != str(model_version)
    ):
        raise ValueError("机会模型版本不一致")
    return metadata


def _read_remote_manifest(bucket):
    try:
        payload = bucket.get_object(MANIFEST_KEY).read()
    except Exception as error:
        if (
            getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            return None
        raise
    return validate_opportunity_manifest(
        json.loads(payload.decode("utf-8"))
    )


def _load_release(paths, metadata_path):
    _ensure_lightgbm_dense_imports()
    import lightgbm as lgb

    models = {
        slot: lgb.Booster(model_file=paths[slot])
        for slot in ("pFill", "pWinGivenFill", "expectedNetR")
    }
    with open(metadata_path, encoding="utf-8") as handle:
        metadata = validate_opportunity_metadata(json.load(handle))
    return models, metadata


def _download_release():
    bucket = _oss_bucket()
    if bucket is None:
        return None
    manifest = _read_remote_manifest(bucket)
    if manifest is None:
        return None
    run_id = manifest["runId"]
    release_dir = os.path.join(LOCAL_RELEASE_ROOT, run_id)
    os.makedirs(release_dir, exist_ok=True)
    final_paths = {
        slot: os.path.join(release_dir, filename)
        for slot, filename in ARTIFACT_FILENAMES.items()
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
            if _sha256(temp) != manifest["files"][slot]["sha256"]:
                raise ValueError("机会模型文件摘要不匹配")
        models, metadata = _load_release(
            {
                slot: final_paths[slot] + ".part"
                for slot in ("pFill", "pWinGivenFill", "expectedNetR")
            },
            final_paths["meta"] + ".part",
        )
        validate_opportunity_metadata(metadata, run_id)
        for destination in final_paths.values():
            os.replace(destination + ".part", destination)
        return models, metadata
    except Exception:
        for path in temporary:
            try:
                os.remove(path)
            except OSError:
                pass
        return None


def _bundled_release():
    paths = {
        slot: os.path.join(HERE, filename)
        for slot, filename in ARTIFACT_FILENAMES.items()
    }
    if not all(os.path.isfile(path) for path in paths.values()):
        return None
    try:
        return _load_release(
            {
                slot: paths[slot]
                for slot in ("pFill", "pWinGivenFill", "expectedNetR")
            },
            paths["meta"],
        )
    except Exception:
        return None


def get_opportunity_models(force=False):
    global _MODELS, _META, _LOADED_AT
    now = time.time()
    if (
        not force
        and _MODELS is not None
        and now - _LOADED_AT < MODEL_TTL_SECONDS
    ):
        return _MODELS, _META
    loaded = _download_release() or _bundled_release()
    if loaded is None:
        return None, None
    _MODELS, _META = loaded
    _LOADED_AT = now
    return _MODELS, _META


def _model_prediction(model, matrix):
    values = np.asarray(model.predict(matrix), dtype=np.float64)
    if values.shape != (len(matrix),) or not np.isfinite(values).all():
        raise ValueError("机会模型预测无效")
    return values


def _is_out_of_distribution(vector, metadata):
    config = (metadata or {}).get("ood") or {}
    minimum = np.asarray(config.get("minimum"), dtype=np.float64)
    maximum = np.asarray(config.get("maximum"), dtype=np.float64)
    values = np.asarray(vector, dtype=np.float64)
    if (
        minimum.shape != values.shape
        or maximum.shape != values.shape
        or not np.isfinite(minimum).all()
        or not np.isfinite(maximum).all()
    ):
        return True
    span = np.maximum(maximum - minimum, 1e-6)
    tolerance = span * 0.05
    violations = (
        (values < minimum - tolerance)
        | (values > maximum + tolerance)
    )
    limit = float(config.get("maximumViolationFraction", 0.1))
    return float(violations.mean()) > max(0.0, min(1.0, limit))


def _selected_category(item, prefix):
    factors = item["factors"]
    candidates = [
        name[len(prefix) + 1:]
        for name in FEATURE_NAMES
        if name.startswith(prefix + "_")
        and factors[name] >= 0.5
    ]
    return candidates[0] if candidates else "UNKNOWN"


def _calibration_bucket(item):
    return ":".join([
        _selected_category(item, "market"),
        _selected_category(item, "sector"),
        _selected_category(item, "time"),
    ])


def predict_opportunity_items(
    payload,
    *,
    models=None,
    metadata=None,
):
    items = validate_score_request(payload)
    if models is None or metadata is None:
        models, metadata = get_opportunity_models()
    if not models or metadata is None:
        return [
            not_ready_prediction(item, "MODEL_NOT_READY")
            for item in items
        ]
    try:
        metadata = validate_opportunity_metadata(metadata)
        matrix = np.asarray(
            [feature_vector(item) for item in items],
            dtype=np.float32,
        )
        raw_fill = np.clip(
            _model_prediction(models["pFill"], matrix),
            1e-8,
            1 - 1e-8,
        )
        raw_win = np.clip(
            _model_prediction(models["pWinGivenFill"], matrix),
            1e-8,
            1 - 1e-8,
        )
        expected_net_r = _model_prediction(
            models["expectedNetR"],
            matrix,
        )
        calibration = metadata["calibration"]
        p_fill = apply_probability_calibrator(
            raw_fill,
            calibration["pFill"],
        )
        p_win = apply_probability_calibrator(
            raw_win,
            calibration["pWinGivenFill"],
        )
    except Exception:
        return [
            not_ready_prediction(item, "MODEL_INVALID")
            for item in items
        ]

    risk = metadata.get("risk") or {}
    residual_lower = float(risk.get("netRResidualLower10", 0.0))
    expected_shortfall = float(risk.get("expectedShortfall10", 0.0))
    calibration_samples = min(
        int(calibration.get("pFillSampleCount", 0)),
        int(calibration.get("pWinGivenFillSampleCount", 0)),
    )
    predictions = []
    for index, item in enumerate(items):
        if _is_out_of_distribution(matrix[index], metadata):
            prediction = not_ready_prediction(
                item,
                "OUT_OF_DISTRIBUTION",
            )
            prediction["state"] = "OUT_OF_DISTRIBUTION"
            prediction["modelVersion"] = metadata["modelVersion"]
            prediction["outOfDistribution"] = True
            predictions.append(prediction)
            continue
        predictions.append({
            "schemaVersion": SCORE_SCHEMA_VERSION,
            "state": "READY",
            "reason": None,
            "modelVersion": metadata["modelVersion"],
            "asOf": item["asOf"],
            "code": item["code"],
            "formulaId": item["formulaId"],
            "pFill": round(float(p_fill[index]), 6),
            "pWinGivenFill": round(float(p_win[index]), 6),
            "expectedNetR": round(float(expected_net_r[index]), 6),
            "netRLowerBound": round(
                float(expected_net_r[index] + residual_lower),
                6,
            ),
            "expectedShortfall10": round(expected_shortfall, 6),
            "calibration": {
                "method": (
                    f"{calibration['pFill']['method']}"
                    f"+{calibration['pWinGivenFill']['method']}"
                ),
                "sampleCount": calibration_samples,
                "bucket": _calibration_bucket(item),
            },
            "outOfDistribution": False,
            "shadowOnly": True,
        })
    return predictions
