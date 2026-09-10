"""OSS-hot-reloaded inference for the opportunity action-value model."""

import hashlib
import json
import os
import re
import threading
import time

import numpy as np

from model_lib import _ensure_lightgbm_dense_imports, _oss_bucket
from opportunity_contract import (
    FEATURE_NAMES,
    SCORE_SCHEMA_VERSION,
    feature_vector,
    feature_names_for_schema,
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
MODEL_TTL_SECONDS = 60
LOCAL_RELEASE_ROOT = "/tmp/opportunitymodel-releases"
HERE = os.path.dirname(os.path.abspath(__file__))
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


class _CatBoostJsonRanker:
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
        raise ValueError("机会模型文件清单不完整")
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
            raise ValueError("机会模型文件路径无效")
        if not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError("机会模型文件摘要无效")
    return manifest


def artifact_filenames_for_metadata(metadata):
    contract = str(
        (metadata or {}).get("predictionContract") or
        LEGACY_PREDICTION_CONTRACT_VERSION
    )
    if contract == LEGACY_PREDICTION_CONTRACT_VERSION:
        return LEGACY_ARTIFACT_FILENAMES
    if contract == PREDICTION_CONTRACT_VERSION:
        return ARTIFACT_FILENAMES
    if contract == ENSEMBLE_PREDICTION_CONTRACT_VERSION:
        return ENSEMBLE_ARTIFACT_FILENAMES
    raise ValueError("机会模型预测合同无效")


def validate_opportunity_metadata(metadata, model_version=None):
    feature_schema_version = (
        metadata.get("featureSchemaVersion")
        if isinstance(metadata, dict)
        else None
    )
    try:
        expected_names = feature_names_for_schema(feature_schema_version)
    except ValueError as error:
        raise ValueError("机会模型元数据无效") from error
    if (
        not isinstance(metadata, dict)
        or metadata.get("schemaVersion") != SCORE_SCHEMA_VERSION
        or tuple(metadata.get("featureNames") or ()) != expected_names
        or not str(metadata.get("modelVersion") or "")
    ):
        raise ValueError("机会模型元数据无效")
    layout = artifact_filenames_for_metadata(metadata)
    model_heads = metadata.get("modelHeads")
    if (
        model_heads is not None
        and tuple(model_heads) != tuple(
            slot for slot in layout if slot != "meta"
        )
    ):
        raise ValueError("机会模型头合同无效")
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
                or not isinstance(member.get("rankingCalibration"), dict)
                or not isinstance(member.get("rankValueCalibration"), dict)
                for member in members
            )
        ):
            raise ValueError("机会模型集成元数据无效")
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

    with open(metadata_path, encoding="utf-8") as handle:
        metadata = validate_opportunity_metadata(json.load(handle))
    layout = artifact_filenames_for_metadata(metadata)
    model_slots = tuple(slot for slot in layout if slot != "meta")
    if set(paths) != set(model_slots):
        raise ValueError("机会模型加载文件与预测合同不一致")
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
            raise ValueError("机会模型集成文件无效")
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
                raise ValueError("机会模型集成成员不完整")
            loaded.append({
                slot: (
                    _CatBoostJsonRanker(payload=models[slot])
                    if slot == "ranking"
                    else lgb.Booster(model_str=models[slot])
                )
                for slot in required
            })
        return {"ensemble": loaded}, metadata
    models = {}
    for slot in model_slots:
        if slot == "ranking":
            models[slot] = _CatBoostJsonRanker(paths[slot])
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
            if _sha256(temp) != manifest["files"][slot]["sha256"]:
                raise ValueError("机会模型文件摘要不匹配")
        models, metadata = _load_release(
            {
                slot: final_paths[slot] + ".part"
                for slot in layout
                if slot != "meta"
            },
            final_paths["meta"] + ".part",
        )
        validate_opportunity_metadata(metadata, run_id)
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
            slot: os.path.join(HERE, filename)
            for slot, filename in layout.items()
        }
        if not all(os.path.isfile(path) for path in paths.values()):
            continue
        try:
            return _load_release(
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


def get_opportunity_models(force=False):
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


def _model_prediction(model, matrix):
    values = np.asarray(model.predict(matrix), dtype=np.float64)
    if values.shape != (len(matrix),) or not np.isfinite(values).all():
        raise ValueError("机会模型预测无效")
    return values


def _empirical_percentile(values, artifact):
    knots = np.asarray((artifact or {}).get("scoreQuantiles"), dtype=np.float64)
    if (
        knots.ndim != 1
        or len(knots) < 2
        or not np.isfinite(knots).all()
        or np.any(np.diff(knots) < 0)
    ):
        raise ValueError("机会排序分校准参数无效")
    percentiles = np.linspace(0.0, 1.0, len(knots))
    return np.clip(np.interp(values, knots, percentiles), 0, 1)


def _rank_expected_net_r(values, artifact):
    scores = np.asarray((artifact or {}).get("score"), dtype=np.float64)
    expected = np.asarray(
        (artifact or {}).get("expectedNetR"),
        dtype=np.float64,
    )
    if (
        scores.ndim != 1
        or expected.shape != scores.shape
        or len(scores) < 2
        or not np.isfinite(scores).all()
        or not np.isfinite(expected).all()
        or np.any(np.diff(scores) < 0)
    ):
        raise ValueError("机会排序价值校准参数无效")
    return np.interp(values, scores, expected)


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
    feature_names = tuple(metadata.get("featureNames") or ())
    for index, name in enumerate(feature_names):
        if (
            name.endswith("_UNKNOWN")
            and values[index] >= 0.5
            and maximum[index] < 0.5
        ):
            return True
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


def _ensemble_prediction_arrays(models, metadata, matrix):
    members = models.get("ensemble")
    configs = metadata.get("ensembleMembers")
    if (
        not isinstance(members, list)
        or not isinstance(configs, list)
        or len(members) != len(configs)
        or not members
    ):
        raise ValueError("机会模型集成成员不匹配")
    fill_values = []
    win_values = []
    action_values = []
    q10_values = []
    rank_values = []
    rank_percentiles = []
    for member, config in zip(members, configs):
        calibration = config["calibration"]
        p_fill = apply_probability_calibrator(
            np.clip(
                _model_prediction(member["pFill"], matrix),
                1e-8,
                1 - 1e-8,
            ),
            calibration["pFill"],
        )
        p_win = apply_probability_calibrator(
            np.clip(
                _model_prediction(member["pWinGivenFill"], matrix),
                1e-8,
                1 - 1e-8,
            ),
            calibration["pWinGivenFill"],
        )
        win_payoff = np.maximum(
            0,
            _model_prediction(member["winPayoffR"], matrix),
        )
        loss_payoff = np.minimum(
            0,
            _model_prediction(member["lossPayoffR"], matrix),
        )
        ranking_raw = _model_prediction(member["ranking"], matrix)
        fill_values.append(p_fill)
        win_values.append(p_win)
        action_values.append(
            p_win * win_payoff + (1 - p_win) * loss_payoff
        )
        q10_values.append(
            _model_prediction(member["netRLower10"], matrix)
            + float(config.get("q10CalibrationOffset", 0.0))
        )
        rank_values.append(_rank_expected_net_r(
            ranking_raw,
            config["rankValueCalibration"],
        ))
        rank_percentiles.append(_empirical_percentile(
            ranking_raw,
            config["rankingCalibration"],
        ))
    action_value = np.mean(action_values, axis=0)
    rank_value = np.mean(rank_values, axis=0)
    blend_weight = max(0.0, min(
        1.0,
        float(metadata.get("rankBlendWeight", 0.0)),
    ))
    expected_net_r = (
        (1 - blend_weight) * action_value
        + blend_weight * rank_value
    )
    return {
        "pFill": np.mean(fill_values, axis=0),
        "pWinGivenFill": np.mean(win_values, axis=0),
        "expectedNetR": expected_net_r,
        "netRLowerBound": np.minimum(
            np.mean(q10_values, axis=0),
            expected_net_r,
        ),
        "rankingScore": np.mean(rank_percentiles, axis=0),
    }


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
            not_ready_prediction(item, "MODEL_FILES_MISSING")
            for item in items
        ]
    try:
        metadata = validate_opportunity_metadata(metadata)
        model_feature_names = tuple(metadata["featureNames"])
        matrix = np.asarray(
            [
                feature_vector(item, model_feature_names)
                for item in items
            ],
            dtype=np.float32,
        )
        calibration = metadata["calibration"]
        prediction_contract = str(
            metadata.get("predictionContract")
            or LEGACY_PREDICTION_CONTRACT_VERSION
        )
        if (
            prediction_contract
            == ENSEMBLE_PREDICTION_CONTRACT_VERSION
        ):
            ensemble = _ensemble_prediction_arrays(
                models,
                metadata,
                matrix,
            )
            p_fill = ensemble["pFill"]
            p_win = ensemble["pWinGivenFill"]
            expected_net_r = ensemble["expectedNetR"]
            net_r_lower_bound = ensemble["netRLowerBound"]
            ranking_score = ensemble["rankingScore"]
        else:
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
            p_fill = apply_probability_calibrator(
                raw_fill,
                calibration["pFill"],
            )
            p_win = apply_probability_calibrator(
                raw_win,
                calibration["pWinGivenFill"],
            )
            if prediction_contract == PREDICTION_CONTRACT_VERSION:
                win_payoff = np.maximum(
                    0,
                    _model_prediction(models["winPayoffR"], matrix),
                )
                loss_payoff = np.minimum(
                    0,
                    _model_prediction(models["lossPayoffR"], matrix),
                )
                action_value = (
                    p_win * win_payoff
                    + (1 - p_win) * loss_payoff
                )
                ranking_raw = _model_prediction(
                    models["ranking"],
                    matrix,
                )
                rank_value = _rank_expected_net_r(
                    ranking_raw,
                    metadata.get("rankValueCalibration"),
                )
                blend_weight = max(0.0, min(
                    1.0,
                    float(metadata.get("rankBlendWeight", 0.0)),
                ))
                expected_net_r = (
                    (1 - blend_weight) * action_value
                    + blend_weight * rank_value
                )
                q10_offset = float(
                    (metadata.get("risk") or {}).get(
                        "q10CalibrationOffset",
                        0.0,
                    )
                )
                net_r_lower_bound = np.minimum(
                    _model_prediction(models["netRLower10"], matrix)
                    + q10_offset,
                    expected_net_r,
                )
                ranking_score = _empirical_percentile(
                    ranking_raw,
                    metadata.get("rankingCalibration"),
                )
            else:
                expected_net_r = _model_prediction(
                    models["expectedNetR"],
                    matrix,
                )
                residual_lower = float(
                    (metadata.get("risk") or {}).get(
                        "netRResidualLower10",
                        0.0,
                    )
                )
                net_r_lower_bound = expected_net_r + residual_lower
                ranking_score = np.full(len(matrix), np.nan)
    except Exception:
        return [
            not_ready_prediction(item, "MODEL_INVALID")
            for item in items
        ]

    risk = metadata.get("risk") or {}
    expected_shortfall = float(risk.get("expectedShortfall10", 0.0))
    calibration_samples = min(
        int(calibration.get("pFillSampleCount", 0)),
        int(calibration.get("pWinGivenFillSampleCount", 0)),
    )
    predictions = []
    for index, item in enumerate(items):
        out_of_distribution = _is_out_of_distribution(matrix[index], metadata)
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
                float(net_r_lower_bound[index]),
                6,
            ),
            "expectedShortfall10": round(expected_shortfall, 6),
            "rankingScore": (
                round(float(ranking_score[index]), 6)
                if np.isfinite(ranking_score[index])
                else None
            ),
            "calibration": {
                "method": (
                    f"{calibration['pFill']['method']}"
                    f"+{calibration['pWinGivenFill']['method']}"
                ),
                "sampleCount": calibration_samples,
                "bucket": _calibration_bucket(item),
            },
            "usagePolicy": "DIRECT",
            "outOfDistribution": out_of_distribution,
            "shadowOnly": metadata.get("shadowOnly", True),
            "baselineSelected": metadata.get(
                "baselineSelected",
                False,
            ),
            "productionEligible": metadata.get(
                "productionEligible",
                False,
            ),
        })
    return predictions
