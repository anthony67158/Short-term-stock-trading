"""Common hurdle-model interface for action-value tree candidates."""

from dataclasses import dataclass
from typing import Any

import numpy as np
from lightgbm import LGBMClassifier, LGBMRanker, LGBMRegressor
from scipy.stats import rankdata
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

from platform_app.modules.experiments.action_value_training import (
    ActionValueTrainingData,
    scenario_weights,
)
from platform_app.modules.experiments.quant_model_trainer import RANDOM_STATE

ACTION_VALUE_FAMILIES = ("hgb", "lightgbm", "catboost")
SCENARIO_FEATURE_SUFFIX = (
    "logTargetNotionalCny",
    "logTargetShares",
    "logTargetToMedianAmount",
)
BASE_FEATURE_TARGETS = {"pAnyFill", "stopHazardGivenFill"}
MODEL_TARGETS = (
    "pAnyFill",
    "fillFractionGivenFill",
    "pFullFillGivenFill",
    "pWinGivenFill",
    "stopHazardGivenFill",
    "expectedNetReturnGivenFill",
    "expectedNetReturnOnRequestedNotional",
    "q10",
    "q50",
    "q90",
)


class ActionValueModelError(ValueError):
    pass


@dataclass(frozen=True)
class AveragedProbabilityModel:
    models: tuple[Any, ...]

    def predict_proba(self, features) -> np.ndarray:
        probabilities = np.stack(
            [model.predict_proba(features) for model in self.models],
            axis=0,
        )
        return np.mean(probabilities, axis=0)


@dataclass(frozen=True)
class ActionValueCandidate:
    family: str
    feature_names: tuple[str, ...]
    base_feature_count: int
    model_families: dict[str, str]
    models: dict[str, Any]
    probability_ensemble_families: tuple[str, ...] = ()

    def predict(self, features) -> dict[str, np.ndarray]:
        x = np.asarray(features, dtype=np.float32)
        if (
            x.ndim != 2
            or x.shape[1] != len(self.feature_names)
            or not np.all(np.isfinite(x))
        ):
            raise ActionValueModelError("ACTION_VALUE_FEATURE_CONTRACT_MISMATCH")

        def model_features(name):
            return x[:, : self.base_feature_count] if name in BASE_FEATURE_TARGETS else x

        def probability(name):
            return np.clip(
                np.asarray(
                    self.models[name].predict_proba(model_features(name))[:, 1],
                    dtype=np.float64,
                ),
                0,
                1,
            )

        p_any = probability("pAnyFill")
        fill_given = np.clip(
            np.asarray(self.models["fillFractionGivenFill"].predict(x), dtype=np.float64),
            0,
            1,
        )
        p_full_given = probability("pFullFillGivenFill")
        expected_given_fill = np.asarray(
            self.models["expectedNetReturnGivenFill"].predict(x),
            dtype=np.float64,
        )
        result = {
            "pAnyFill": p_any,
            "fillFractionGivenFill": fill_given,
            "expectedFillFraction": p_any * fill_given,
            "pFullFillGivenFill": p_full_given,
            "pFullFill": p_any * p_full_given,
            "pWinGivenFill": probability("pWinGivenFill"),
            "stopHazardGivenFill": probability("stopHazardGivenFill"),
            "expectedNetReturnGivenFill": expected_given_fill,
            "expectedNetReturnOnRequestedNotional": np.asarray(
                self.models["expectedNetReturnOnRequestedNotional"].predict(x),
                dtype=np.float64,
            ),
            "hurdleExpectedNetReturnOnRequestedNotional": (
                p_any * fill_given * expected_given_fill
            ),
        }
        selection_model = self.models.get("selectionScore")
        result["selectionScore"] = (
            np.asarray(selection_model.predict(x), dtype=np.float64)
            if selection_model is not None
            else result["hurdleExpectedNetReturnOnRequestedNotional"].copy()
        )
        quantiles = np.sort(
            np.column_stack(
                [
                    np.asarray(self.models[name].predict(x), dtype=np.float64)
                    for name in ("q10", "q50", "q90")
                ]
            ),
            axis=1,
        )
        result.update({
            "q10GivenFill": quantiles[:, 0],
            "q50GivenFill": quantiles[:, 1],
            "q90GivenFill": quantiles[:, 2],
        })
        if any(values.shape != (len(x),) for values in result.values()):
            raise ActionValueModelError("ACTION_VALUE_PREDICTION_SHAPE_INVALID")
        if any(not np.all(np.isfinite(values)) for values in result.values()):
            raise ActionValueModelError("ACTION_VALUE_PREDICTION_NON_FINITE")
        return result


def _fit_classifier(family, x, y, weights, *, iterations, min_samples_leaf, threads):
    if len(np.unique(y)) != 2:
        raise ActionValueModelError("ACTION_VALUE_CLASS_SUPPORT_INSUFFICIENT")
    if family == "hgb":
        model = HistGradientBoostingClassifier(
            learning_rate=0.05,
            max_iter=iterations,
            max_leaf_nodes=31,
            min_samples_leaf=min_samples_leaf,
            l2_regularization=1.0,
            early_stopping=False,
            random_state=RANDOM_STATE,
        )
    elif family == "lightgbm":
        model = LGBMClassifier(
            objective="binary",
            n_estimators=iterations,
            learning_rate=0.05,
            num_leaves=31,
            max_depth=6,
            min_child_samples=min_samples_leaf,
            reg_lambda=1.0,
            random_state=RANDOM_STATE,
            n_jobs=threads,
            verbosity=-1,
            deterministic=True,
            force_col_wise=True,
        )
    else:
        from catboost import CatBoostClassifier

        model = CatBoostClassifier(
            loss_function="Logloss",
            iterations=iterations,
            learning_rate=0.05,
            depth=6,
            l2_leaf_reg=3.0,
            random_seed=RANDOM_STATE,
            random_strength=0.0,
            bootstrap_type="No",
            thread_count=threads,
            allow_writing_files=False,
            verbose=False,
        )
    return model.fit(x, y, sample_weight=weights)


def _fit_regressor(
    family,
    x,
    y,
    weights,
    *,
    iterations,
    min_samples_leaf,
    threads,
    robust=False,
    quantile=None,
):
    if family == "hgb":
        loss = "quantile" if quantile is not None else (
            "absolute_error" if robust else "squared_error"
        )
        model = HistGradientBoostingRegressor(
            loss=loss,
            quantile=quantile,
            learning_rate=0.05,
            max_iter=iterations,
            max_leaf_nodes=31,
            min_samples_leaf=min_samples_leaf,
            l2_regularization=1.0,
            early_stopping=False,
            random_state=RANDOM_STATE,
        )
    elif family == "lightgbm":
        objective = "quantile" if quantile is not None else (
            "huber" if robust else "regression"
        )
        model = LGBMRegressor(
            objective=objective,
            alpha=quantile if quantile is not None else 0.9,
            n_estimators=iterations,
            learning_rate=0.05,
            num_leaves=31,
            max_depth=6,
            min_child_samples=min_samples_leaf,
            reg_lambda=1.0,
            random_state=RANDOM_STATE,
            n_jobs=threads,
            verbosity=-1,
            deterministic=True,
            force_col_wise=True,
        )
    else:
        from catboost import CatBoostRegressor

        loss = (
            f"Quantile:alpha={quantile}"
            if quantile is not None
            else ("MAE" if robust else "RMSE")
        )
        model = CatBoostRegressor(
            loss_function=loss,
            iterations=iterations,
            learning_rate=0.05,
            depth=6,
            l2_leaf_reg=3.0,
            random_seed=RANDOM_STATE,
            random_strength=0.0,
            bootstrap_type="No",
            thread_count=threads,
            allow_writing_files=False,
            verbose=False,
        )
    return model.fit(x, y, sample_weight=weights)


def _fit_selection_ranker(
    x,
    target,
    dates,
    weights,
    *,
    iterations,
    min_samples_leaf,
    threads,
):
    order = np.argsort(dates, kind="stable")
    ordered_dates = dates[order]
    ordered_target = target[order]
    relevance = np.empty(len(order), dtype=np.int32)
    for date in np.unique(ordered_dates):
        local = ordered_dates == date
        count = int(local.sum())
        percentiles = (
            (rankdata(ordered_target[local], method="average") - 1)
            / max(count - 1, 1)
        )
        relevance[local] = np.minimum((percentiles * 5).astype(np.int32), 4)
    _, groups = np.unique(ordered_dates, return_counts=True)
    model = LGBMRanker(
        objective="lambdarank",
        n_estimators=iterations,
        learning_rate=0.05,
        num_leaves=31,
        max_depth=6,
        min_child_samples=min_samples_leaf,
        reg_lambda=1.0,
        label_gain=list(range(5)),
        random_state=RANDOM_STATE,
        n_jobs=threads,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )
    return model.fit(
        x[order],
        relevance,
        group=groups,
        sample_weight=weights[order],
    )


def fit_action_value_candidate(
    data: ActionValueTrainingData,
    train_mask,
    *,
    family: str,
    model_families: dict[str, str] | None = None,
    fit_selection_ranker: bool = False,
    iterations: int = 120,
    min_samples_leaf: int = 100,
    threads: int = 2,
) -> ActionValueCandidate:
    families = {name: family for name in MODEL_TARGETS}
    if model_families is not None:
        families.update(model_families)
    if (
        family not in ACTION_VALUE_FAMILIES
        or set(families) != set(MODEL_TARGETS)
        or any(name not in ACTION_VALUE_FAMILIES for name in families.values())
    ):
        raise ActionValueModelError("ACTION_VALUE_MODEL_FAMILY_UNSUPPORTED")
    train = np.asarray(train_mask, dtype=bool)
    if (
        train.shape != (len(data.features),)
        or not np.any(train)
        or iterations <= 0
        or min_samples_leaf <= 0
        or threads <= 0
    ):
        raise ActionValueModelError("ACTION_VALUE_TRAINING_CONFIG_INVALID")
    conditional = train & data.conditional_available
    if not np.any(conditional):
        raise ActionValueModelError("ACTION_VALUE_CONDITIONAL_SUPPORT_INSUFFICIENT")
    base_feature_count = len(data.feature_names)
    if data.feature_names[-len(SCENARIO_FEATURE_SUFFIX) :] == SCENARIO_FEATURE_SUFFIX:
        base_feature_count -= len(SCENARIO_FEATURE_SUFFIX)

    def weights(mask):
        selected = scenario_weights(data.dates[mask], data.episodes[mask])
        return selected / selected.mean()

    classifier_targets = {
        "pAnyFill": (data.p_any_fill, train),
        "pFullFillGivenFill": (data.p_full_fill, conditional),
        "pWinGivenFill": (data.p_win_given_fill, conditional),
        "stopHazardGivenFill": (data.stop_hazard_given_fill, conditional),
    }
    models = {
        name: _fit_classifier(
            families[name],
            (
                data.features[mask, :base_feature_count]
                if name in BASE_FEATURE_TARGETS
                else data.features[mask]
            ),
            target[mask],
            weights(mask),
            iterations=iterations,
            min_samples_leaf=min_samples_leaf,
            threads=threads,
        )
        for name, (target, mask) in classifier_targets.items()
    }
    regression_targets = {
        "fillFractionGivenFill": (data.fill_fraction, conditional, False),
        "expectedNetReturnGivenFill": (data.conditional_return, conditional, False),
        "expectedNetReturnOnRequestedNotional": (
            data.net_return_on_requested_notional,
            train,
            False,
        ),
    }
    for name, (target, mask, robust) in regression_targets.items():
        models[name] = _fit_regressor(
            families[name],
            data.features[mask],
            target[mask],
            weights(mask),
            iterations=iterations,
            min_samples_leaf=min_samples_leaf,
            threads=threads,
            robust=robust,
        )
    conditional_x = data.features[conditional]
    conditional_y = data.conditional_return[conditional]
    for name, quantile in (("q10", 0.1), ("q50", 0.5), ("q90", 0.9)):
        models[name] = _fit_regressor(
            families[name],
            conditional_x,
            conditional_y,
            weights(conditional),
            iterations=iterations,
            min_samples_leaf=min_samples_leaf,
            threads=threads,
            quantile=quantile,
        )
    if fit_selection_ranker:
        models["selectionScore"] = _fit_selection_ranker(
            data.features[train],
            data.net_return_on_requested_notional[train],
            data.dates[train],
            weights(train),
            iterations=iterations,
            min_samples_leaf=min_samples_leaf,
            threads=threads,
        )
    selected_families = set(families.values())
    return ActionValueCandidate(
        family=family if len(selected_families) == 1 else "mixed",
        feature_names=data.feature_names,
        base_feature_count=base_feature_count,
        model_families=families,
        models=models,
    )


def fit_probability_ensemble(
    candidate: ActionValueCandidate,
    data: ActionValueTrainingData,
    train_mask,
    *,
    families: tuple[str, ...] = ACTION_VALUE_FAMILIES,
    iterations: int = 120,
    min_samples_leaf: int = 100,
    threads: int = 2,
) -> ActionValueCandidate:
    train = np.asarray(train_mask, dtype=bool)
    conditional = train & data.conditional_available
    if (
        train.shape != (len(data.features),)
        or not np.any(conditional)
        or not families
        or any(family not in ACTION_VALUE_FAMILIES for family in families)
    ):
        raise ActionValueModelError("ACTION_VALUE_TRAINING_CONFIG_INVALID")

    def weights(mask):
        selected = scenario_weights(data.dates[mask], data.episodes[mask])
        return selected / selected.mean()

    classifier_targets = {
        "pAnyFill": (data.p_any_fill, train),
        "pFullFillGivenFill": (data.p_full_fill, conditional),
        "pWinGivenFill": (data.p_win_given_fill, conditional),
        "stopHazardGivenFill": (data.stop_hazard_given_fill, conditional),
    }
    models = dict(candidate.models)
    for name, (target, mask) in classifier_targets.items():
        selected_family = candidate.model_families[name]
        fitted = {selected_family: candidate.models[name]}
        for family in families:
            if family == selected_family:
                continue
            fitted[family] = _fit_classifier(
                family,
                (
                    data.features[mask, : candidate.base_feature_count]
                    if name in BASE_FEATURE_TARGETS
                    else data.features[mask]
                ),
                target[mask],
                weights(mask),
                iterations=iterations,
                min_samples_leaf=min_samples_leaf,
                threads=threads,
            )
        models[name] = AveragedProbabilityModel(
            tuple(fitted[family] for family in families)
        )
    return ActionValueCandidate(
        family="mixed-ensemble",
        feature_names=candidate.feature_names,
        base_feature_count=candidate.base_feature_count,
        model_families=candidate.model_families,
        models=models,
        probability_ensemble_families=families,
    )
