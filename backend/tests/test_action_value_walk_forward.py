from dataclasses import replace

import numpy as np
import pytest

from platform_app.modules.experiments.action_value_evaluation import (
    ActionValueReleasePolicy,
)
from platform_app.modules.experiments.action_value_shadow import (
    ActionValueShadowBundle,
    fit_action_value_shadow,
    write_action_value_shadow_bundle,
)
from platform_app.modules.experiments.action_value_training import (
    build_action_value_training_data,
)
from platform_app.modules.experiments.action_value_walk_forward import (
    ActionValueWalkForwardError,
    ActionValueWalkForwardConfig,
    WalkForwardActionValuePredictor,
    run_action_value_walk_forward,
)


def _training_data():
    rng = np.random.default_rng(97240)
    dates = np.repeat(np.arange(20260001, 20260111), 4)
    features = rng.normal(size=(len(dates), 4)).astype(np.float32)
    boards = np.tile(np.arange(4), len(dates) // 4)
    rows = []
    for index, values in enumerate(features):
        filled = index % 3 != 0
        full = filled and index % 2 == 0
        win = filled and values[2] > 0
        stopped = filled and index % 5 == 0
        fill_fraction = 1.0 if full else (0.5 if filled else 0.0)
        conditional_return = 0.02 if win else -0.012
        target_notional = 1000 / fill_fraction if filled else 10000
        rows.append(
            {
                "decision_date": int(dates[index]),
                "episode_id": f"{dates[index]}-{index // 2}",
                "fill_ratio": str(fill_fraction),
                "p_fill_label": int(filled),
                "p_full_fill_label": int(full),
                "p_win_given_fill_label": int(win) if filled else None,
                "net_return_given_fill": (
                    str(conditional_return) if filled else None
                ),
                "stop_hazard_label": int(stopped) if filled else None,
                "entry_price": "10" if filled else None,
                "exit_price": (
                    str(10 * (1 + conditional_return)) if filled else None
                ),
                "filled_shares": 100 if filled else 0,
                "buy_fees_cny": "0" if filled else None,
                "sell_fees_cny": "0" if filled else None,
                "target_notional_cny": str(target_notional),
            }
        )
    return build_action_value_training_data(
        features=features,
        feature_names=("f0", "f1", "f2", "f3"),
        dates=dates,
        boards=boards,
        rows=rows,
    )


def test_nested_walk_forward_selects_family_without_reading_outer_test_targets(
    tmp_path,
):
    config = ActionValueWalkForwardConfig(
        fold_count=2,
        minimum_train_sessions=30,
        calibration_sessions=15,
        minimum_test_sessions=20,
        purge_sessions=2,
        embargo_sessions=2,
        inner_minimum_train_sessions=15,
        inner_validation_sessions=10,
        candidate_families=("hgb", "lightgbm"),
        iterations=10,
        min_samples_leaf=3,
        threads=1,
        minimum_calibration_selections=5,
        bootstrap_block_sessions=5,
        bootstrap_iterations=50,
    )
    policy = ActionValueReleasePolicy(
        minimum_outer_folds=2,
        minimum_test_sessions_per_fold=20,
        minimum_conditional_samples=1,
        minimum_selected_samples=1,
        minimum_p_any_fill_auc=0,
        minimum_p_full_fill_auc=0,
        minimum_p_win_auc=0,
        minimum_stop_hazard_auc=0,
        maximum_ece=1,
        minimum_brier_skill=-100,
        minimum_log_loss_skill=-100,
        minimum_interval_coverage=0,
        maximum_interval_coverage=1,
        minimum_return_mae_skill=-100,
        minimum_net_return_lower_bound=-1,
    )

    data = _training_data()
    result = run_action_value_walk_forward(
        data,
        config=config,
        release_policy=policy,
    )

    assert len(result.artifacts) == 2
    assert result.report["schemaVersion"] == "action-value-walk-forward.v1"
    assert result.report["folds"] == 2
    assert result.report["minimumFoldTestSessions"] >= 20
    assert result.report["gate"]["passed"] is True
    for fold, artifact in zip(result.report["foldReports"], result.artifacts, strict=True):
        assert fold["selectedFamily"] == "mixed-ensemble"
        assert tuple(fold["probabilityEnsembleFamilies"]) == (
            "hgb",
            "lightgbm",
        )
        assert set(fold["selectedFamilies"]) == set(
            artifact.candidate.model_families
        )
        assert set(fold["selectedFamilies"].values()) <= set(
            config.candidate_families
        )
        assert artifact.candidate.model_families == fold["selectedFamilies"]
        assert len(fold["innerTrials"]) == len(config.candidate_families)
        assert all(
            set(trial["targetSelectionLosses"])
            == set(artifact.candidate.model_families)
            for trial in fold["innerTrials"]
        )
        assert artifact.fold.test_start == int(fold["split"]["testStart"])

    final_fold = result.artifacts[-1].fold
    final_test = final_fold.masks(data.dates)[2]
    changed_conditional = data.conditional_return.copy()
    changed_requested = data.net_return_on_requested_notional.copy()
    changed_conditional[final_test] += 10
    changed_requested[final_test] += 10
    changed = replace(
        data,
        conditional_return=changed_conditional,
        net_return_on_requested_notional=changed_requested,
    )
    rerun = run_action_value_walk_forward(
        changed,
        config=config,
        release_policy=policy,
    )
    for before, after in zip(result.artifacts, rerun.artifacts, strict=True):
        before_predictions = before.calibration.predict(data.features[final_test])
        after_predictions = after.calibration.predict(data.features[final_test])
        for name in before_predictions:
            np.testing.assert_array_equal(
                before_predictions[name],
                after_predictions[name],
            )

    predictor = WalkForwardActionValuePredictor(result.artifacts)
    first = result.artifacts[0]
    first_test = first.fold.masks(data.dates)[2]
    row = np.flatnonzero(first_test)[0]
    prediction = predictor.predict_action_value(
        decision_date=int(data.dates[row]),
        scenario_values=data.features[row],
    )
    assert prediction["fold"] == 1
    assert prediction["dailySelectionLimit"] in {1, 3, 5, 10}
    assert prediction["releaseStatus"] == "UNAVAILABLE"
    with pytest.raises(
        ActionValueWalkForwardError,
        match="ACTION_VALUE_DATE_OUT_OF_SCOPE",
    ):
        predictor.predict_action_value(
            decision_date=19000101,
            scenario_values=data.features[row],
        )

    shadow = fit_action_value_shadow(
        data,
        result,
        account_gate={
            "passed": True,
            "maximumSupportedCashCny": "1000000.00",
        },
        minimum_domain_samples=1,
        minimum_domain_selections=1,
        minimum_domain_return_lower_bound=-1,
    )
    supported_board = shadow.domain.supported_boards[0]
    supported_row = np.flatnonzero(data.boards == supported_board)[0]
    prediction = shadow.predict_action_value(
        decision_date=20270101,
        board=int(supported_board),
        scenario_values=data.features[supported_row],
    )
    assert prediction["status"] == "SHADOW"
    assert prediction["allowsNewRisk"] is False
    assert prediction["dailySelectionLimit"] in {1, 3, 5, 10}

    outlier = data.features[supported_row].copy()
    outlier[0] = shadow.domain.upper_bounds[0] + 1
    ood = shadow.predict_action_value(
        decision_date=20270101,
        board=int(supported_board),
        scenario_values=outlier,
    )
    assert ood["status"] == "OOD"
    assert "FEATURE_OUT_OF_RANGE:f0" in ood["reasonCodes"]

    root = tmp_path / "shadow"
    manifest = write_action_value_shadow_bundle(
        output_root=root,
        bundle_id="action-value-shadow-v1",
        model=shadow,
        walk_forward_report=result.report,
        lineage={"labelDatabaseSha256": "a" * 64},
    )
    loaded = ActionValueShadowBundle(root)
    assert manifest["releaseStatus"] == "SHADOW"
    assert loaded.manifest["allowsNewRisk"] is False
    assert loaded.predict_action_value(
        decision_date=20270101,
        board=int(supported_board),
        scenario_values=data.features[supported_row],
    )["status"] == "SHADOW"
