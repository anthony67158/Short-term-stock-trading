"""Resumable deep tabular return-model ablation on frozen ranking folds."""

import argparse
import fcntl
import gc
import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import tabm
import torch
from torch import nn

from platform_app.modules.experiments.quant_model_trainer import QuantModelError
from platform_app.modules.experiments.ranking_combination import (
    CANDIDATES,
    combination_scores,
    daily_percentiles,
    temporal_fusion_weights,
)
from platform_app.modules.experiments.ranking_combination_runner import (
    evaluate_scores,
    write_json,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    GLOBAL_PERCENTILE_TARGET,
    MODEL_FEATURE_NAMES,
    _file_sha256,
    _verified_ranking_database,
    load_ranking_training_data,
)
from platform_app.modules.experiments.ranking_walk_forward import (
    block_bootstrap_interval,
    expanding_walk_forward_splits,
)
from platform_app.modules.experiments.ranking_window_runner import verified_base_predictions

ARCHITECTURES = ("tabm", "tabm-mini", "mlp")
DEFAULT_SEEDS = (17, 29, 43)


class MLPEnsemble(nn.Module):
    """Expose a regular MLP through the same (batch, members, output) contract."""

    def __init__(self, n_features: int, blocks: int, width: int, dropout: float):
        super().__init__()
        layers: list[nn.Module] = []
        current = n_features
        for _ in range(blocks):
            layers.extend((nn.Linear(current, width), nn.ReLU(), nn.Dropout(dropout)))
            current = width
        layers.append(nn.Linear(current, 1))
        self.network = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.network(x).unsqueeze(1)


def resolve_device(requested: str) -> torch.device:
    if requested != "auto":
        device = torch.device(requested)
        if device.type == "cuda" and not torch.cuda.is_available():
            raise QuantModelError("TABM_CUDA_UNAVAILABLE")
        if device.type == "mps" and not torch.backends.mps.is_available():
            raise QuantModelError("TABM_MPS_UNAVAILABLE")
        return device
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def fit_preprocessor(x: np.ndarray, target: np.ndarray, indices: np.ndarray) -> dict:
    if len(indices) == 0:
        raise QuantModelError("TABM_TRAINING_WINDOW_EMPTY")
    feature_sum = np.zeros(x.shape[1], dtype=np.float64)
    feature_square_sum = np.zeros(x.shape[1], dtype=np.float64)
    for start in range(0, len(indices), 262_144):
        batch = x[indices[start : start + 262_144]].astype(np.float64)
        feature_sum += batch.sum(axis=0)
        feature_square_sum += np.square(batch).sum(axis=0)
    feature_mean = feature_sum / len(indices)
    feature_variance = np.maximum(feature_square_sum / len(indices) - feature_mean**2, 0)
    feature_scale = np.sqrt(feature_variance)
    feature_scale[feature_scale < 1e-6] = 1.0
    lower, upper = np.quantile(target[indices], [0.005, 0.995])
    clipped = np.clip(target[indices], lower, upper)
    target_mean = float(clipped.mean(dtype=np.float64))
    target_scale = float(clipped.std(dtype=np.float64))
    if target_scale < 1e-8:
        target_scale = 1.0
    return {
        "featureMean": feature_mean.astype(np.float32),
        "featureScale": feature_scale.astype(np.float32),
        "targetLower": float(lower),
        "targetUpper": float(upper),
        "targetMean": target_mean,
        "targetScale": target_scale,
    }


def independent_ensemble_mse(
    predictions: torch.Tensor,
    target: torch.Tensor,
    weight: torch.Tensor,
) -> torch.Tensor:
    if predictions.ndim != 2 or target.ndim != 1 or weight.ndim != 1:
        raise QuantModelError("TABM_LOSS_SHAPE_INVALID")
    if predictions.shape[0] != target.shape[0] or target.shape != weight.shape:
        raise QuantModelError("TABM_LOSS_SHAPE_INVALID")
    squared_error = (predictions - target[:, None]).square()
    return (squared_error * weight[:, None]).sum() / (weight.sum() * predictions.shape[1])


def build_model(
    architecture: str,
    n_features: int,
    *,
    members: int,
    blocks: int,
    width: int,
    dropout: float,
) -> nn.Module:
    if architecture not in ARCHITECTURES:
        raise QuantModelError("TABM_ARCHITECTURE_UNSUPPORTED")
    if architecture == "mlp":
        return MLPEnsemble(n_features, blocks, width, dropout)
    return tabm.TabM.make(
        n_num_features=n_features,
        cat_cardinalities=None,
        d_out=1,
        arch_type=architecture,
        k=members,
        n_blocks=blocks,
        d_block=width,
        dropout=dropout,
    )


def _seed_everything(seed: int, device: torch.device) -> None:
    np.random.seed(seed)
    torch.manual_seed(seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(seed)
    elif device.type == "mps":
        torch.mps.manual_seed(seed)


def _training_indices(mask: np.ndarray, limit: int | None, seed: int) -> np.ndarray:
    indices = np.flatnonzero(mask)
    if limit is None or limit >= len(indices):
        return indices
    if limit < 1:
        raise QuantModelError("TABM_TRAINING_LIMIT_INVALID")
    rng = np.random.default_rng(seed)
    return np.sort(rng.choice(indices, size=limit, replace=False))


def temporal_training_partition(
    dates: np.ndarray,
    train_mask: np.ndarray,
    *,
    validation_sessions: int,
    purge_sessions: int,
) -> tuple[np.ndarray, np.ndarray]:
    train_dates = np.unique(dates[train_mask])
    if (
        validation_sessions < 1
        or purge_sessions < 0
        or len(train_dates) <= validation_sessions + purge_sessions
    ):
        raise QuantModelError("TABM_INTERNAL_VALIDATION_INVALID")
    validation_start = len(train_dates) - validation_sessions
    fit_end = validation_start - purge_sessions
    fit_mask = train_mask & (dates <= train_dates[fit_end - 1])
    validation_mask = train_mask & (dates >= train_dates[validation_start])
    return fit_mask, validation_mask


def _tensor_batch(
    data,
    indices: np.ndarray,
    preprocessor: dict,
    device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    x = (
        data.x[indices] - preprocessor["featureMean"]
    ) / preprocessor["featureScale"]
    target = np.clip(
        data.target_return[indices],
        preprocessor["targetLower"],
        preprocessor["targetUpper"],
    )
    target = (target - preprocessor["targetMean"]) / preprocessor["targetScale"]
    weight = data.sample_weight[indices]
    weight = weight / weight.mean()
    return (
        torch.as_tensor(x, dtype=torch.float32, device=device),
        torch.as_tensor(target, dtype=torch.float32, device=device),
        torch.as_tensor(weight, dtype=torch.float32, device=device),
    )


@torch.inference_mode()
def validation_loss(
    model: nn.Module,
    data,
    indices: np.ndarray,
    preprocessor: dict,
    *,
    batch_size: int,
    device: torch.device,
) -> float:
    model.eval()
    weighted_loss = 0.0
    seen_weight = 0.0
    for start in range(0, len(indices), batch_size):
        batch = indices[start : start + batch_size]
        x, target, weight = _tensor_batch(data, batch, preprocessor, device)
        loss = independent_ensemble_mse(model(x).squeeze(-1), target, weight)
        batch_weight = float(weight.sum().cpu())
        weighted_loss += float(loss.cpu()) * batch_weight
        seen_weight += batch_weight
    return weighted_loss / seen_weight


def fit_deep_model(
    data,
    train_mask: np.ndarray,
    *,
    architecture: str,
    seed: int,
    epochs: int,
    batch_size: int,
    members: int,
    blocks: int,
    width: int,
    dropout: float,
    learning_rate: float,
    device_name: str,
    max_train_rows: int | None = None,
    validation_sessions: int = 63,
    purge_sessions: int = 5,
    patience: int = 3,
) -> tuple[nn.Module, dict, dict]:
    if (
        epochs < 1
        or batch_size < 1
        or members < 1
        or blocks < 1
        or width < 1
        or patience < 1
    ):
        raise QuantModelError("TABM_BUDGET_INVALID")
    device = resolve_device(device_name)
    fit_mask, validation_mask = temporal_training_partition(
        data.dates,
        train_mask,
        validation_sessions=validation_sessions,
        purge_sessions=purge_sessions,
    )
    indices = _training_indices(fit_mask, max_train_rows, seed)
    validation_indices = np.flatnonzero(validation_mask)
    preprocessor = fit_preprocessor(data.x, data.target_return, indices)
    _seed_everything(seed, device)
    model = build_model(
        architecture,
        data.x.shape[1],
        members=members,
        blocks=blocks,
        width=width,
        dropout=dropout,
    ).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=learning_rate,
        weight_decay=1e-5,
    )
    rng = np.random.default_rng(seed)
    history = []
    best_loss = float("inf")
    best_epoch = 0
    best_state = None
    stale_epochs = 0
    started = time.monotonic()
    for epoch in range(epochs):
        model.train()
        shuffled = rng.permutation(indices)
        weighted_loss = 0.0
        seen_weight = 0.0
        for start in range(0, len(shuffled), batch_size):
            batch = shuffled[start : start + batch_size]
            x, target, weight = _tensor_batch(data, batch, preprocessor, device)
            optimizer.zero_grad(set_to_none=True)
            predictions = model(x).squeeze(-1)
            loss = independent_ensemble_mse(predictions, target, weight)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            batch_weight = float(weight.sum().detach().cpu())
            weighted_loss += float(loss.detach().cpu()) * batch_weight
            seen_weight += batch_weight
        train_loss = weighted_loss / seen_weight
        held_out_loss = validation_loss(
            model,
            data,
            validation_indices,
            preprocessor,
            batch_size=batch_size,
            device=device,
        )
        history.append({"train": train_loss, "validation": held_out_loss})
        if held_out_loss < best_loss:
            best_loss = held_out_loss
            best_epoch = epoch + 1
            best_state = {
                key: value.detach().cpu().clone()
                for key, value in model.state_dict().items()
            }
            stale_epochs = 0
        else:
            stale_epochs += 1
        print(
            f"epoch={epoch + 1}/{epochs} architecture={architecture} "
            f"seed={seed} train={train_loss:.6f} validation={held_out_loss:.6f}",
            flush=True,
        )
        if stale_epochs >= patience:
            break
    if best_state is None:
        raise QuantModelError("TABM_TRAINING_DID_NOT_COMPLETE")
    model.load_state_dict(best_state)
    if device.type == "mps":
        torch.mps.synchronize()
    metadata = {
        "device": str(device),
        "elapsedSeconds": time.monotonic() - started,
        "epochLoss": history,
        "bestEpoch": best_epoch,
        "bestValidationLoss": best_loss,
        "trainingRows": int(len(indices)),
        "modelTrainStart": str(data.dates[fit_mask].min()),
        "modelTrainEnd": str(data.dates[fit_mask].max()),
        "validationStart": str(data.dates[validation_mask].min()),
        "validationEnd": str(data.dates[validation_mask].max()),
    }
    return model, preprocessor, metadata


@torch.inference_mode()
def predict(
    model: nn.Module,
    data,
    mask: np.ndarray,
    preprocessor: dict,
    *,
    batch_size: int,
    device: torch.device,
) -> np.ndarray:
    indices = np.flatnonzero(mask)
    result = np.empty(len(indices), dtype=np.float32)
    model.eval()
    for start in range(0, len(indices), batch_size):
        batch = indices[start : start + batch_size]
        x = (
            data.x[batch] - preprocessor["featureMean"]
        ) / preprocessor["featureScale"]
        values = model(
            torch.as_tensor(x, dtype=torch.float32, device=device)
        ).squeeze(-1).mean(dim=1)
        values = values * preprocessor["targetScale"] + preprocessor["targetMean"]
        result[start : start + len(batch)] = values.cpu().numpy()
    return result


def _candidate_name(architecture: str, seed: int) -> str:
    return f"{architecture.replace('-', '_')}_return_s{seed}"


def train_fold(
    data,
    train: np.ndarray,
    fusion: np.ndarray,
    test: np.ndarray,
    root: Path,
    *,
    architecture: str = "tabm",
    seed: int = DEFAULT_SEEDS[0],
    epochs: int = 20,
    batch_size: int = 8192,
    members: int = 16,
    blocks: int = 2,
    width: int = 256,
    dropout: float = 0.1,
    learning_rate: float = 1e-3,
    device_name: str = "auto",
    max_train_rows: int | None = None,
    validation_sessions: int = 63,
    purge_sessions: int = 5,
    patience: int = 3,
) -> tuple[np.ndarray, np.ndarray]:
    name = _candidate_name(architecture, seed)
    artifact = root / f"{name}.pt"
    predictions = root / f"{name}.npz"
    receipt_path = root / f"{name}.json"
    configuration = {
        "architecture": architecture,
        "seed": seed,
        "epochs": epochs,
        "batchSize": batch_size,
        "members": members if architecture != "mlp" else 1,
        "blocks": blocks,
        "width": width,
        "dropout": dropout,
        "learningRate": learning_rate,
        "maxTrainRows": max_train_rows,
        "validationSessions": validation_sessions,
        "purgeSessions": purge_sessions,
        "patience": patience,
    }
    valid = False
    if receipt_path.exists() and artifact.exists() and predictions.exists():
        receipt = json.loads(receipt_path.read_text())
        valid = (
            receipt.get("modelSha256") == _file_sha256(artifact)
            and receipt.get("predictionsSha256") == _file_sha256(predictions)
            and receipt.get("trainEnd") == str(data.dates[train].max())
            and receipt.get("configuration") == configuration
        )
    if not valid:
        model, preprocessor, metadata = fit_deep_model(
            data,
            train,
            architecture=architecture,
            seed=seed,
            epochs=epochs,
            batch_size=batch_size,
            members=members,
            blocks=blocks,
            width=width,
            dropout=dropout,
            learning_rate=learning_rate,
            device_name=device_name,
            max_train_rows=max_train_rows,
            validation_sessions=validation_sessions,
            purge_sessions=purge_sessions,
            patience=patience,
        )
        device = next(model.parameters()).device
        state = {
            "modelState": {key: value.detach().cpu() for key, value in model.state_dict().items()},
            "preprocessor": preprocessor,
            "configuration": configuration,
            "featureNames": list(MODEL_FEATURE_NAMES),
        }
        temporary = artifact.with_suffix(".tmp")
        torch.save(state, temporary)
        os.replace(temporary, artifact)
        with predictions.with_suffix(".tmp").open("wb") as stream:
            np.savez_compressed(
                stream,
                fusion=predict(
                    model, data, fusion, preprocessor, batch_size=batch_size, device=device
                ),
                test=predict(
                    model, data, test, preprocessor, batch_size=batch_size, device=device
                ),
            )
        os.replace(predictions.with_suffix(".tmp"), predictions)
        write_json(receipt_path, {
            "modelSha256": _file_sha256(artifact),
            "predictionsSha256": _file_sha256(predictions),
            "configuration": configuration,
            "rows": metadata["trainingRows"],
            "trainStart": str(data.dates[train].min()),
            "trainEnd": str(data.dates[train].max()),
            "device": metadata["device"],
            "elapsedSeconds": metadata["elapsedSeconds"],
            "epochLoss": metadata["epochLoss"],
            "bestEpoch": metadata["bestEpoch"],
            "bestValidationLoss": metadata["bestValidationLoss"],
            "modelTrainStart": metadata["modelTrainStart"],
            "modelTrainEnd": metadata["modelTrainEnd"],
            "validationStart": metadata["validationStart"],
            "validationEnd": metadata["validationEnd"],
        })
        del model
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    with np.load(predictions, allow_pickle=False) as saved:
        return saved["fusion"].copy(), saved["test"].copy()


def run(
    dataset_root: Path,
    base_root: Path,
    output: Path,
    *,
    architecture: str = "tabm",
    seed: int = DEFAULT_SEEDS[0],
    epochs: int = 20,
    batch_size: int = 8192,
    members: int = 16,
    blocks: int = 2,
    width: int = 256,
    dropout: float = 0.1,
    learning_rate: float = 1e-3,
    device_name: str = "auto",
    fold_numbers: tuple[int, ...] | None = None,
    max_train_rows: int | None = None,
    validation_sessions: int = 63,
    purge_sessions: int = 5,
    patience: int = 3,
) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    with (output / "run.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _run_locked(
            dataset_root,
            base_root,
            output,
            architecture=architecture,
            seed=seed,
            epochs=epochs,
            batch_size=batch_size,
            members=members,
            blocks=blocks,
            width=width,
            dropout=dropout,
            learning_rate=learning_rate,
            device_name=device_name,
            fold_numbers=fold_numbers,
            max_train_rows=max_train_rows,
            validation_sessions=validation_sessions,
            purge_sessions=purge_sessions,
            patience=patience,
        )


def _run_locked(
    dataset_root,
    base_root,
    output,
    *,
    architecture,
    seed,
    epochs,
    batch_size,
    members,
    blocks,
    width,
    dropout,
    learning_rate,
    device_name,
    fold_numbers,
    max_train_rows,
    validation_sessions,
    purge_sessions,
    patience,
):
    manifest, _ = _verified_ranking_database(dataset_root)
    base_protocol_path = base_root / "protocol.json"
    base_report_path = base_root / "report.json"
    try:
        base_protocol = json.loads(base_protocol_path.read_text())
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise QuantModelError("COMBINATION_BASE_PROTOCOL_INVALID") from exc
    if (
        base_protocol.get("databaseSha256") != manifest["databaseSha256"]
        or tuple(base_protocol.get("candidates", ())) != CANDIDATES
        or base_protocol.get("target") != GLOBAL_PERCENTILE_TARGET
        or not base_report_path.is_file()
    ):
        raise QuantModelError("COMBINATION_BASE_PROTOCOL_INVALID")
    name = _candidate_name(architecture, seed)
    protocol = {
        "schemaVersion": "ranking-tabm-combination.v1",
        "databaseSha256": manifest["databaseSha256"],
        "datasetId": manifest["datasetId"],
        "target": GLOBAL_PERCENTILE_TARGET,
        "baseCandidates": list(CANDIDATES),
        "additionalCandidate": name,
        "objective": "INDEPENDENT_ENSEMBLE_WEIGHTED_MSE_CLIPPED_RETURN",
        "architecture": architecture,
        "seed": seed,
        "epochs": epochs,
        "batchSize": batch_size,
        "members": members if architecture != "mlp" else 1,
        "blocks": blocks,
        "width": width,
        "dropout": dropout,
        "learningRate": learning_rate,
        "device": str(resolve_device(device_name)),
        "folds": list(fold_numbers) if fold_numbers is not None else None,
        "maxTrainRows": max_train_rows,
        "internalValidationSessions": validation_sessions,
        "internalPurgeSessions": purge_sessions,
        "earlyStoppingPatience": patience,
        "trainingScope": "SMOKE" if max_train_rows is not None else "FULL",
        "earlyStopping": True,
        "fusion": "date-balanced-simplex-mse-50pct-equal-shrinkage",
        "comparisonStatus": "DEVELOPMENT_ONLY_PREVIOUSLY_OBSERVED_DATES",
        "baseExperiment": {
            "protocolSha256": _file_sha256(base_protocol_path),
            "reportSha256": _file_sha256(base_report_path),
        },
        "sourceSha256": _file_sha256(Path(__file__)),
        "versions": {
            "numpy": np.__version__,
            "tabm": tabm.__version__,
            "torch": torch.__version__,
        },
    }
    protocol_path = output / "protocol.json"
    if protocol_path.exists():
        if json.loads(protocol_path.read_text()) != protocol:
            raise QuantModelError("COMBINATION_TABM_RESUME_PROTOCOL_MISMATCH")
    else:
        write_json(protocol_path, protocol)
    data, _ = load_ranking_training_data(dataset_root, target_policy=GLOBAL_PERCENTILE_TARGET)
    folds = expanding_walk_forward_splits(data.dates)
    if fold_numbers is not None:
        selected = set(fold_numbers)
        folds = [fold for fold in folds if fold.fold in selected]
        if len(folds) != len(selected):
            raise QuantModelError("TABM_FOLD_SELECTION_INVALID")
    write_json(output / "splits.json", {"folds": [fold.as_dict() for fold in folds]})
    all_records = []
    for fold in folds:
        root = output / f"fold-{fold.fold}"
        root.mkdir(exist_ok=True)
        train, fusion, test = fold.masks(data.dates)
        fusion_predictions = verified_base_predictions(base_root, fold, "fusion")
        test_predictions = verified_base_predictions(base_root, fold, "test")
        print(f"Training fold={fold.fold} model={name}", flush=True)
        write_json(output / "status.json", {
            "state": "RUNNING",
            "fold": fold.fold,
            "model": name,
            "updatedAt": datetime.now(UTC).isoformat(),
        })
        calibration_values, test_values = train_fold(
            data,
            train,
            fusion,
            test,
            root,
            architecture=architecture,
            seed=seed,
            epochs=epochs,
            batch_size=batch_size,
            members=members,
            blocks=blocks,
            width=width,
            dropout=dropout,
            learning_rate=learning_rate,
            device_name=device_name,
            max_train_rows=max_train_rows,
            validation_sessions=validation_sessions,
            purge_sessions=purge_sessions,
            patience=patience,
        )
        fusion_predictions.append(calibration_values)
        test_predictions.append(test_values)
        candidates = (*CANDIDATES, name)
        calibration = daily_percentiles(data.dates[fusion], np.column_stack(fusion_predictions))
        held_out = daily_percentiles(data.dates[test], np.column_stack(test_predictions))
        weights = temporal_fusion_weights(
            calibration,
            data.target_rank[fusion],
            data.dates[fusion],
            model_train_end=fold.train_end,
            test_start=fold.test_start,
        )
        scores = combination_scores(held_out, weights, candidate_names=candidates)
        scores["base_equal"] = held_out[:, : len(CANDIDATES)].mean(axis=1)
        records, union = evaluate_scores(data, test, scores, fold.fold)
        np.savez_compressed(
            root / "oof.npz",
            dates=data.dates[test],
            instruments=data.instruments[test],
            boards=data.boards[test],
            targetReturn=data.target_return[test],
            normalizedPredictions=held_out,
            weights=weights,
        )
        write_json(root / "evaluation.json", {
            "split": fold.as_dict(),
            "weights": dict(zip(candidates, weights.tolist(), strict=True)),
            "records": records,
            "releaseStatus": "UNAVAILABLE",
        })
        write_json(root / "candidate-union.json", {"candidates": union})
        all_records.extend(records)
        print(f"Completed fold={fold.fold} weights={weights.tolist()}", flush=True)
    names = sorted({row["model"] for row in all_records})
    baseline = np.array([
        row["top10GrossReturn"] for row in all_records if row["model"] == "base_equal"
    ])
    summaries = {}
    for model_name in names:
        rows = [row for row in all_records if row["model"] == model_name]
        gross = np.array([row["top10GrossReturn"] for row in rows])
        rank_ics = [row["rankIc"] for row in rows if row["rankIc"] is not None]
        summaries[model_name] = {
            "meanDailyRankIc": float(np.mean(rank_ics)) if rank_ics else None,
            "top10GrossReturn": float(gross.mean()),
            "versusBaseEqual": block_bootstrap_interval(gross - baseline),
        }
    blockers = [
        "MINUTE_EXECUTION_PENDING",
        "POSITION_AGENT_ABLATION_PENDING",
        "INDEPENDENT_FORWARD_CONFIRMATION_PENDING",
    ]
    if max_train_rows is not None or fold_numbers is not None:
        blockers.insert(0, "REDUCED_SMOKE_RUN_NOT_RELEASE_ELIGIBLE")
    report = {"releaseStatus": "UNAVAILABLE", "models": summaries, "blockers": blockers}
    write_json(output / "report.json", report)
    write_json(output / "status.json", {
        "state": "COMPLETED",
        "releaseStatus": "UNAVAILABLE",
    })
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--base-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--architecture", choices=ARCHITECTURES, default="tabm")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEEDS[0])
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=8192)
    parser.add_argument("--members", type=int, default=16)
    parser.add_argument("--blocks", type=int, default=2)
    parser.add_argument("--width", type=int, default=256)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    parser.add_argument("--fold", type=int, action="append", dest="fold_numbers")
    parser.add_argument("--max-train-rows", type=int)
    parser.add_argument("--validation-sessions", type=int, default=63)
    parser.add_argument("--internal-purge-sessions", type=int, default=5)
    parser.add_argument("--patience", type=int, default=3)
    arguments = parser.parse_args()
    run(
        arguments.dataset_root,
        arguments.base_root,
        arguments.output,
        architecture=arguments.architecture,
        seed=arguments.seed,
        epochs=arguments.epochs,
        batch_size=arguments.batch_size,
        members=arguments.members,
        blocks=arguments.blocks,
        width=arguments.width,
        dropout=arguments.dropout,
        learning_rate=arguments.learning_rate,
        device_name=arguments.device,
        fold_numbers=tuple(arguments.fold_numbers) if arguments.fold_numbers else None,
        max_train_rows=arguments.max_train_rows,
        validation_sessions=arguments.validation_sessions,
        purge_sessions=arguments.internal_purge_sessions,
        patience=arguments.patience,
    )
