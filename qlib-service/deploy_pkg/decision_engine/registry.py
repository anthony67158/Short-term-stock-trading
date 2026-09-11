"""Versioned model registry for the modular decision engine."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time

import numpy as np

from model_lib import _ensure_lightgbm_dense_imports, _oss_bucket

from .contracts import (
    SCORE_SCHEMA_VERSION,
    feature_names_for_schema,
)


DECISION_MANIFEST_SCHEMA_VERSION = "decision-model-manifest.v1"
LEGACY_MANIFEST_SCHEMA_VERSION = "opportunity-model-manifest.v1"
MODEL_PREFIX = os.environ.get(
    "DECISION_MODEL_PREFIX",
    "opportunitymodel/",
)
MANIFEST_KEY = MODEL_PREFIX + "manifest.json"
MODEL_TTL_SECONDS = 60
LOCAL_RELEASE_ROOT = "/tmp/decision-model-releases"
SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LEGACY_PREDICTION_CONTRACT_VERSION = "opportunity-three-head.v1"
PREDICTION_CONTRACT_VERSION = "opportunity-hurdle-q10.v1"
ENSEMBLE_PREDICTION_CONTRACT_VERSION = "opportunity-seed-ensemble.v1"

LEGACY_ARTIFACT_FILENAMES = {
    "pFill": "opportunity_fill_lgb.txt",
    "pWinGivenFill": "opportunity_win_lgb.txt",
    "expectedNetR": "opportunity_netr_lgb.txt",
    "meta": "opportunity_meta.json",
}
ARTIFACT_FILENAMES = {
    "pFill": "opportunity_fill_lgb.txt",
    "pWinGivenFill": "opportunity_win_lgb.txt",
    "winPayoffR": "opportunity_win_payoff_lgb.txt",
    "lossPayoffR": "opportunity_loss_payoff_lgb.txt",
    "netRLower10": "opportunity_q10_lgb.txt",
    "ranking": "opportunity_ranker_catboost.json",
    "meta": "opportunity_meta.json",
}
ENSEMBLE_ARTIFACT_FILENAMES = {
    "ensemble": "opportunity_seed_ensemble.json",
    "meta": "opportunity_meta.json",
}

_MODELS = None
_META = None
_LAST_CHECK_AT = 0.0
_LOAD_LOCK = threading.Lock()


class CatBoostJsonRanker:
    def __init__(self, path=None, *, payload=None):
        if payload is None:
            with open(path, encoding="utf-8") as handle:
                payload = json.load(handle)
        trees = payload.get("oblivious_trees")
        if not isinstance(trees, list) or not trees:
            raise ValueError("CatBoost排序模型结构无效")
        self.trees = trees
        scale_and_bias = payload.get("scale_and_bias") or [1.0, [0.0]]
        self.scale = float(scale_and_bias[0])
        bias = scale_and_bias[1]
        self.bias = float(bias[0] if isinstance(bias, list) else bias)

    def predict(self, matrix):
        values = np.asarray(matrix, dtype=np.float64)
        if values.ndim != 2:
            raise ValueError("CatBoost排序输入维度无效")
        result = np.zeros(len(values), dtype=np.float64)
        for tree in self.trees:
            splits = tree.get("splits") or []
            leaves = np.asarray(
                tree.get("leaf_values"),
                dtype=np.float64,
            )
            if len(leaves) != 2 ** len(splits):
                raise ValueError("CatBoost排序树叶子数量无效")
            leaf_index = np.zeros(len(values), dtype=np.int64)
            for depth, split in enumerate(splits):
                if split.get("split_type") != "FloatFeature":
                    raise ValueError("CatBoost排序模型包含非数值切分")
                feature = int(split.get("float_feature_index"))
                if not 0 <= feature < values.shape[1]:
                    raise ValueError("CatBoost排序特征索引无效")
                leaf_index |= (
                    values[:, feature] > float(split.get("border"))
                ).astype(np.int64) << depth
            result += leaves[leaf_index]
        return result * self.scale + self.bias


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_decision_manifest(manifest):
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") not in {
            DECISION_MANIFEST_SCHEMA_VERSION,
            LEGACY_MANIFEST_SCHEMA_VERSION,
        }
    ):
        raise ValueError("决策模型清单版本无效")
    run_id = str(manifest.get("runId") or "")
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,95}", run_id)
        or ".." in run_id
    ):
        raise ValueError("决策模型runId无效")
    files = manifest.get("files")
    layouts = (
        ENSEMBLE_ARTIFACT_FILENAMES,
        ARTIFACT_FILENAMES,
        LEGACY_ARTIFACT_FILENAMES,
    )
    layout = next(
        (
            candidate
            for candidate in layouts
            if isinstance(files, dict)
            and set(files) == set(candidate)
        ),
        None,
    )
    if layout is None:
        raise ValueError("决策模型文件清单不完整")
    expected_prefix = f"{MODEL_PREFIX.rstrip('/')}/runs/{run_id}/"
    for slot, filename in layout.items():
        item = files.get(slot)
        key = str((item or {}).get("key") or "")
        checksum = str((item or {}).get("sha256") or "")
        if (
            not key.startswith(expected_prefix)
            or not key.endswith(filename)
            or ".." in key
        ):
            raise ValueError("决策模型文件路径无效")
        if not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError("决策模型文件摘要无效")
    return {
        **manifest,
        "schemaVersion": DECISION_MANIFEST_SCHEMA_VERSION,
        "sourceSchemaVersion": manifest.get("schemaVersion"),
    }


def artifact_filenames_for_metadata(metadata):
    contract = str(
        (metadata or {}).get("predictionContract")
        or LEGACY_PREDICTION_CONTRACT_VERSION
    )
    if contract == LEGACY_PREDICTION_CONTRACT_VERSION:
        return LEGACY_ARTIFACT_FILENAMES
    if contract == PREDICTION_CONTRACT_VERSION:
        return ARTIFACT_FILENAMES
    if contract == ENSEMBLE_PREDICTION_CONTRACT_VERSION:
        return ENSEMBLE_ARTIFACT_FILENAMES
    raise ValueError("决策模型预测合同无效")


def validate_decision_metadata(metadata, model_version=None):
    feature_schema_version = (
        metadata.get("featureSchemaVersion")
        if isinstance(metadata, dict)
        else None
    )
    try:
        expected_names = feature_names_for_schema(feature_schema_version)
    except ValueError as error:
        raise ValueError("决策模型元数据无效") from error
    if (
        not isinstance(metadata, dict)
        or metadata.get("schemaVersion") != SCORE_SCHEMA_VERSION
        or tuple(metadata.get("featureNames") or ()) != expected_names
        or not str(metadata.get("modelVersion") or "")
    ):
        raise ValueError("决策模型元数据无效")
    layout = artifact_filenames_for_metadata(metadata)
    model_heads = metadata.get("modelHeads")
    if (
        model_heads is not None
        and tuple(model_heads) != tuple(
            slot for slot in layout if slot != "meta"
        )
    ):
        raise ValueError("决策模型头合同无效")
    if (
        feature_schema_version
        and metadata.get("predictionContract")
        == ENSEMBLE_PREDICTION_CONTRACT_VERSION
    ):
        members = metadata.get("ensembleMembers")
        size = int(metadata.get("ensembleSize") or 0)
        seeds = [
            int(member.get("seed") or 0)
            for member in members
        ] if isinstance(members, list) else []
        if (
            not 2 <= size <= 5
            or not isinstance(members, list)
            or len(members) != size
            or len(set(seeds)) != size
            or any(seed <= 0 for seed in seeds)
            or any(
                not isinstance(member, dict)
                or not isinstance(member.get("calibration"), dict)
                or not isinstance(
                    member.get("rankingCalibration"),
                    dict,
                )
                or not isinstance(
                    member.get("rankValueCalibration"),
                    dict,
                )
                for member in members
            )
        ):
            raise ValueError("决策模型集成元数据无效")
    if (
        model_version
        and str(metadata.get("modelVersion") or "")
        != str(model_version)
    ):
        raise ValueError("决策模型版本不一致")
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
    return validate_decision_manifest(
        json.loads(payload.decode("utf-8"))
    )


def load_release(paths, metadata_path):
    _ensure_lightgbm_dense_imports()
    import lightgbm as lgb

    with open(metadata_path, encoding="utf-8") as handle:
        metadata = validate_decision_metadata(json.load(handle))
    layout = artifact_filenames_for_metadata(metadata)
    model_slots = tuple(slot for slot in layout if slot != "meta")
    if set(paths) != set(model_slots):
        raise ValueError("决策模型加载文件与预测合同不一致")
    if (
        metadata.get("predictionContract")
        == ENSEMBLE_PREDICTION_CONTRACT_VERSION
    ):
        with open(paths["ensemble"], encoding="utf-8") as handle:
            payload = json.load(handle)
        members = payload.get("members")
        if (
            payload.get("schemaVersion")
            != "opportunity-seed-ensemble-artifact.v1"
            or payload.get("featureSchemaVersion")
            != metadata.get("featureSchemaVersion")
            or not isinstance(members, list)
            or len(members) != metadata["ensembleSize"]
        ):
            raise ValueError("决策模型集成文件无效")
        required = {
            "pFill",
            "pWinGivenFill",
            "winPayoffR",
            "lossPayoffR",
            "netRLower10",
            "ranking",
        }
        loaded = []
        for index, member in enumerate(members):
            models = member.get("models") or {}
            if (
                set(models) != required
                or int(member.get("seed"))
                != int(metadata["ensembleMembers"][index].get("seed"))
            ):
                raise ValueError("决策模型集成成员不完整")
            loaded.append({
                slot: (
                    CatBoostJsonRanker(payload=models[slot])
                    if slot == "ranking"
                    else lgb.Booster(model_str=models[slot])
                )
                for slot in required
            })
        return {"ensemble": loaded}, metadata
    models = {}
    for slot in model_slots:
        if slot == "ranking":
            models[slot] = CatBoostJsonRanker(paths[slot])
        else:
            models[slot] = lgb.Booster(model_file=paths[slot])
    return models, metadata


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
    layout = next(
        value
        for value in (
            ENSEMBLE_ARTIFACT_FILENAMES,
            ARTIFACT_FILENAMES,
            LEGACY_ARTIFACT_FILENAMES,
        )
        if set(manifest["files"]) == set(value)
    )
    final_paths = {
        slot: os.path.join(release_dir, filename)
        for slot, filename in layout.items()
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
                raise ValueError("决策模型文件摘要不匹配")
        models, metadata = load_release(
            {
                slot: final_paths[slot] + ".part"
                for slot in layout
                if slot != "meta"
            },
            final_paths["meta"] + ".part",
        )
        validate_decision_metadata(metadata, run_id)
        metadata = {
            **metadata,
            "usagePolicy": manifest.get(
                "usagePolicy",
                metadata.get("usagePolicy"),
            ),
            "shadowOnly": manifest.get(
                "shadowOnly",
                metadata.get("shadowOnly", True),
            ),
            "productionEligible": manifest.get(
                "productionEligible",
                metadata.get("productionEligible", False),
            ),
            "baselineSelected": manifest.get(
                "baselineSelected",
                False,
            ),
            "manifestSchemaVersion":
                DECISION_MANIFEST_SCHEMA_VERSION,
        }
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
    for layout in (
        ENSEMBLE_ARTIFACT_FILENAMES,
        ARTIFACT_FILENAMES,
        LEGACY_ARTIFACT_FILENAMES,
    ):
        paths = {
            slot: os.path.join(SERVICE_ROOT, filename)
            for slot, filename in layout.items()
        }
        if not all(os.path.isfile(path) for path in paths.values()):
            continue
        try:
            return load_release(
                {
                    slot: paths[slot]
                    for slot in layout
                    if slot != "meta"
                },
                paths["meta"],
            )
        except Exception:
            continue
    return None


def get_decision_models(force=False):
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
        loaded = loaded or _bundled_release()
        _LAST_CHECK_AT = now
        if loaded is not None:
            _MODELS, _META = loaded
        return _MODELS, _META
