"""Train the V2.1 shared-encoder, dual-head intraday Transformer."""

import argparse
import json
import os
import time

import numpy as np

from train_intraday_tcn import (
    _class_weights,
    _model_input,
    _set_seed,
    map_barrier_labels,
    purged_holdout_split,
)


ARCHITECTURE = "transformer-dual-head"
HEADS = ("next30m", "sessionClose")
SESSION_ORDER = ("morning", "noon", "afternoon")
SESSION_BUCKETS = frozenset(SESSION_ORDER)
LABEL_DEFINITIONS = {
    "next30m": {
        "entry": "next5mOpen",
        "bars": 6,
        "takeProfitPct": 0.45,
        "stopLossPct": 0.30,
        "sameBarPolicy": "stopLossFirst",
    },
    "sessionClose": {
        "entry": "next5mOpen",
        "horizon": "sameDayClose",
        "takeProfitPct": 0.80,
        "stopLossPct": 0.50,
        "sameBarPolicy": "stopLossFirst",
    },
}


def validate_dual_head_dataset(X, next30m, session_close, buckets):
    values = np.asarray(X)
    next_labels = np.asarray(next30m)
    close_labels = np.asarray(session_close)
    bucket_values = np.asarray(buckets).astype(str)
    if values.ndim != 3 or not len(values):
        raise ValueError("训练序列必须是非空三维数组")
    if not (
        len(values)
        == len(next_labels)
        == len(close_labels)
        == len(bucket_values)
    ):
        raise ValueError("双头数据字段长度不一致")
    for labels in (next_labels, close_labels):
        if not set(np.unique(labels)).issubset({-1, 0, 1}):
            raise ValueError("三重障碍标签必须仅包含 -1、0、1")
    if not set(np.unique(bucket_values)).issubset(SESSION_BUCKETS):
        raise ValueError("盘中时段标签无效")
    if not np.isfinite(values).all():
        raise ValueError("训练序列包含非有限数值")
    return {
        "samples": int(len(values)),
        "sequence_length": int(values.shape[1]),
        "features": int(values.shape[2]),
    }


def fit_indexed_normalizer(values, indices, *, chunk_size=100_000):
    values = np.asarray(values)
    indices = np.asarray(indices, dtype=np.int64)
    if values.ndim != 3 or indices.ndim != 1 or not len(indices):
        raise ValueError("归一化数据或索引无效")
    if not isinstance(chunk_size, int) or chunk_size < 1:
        raise ValueError("归一化批次必须为正整数")
    if np.any(indices < 0) or np.any(indices >= len(values)):
        raise ValueError("归一化索引越界")

    totals = np.zeros(values.shape[-1], dtype=np.float64)
    squares = np.zeros(values.shape[-1], dtype=np.float64)
    count = 0
    for start in range(0, len(indices), chunk_size):
        selected = indices[start : start + chunk_size]
        chunk = np.asarray(values[selected], dtype=np.float64)
        totals += chunk.sum(axis=(0, 1))
        squares += np.square(chunk).sum(axis=(0, 1))
        count += chunk.shape[0] * chunk.shape[1]
    mean = totals / count
    variance = np.maximum(squares / count - np.square(mean), 0.0)
    std = np.sqrt(variance)
    return mean, np.where(std > 1e-8, std, 1.0)


def normalize_indexed(values, indices, mean, std, *, chunk_size=100_000):
    values = np.asarray(values)
    indices = np.asarray(indices, dtype=np.int64)
    mean = np.asarray(mean, dtype=np.float32)
    std = np.asarray(std, dtype=np.float32)
    output = np.empty(
        (len(indices), values.shape[1], values.shape[2]),
        dtype=np.float32,
    )
    for start in range(0, len(indices), chunk_size):
        stop = min(start + chunk_size, len(indices))
        chunk = np.asarray(values[indices[start:stop]], dtype=np.float32)
        output[start:stop] = (chunk - mean) / std
    return output


def three_way_date_split(
    dates,
    *,
    holdout_fraction=0.15,
    calibration_fraction=0.12,
    purge_dates=1,
):
    dates = np.asarray(dates).astype(str)
    pre_holdout, holdout, outer = purged_holdout_split(
        dates,
        holdout_fraction=holdout_fraction,
        purge_dates=purge_dates,
    )
    train_relative, calibration_relative, inner = purged_holdout_split(
        dates[pre_holdout],
        holdout_fraction=calibration_fraction,
        purge_dates=purge_dates,
    )
    train = pre_holdout[train_relative]
    calibration = pre_holdout[calibration_relative]
    return train, calibration, holdout, {
        "train_samples": int(len(train)),
        "calibration_samples": int(len(calibration)),
        "holdout_samples": int(len(holdout)),
        "calibration_start_date": inner["holdout_start_date"],
        "calibration_purge_start_date": inner["purge_start_date"],
        "holdout_start_date": outer["holdout_start_date"],
        "holdout_purge_start_date": outer["purge_start_date"],
        "purge_dates": purge_dates,
    }


def balanced_accuracy(labels, predictions):
    labels = np.asarray(labels, dtype=int)
    predictions = np.asarray(predictions, dtype=int)
    recalls = []
    for label in range(3):
        selected = labels == label
        if np.any(selected):
            recalls.append(float(np.mean(predictions[selected] == label)))
    if not recalls:
        raise ValueError("平衡准确率缺少标签")
    return float(np.mean(recalls))


def _macro_f1(labels, predictions):
    labels = np.asarray(labels, dtype=int)
    predictions = np.asarray(predictions, dtype=int)
    values = []
    for label in range(3):
        true_positive = np.sum((labels == label) & (predictions == label))
        false_positive = np.sum((labels != label) & (predictions == label))
        false_negative = np.sum((labels == label) & (predictions != label))
        denominator = 2 * true_positive + false_positive + false_negative
        values.append(
            float(2 * true_positive / denominator)
            if denominator
            else 0.0
        )
    return float(np.mean(values))


def fit_probability_calibration(labels, probabilities, buckets):
    labels = np.asarray(labels, dtype=int)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    buckets = np.asarray(buckets).astype(str)
    if (
        labels.ndim != 1
        or probabilities.shape != (len(labels), 3)
        or buckets.shape != labels.shape
        or not np.isfinite(probabilities).all()
        or np.any(probabilities < 0)
    ):
        raise ValueError("概率校准输入无效")

    calibration = {}
    grid = np.linspace(-0.8, 0.8, 17)
    for bucket in SESSION_ORDER:
        selected = buckets == bucket
        if not np.any(selected):
            calibration[bucket] = [0.0, 0.0, 0.0]
            continue
        bucket_labels = labels[selected]
        log_probabilities = np.log(np.clip(
            probabilities[selected],
            1e-8,
            1.0,
        ))
        best_bias = np.zeros(3, dtype=np.float64)
        best_score = float("-inf")
        best_norm = float("inf")
        for stop_bias in grid:
            for take_bias in grid:
                bias = np.asarray([stop_bias, 0.0, take_bias])
                predictions = (log_probabilities + bias).argmax(axis=1)
                score = (
                    balanced_accuracy(bucket_labels, predictions)
                    + 0.15 * _macro_f1(bucket_labels, predictions)
                )
                norm = float(np.square(bias).sum())
                if (
                    score > best_score + 1e-12
                    or (
                        abs(score - best_score) <= 1e-12
                        and norm < best_norm
                    )
                ):
                    best_score = score
                    best_norm = norm
                    best_bias = bias
        calibration[bucket] = best_bias.tolist()
    return calibration


def apply_probability_calibration(probabilities, buckets, calibration):
    probabilities = np.asarray(probabilities, dtype=np.float64)
    buckets = np.asarray(buckets).astype(str)
    if probabilities.ndim != 2 or probabilities.shape[1] != 3:
        raise ValueError("待校准概率维度无效")
    if buckets.shape != (len(probabilities),):
        raise ValueError("待校准概率时段无效")
    output = np.empty_like(probabilities)
    for bucket in SESSION_ORDER:
        selected = buckets == bucket
        if not np.any(selected):
            continue
        bias = np.asarray(calibration.get(bucket), dtype=np.float64)
        if bias.shape != (3,) or not np.isfinite(bias).all():
            raise ValueError(f"{bucket} 概率校准参数无效")
        logits = np.log(np.clip(probabilities[selected], 1e-8, 1.0)) + bias
        logits -= logits.max(axis=1, keepdims=True)
        adjusted = np.exp(logits)
        output[selected] = adjusted / adjusted.sum(axis=1, keepdims=True)
    return output


def _build_dual_head_transformer(
    input_features,
    sequence_length,
    model_size=64,
    dropout=0.15,
):
    import torch

    class DualHeadTransformer(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.input_projection = torch.nn.Linear(input_features, model_size)
            self.position = torch.nn.Parameter(
                torch.zeros(1, sequence_length, model_size)
            )
            layer = torch.nn.TransformerEncoderLayer(
                d_model=model_size,
                nhead=4,
                dim_feedforward=model_size * 2,
                dropout=dropout,
                activation="gelu",
                batch_first=True,
                norm_first=True,
            )
            self.encoder = torch.nn.TransformerEncoder(layer, num_layers=2)
            self.norm = torch.nn.LayerNorm(model_size)
            self.dropout = torch.nn.Dropout(dropout)
            self.next30m_head = torch.nn.Linear(model_size, 3)
            self.session_close_head = torch.nn.Linear(model_size, 3)

        def forward(self, value):
            encoded = self.input_projection(value) + self.position
            hidden = self.dropout(self.norm(self.encoder(encoded)[:, -1, :]))
            return self.next30m_head(hidden), self.session_close_head(hidden)

    return DualHeadTransformer()


def _metrics(labels, probabilities):
    from sklearn.metrics import balanced_accuracy_score, f1_score, log_loss

    predictions = probabilities.argmax(axis=1)
    return {
        "log_loss": float(log_loss(labels, probabilities, labels=[0, 1, 2])),
        "macro_f1": float(f1_score(
            labels,
            predictions,
            average="macro",
            zero_division=0,
        )),
        "balanced_accuracy": float(balanced_accuracy_score(
            labels,
            predictions,
        )),
        "class_counts": {
            str(index): int(np.sum(labels == index))
            for index in range(3)
        },
    }


def evaluation_slices(total_size, batch_size):
    if not isinstance(total_size, int) or total_size < 1:
        raise ValueError("评估样本数必须为正整数")
    if not isinstance(batch_size, int) or batch_size < 1:
        raise ValueError("评估批次必须为正整数")
    for start in range(0, total_size, batch_size):
        yield slice(start, min(start + batch_size, total_size))


def _evaluate(
    model,
    tensor,
    labels_next,
    labels_close,
    criterion_next,
    criterion_close,
    *,
    batch_size=4096,
):
    import torch

    model.eval()
    device = next(model.parameters()).device
    loss_next_sum = 0.0
    loss_close_sum = 0.0
    weight_next_sum = 0.0
    weight_close_sum = 0.0
    probabilities_next = []
    probabilities_close = []
    with torch.no_grad():
        for current in evaluation_slices(len(tensor), batch_size):
            batch_next = labels_next[current].to(device)
            batch_close = labels_close[current].to(device)
            logits_next, logits_close = model(tensor[current].to(device))
            loss_next_sum += float(torch.nn.functional.cross_entropy(
                logits_next,
                batch_next,
                weight=criterion_next.weight,
                reduction="sum",
            ).detach().cpu())
            loss_close_sum += float(torch.nn.functional.cross_entropy(
                logits_close,
                batch_close,
                weight=criterion_close.weight,
                reduction="sum",
            ).detach().cpu())
            weight_next_sum += float(
                criterion_next.weight[batch_next].sum().detach().cpu()
            )
            weight_close_sum += float(
                criterion_close.weight[batch_close].sum().detach().cpu()
            )
            probabilities_next.append(
                torch.softmax(logits_next, dim=1).cpu().numpy()
            )
            probabilities_close.append(
                torch.softmax(logits_close, dim=1).cpu().numpy()
            )
    loss = (
        loss_next_sum / max(weight_next_sum, 1e-12)
        + loss_close_sum / max(weight_close_sum, 1e-12)
    ) / 2.0
    return (
        loss,
        np.concatenate(probabilities_next),
        np.concatenate(probabilities_close),
    )


def train_intraday_v21(
    dataset_path,
    output_dir,
    *,
    seed=42,
    batch_size=512,
    max_epochs=40,
    patience=6,
    learning_rate=1e-3,
):
    import torch

    _set_seed(seed)
    with np.load(dataset_path, allow_pickle=False) as data:
        X = data["X"].astype(np.float32)
        dates = data["dates"].astype(str)
        as_of = data["as_of"].astype(str)
        codes = data["codes"].astype(str)
        buckets = data["session_bucket"].astype(str)
        raw_next = data["y_next30m"].astype(int)
        raw_close = data["y_session_close"].astype(int)
        feature_names = [str(value) for value in data["feature_names"]]
    shape = validate_dual_head_dataset(X, raw_next, raw_close, buckets)
    labels_next = map_barrier_labels(raw_next)
    labels_close = map_barrier_labels(raw_close)
    train_index, calibration_index, holdout_index, split = (
        three_way_date_split(dates)
    )
    sequence_length = int(X.shape[1])
    input_features = int(X.shape[2])
    mean, std = fit_indexed_normalizer(X, train_index)
    train_x = normalize_indexed(X, train_index, mean, std)
    calibration_x = normalize_indexed(X, calibration_index, mean, std)
    holdout_x = normalize_indexed(X, holdout_index, mean, std)
    del X

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = _build_dual_head_transformer(
        input_features,
        sequence_length,
    ).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=learning_rate,
        weight_decay=1e-4,
    )
    criterion_next = torch.nn.CrossEntropyLoss(
        weight=torch.from_numpy(_class_weights(
            labels_next[train_index]
        )).to(device),
    )
    criterion_close = torch.nn.CrossEntropyLoss(
        weight=torch.from_numpy(_class_weights(
            labels_close[train_index]
        )).to(device),
    )
    generator = torch.Generator().manual_seed(seed)
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(
            _model_input(train_x, "transformer"),
            torch.from_numpy(labels_next[train_index]).long(),
            torch.from_numpy(labels_close[train_index]).long(),
        ),
        batch_size=batch_size,
        shuffle=True,
        generator=generator,
    )
    calibration_tensor = _model_input(
        calibration_x,
        "transformer",
    )
    calibration_next = torch.from_numpy(
        labels_next[calibration_index]
    ).long()
    calibration_close = torch.from_numpy(
        labels_close[calibration_index]
    ).long()
    holdout_tensor = _model_input(
        holdout_x,
        "transformer",
    )
    holdout_next = torch.from_numpy(labels_next[holdout_index]).long()
    holdout_close = torch.from_numpy(labels_close[holdout_index]).long()

    best_loss = float("inf")
    best_epoch = 0
    best_state = None
    history = []
    for epoch in range(1, max_epochs + 1):
        model.train()
        losses = []
        for batch_x, batch_next, batch_close in loader:
            optimizer.zero_grad(set_to_none=True)
            logits_next, logits_close = model(batch_x.to(device))
            loss = (
                criterion_next(logits_next, batch_next.to(device))
                + criterion_close(logits_close, batch_close.to(device))
            ) / 2.0
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        calibration_loss, _next_prob, _close_prob = _evaluate(
            model,
            calibration_tensor,
            calibration_next,
            calibration_close,
            criterion_next,
            criterion_close,
        )
        history.append({
            "epoch": epoch,
            "train_loss": float(np.mean(losses)),
            "calibration_loss": calibration_loss,
        })
        if calibration_loss < best_loss - 1e-5:
            best_loss = calibration_loss
            best_epoch = epoch
            best_state = {
                key: value.detach().cpu().clone()
                for key, value in model.state_dict().items()
            }
        elif epoch - best_epoch >= patience:
            break

    if best_state is None:
        raise RuntimeError("V2.1 训练未产生有效检查点")
    model.load_state_dict(best_state)
    calibration_loss, calibration_next_prob, calibration_close_prob = (
        _evaluate(
            model,
            calibration_tensor,
            calibration_next,
            calibration_close,
            criterion_next,
            criterion_close,
        )
    )
    calibration_buckets = buckets[calibration_index]
    probability_calibration = {
        "next30m": fit_probability_calibration(
            labels_next[calibration_index],
            calibration_next_prob,
            calibration_buckets,
        ),
        "sessionClose": fit_probability_calibration(
            labels_close[calibration_index],
            calibration_close_prob,
            calibration_buckets,
        ),
    }
    holdout_loss, raw_next_prob, raw_close_prob = _evaluate(
        model,
        holdout_tensor,
        holdout_next,
        holdout_close,
        criterion_next,
        criterion_close,
    )
    holdout_buckets = buckets[holdout_index]
    next_prob = apply_probability_calibration(
        raw_next_prob,
        holdout_buckets,
        probability_calibration["next30m"],
    )
    close_prob = apply_probability_calibration(
        raw_close_prob,
        holdout_buckets,
        probability_calibration["sessionClose"],
    )
    metrics = {
        "model": ARCHITECTURE,
        "model_version": "v2.1-intraday",
        "device": str(device),
        "seed": seed,
        **shape,
        "split": split,
        "best_epoch": best_epoch,
        "calibration_loss": calibration_loss,
        "holdout_loss": holdout_loss,
        "probability_calibration": probability_calibration,
        "raw_heads": {
            "next30m": _metrics(
                labels_next[holdout_index],
                raw_next_prob,
            ),
            "sessionClose": _metrics(
                labels_close[holdout_index],
                raw_close_prob,
            ),
        },
        "heads": {
            "next30m": _metrics(
                labels_next[holdout_index],
                next_prob,
            ),
            "sessionClose": _metrics(
                labels_close[holdout_index],
                close_prob,
            ),
        },
        "sessions": {},
        "trained_at": int(time.time()),
        "history": history,
    }
    for bucket in sorted(SESSION_BUCKETS):
        index = np.flatnonzero(holdout_buckets == bucket)
        if not len(index):
            continue
        metrics["sessions"][bucket] = {
            "next30m": _metrics(
                labels_next[holdout_index][index],
                next_prob[index],
            ),
            "sessionClose": _metrics(
                labels_close[holdout_index][index],
                close_prob[index],
            ),
        }

    os.makedirs(output_dir, exist_ok=True)
    checkpoint_path = os.path.join(output_dir, "v21_intraday.pt")
    torch.save({
        "state_dict": model.state_dict(),
        "architecture": ARCHITECTURE,
        "model_version": "v2.1-intraday",
        "feature_names": feature_names,
        "normalizer_mean": mean,
        "normalizer_std": std,
        "sequence_length": sequence_length,
        "label_definitions": LABEL_DEFINITIONS,
        "probability_calibration": probability_calibration,
        "metrics": metrics,
    }, checkpoint_path)
    np.savez_compressed(
        os.path.join(output_dir, "v21_holdout_predictions.npz"),
        dates=dates[holdout_index],
        as_of=as_of[holdout_index],
        codes=codes[holdout_index],
        session_bucket=buckets[holdout_index],
        actual_next30m=labels_next[holdout_index],
        predicted_next30m=next_prob.argmax(axis=1),
        next30m_prob=next_prob.astype(np.float32),
        raw_next30m_prob=raw_next_prob.astype(np.float32),
        actual_session_close=labels_close[holdout_index],
        predicted_session_close=close_prob.argmax(axis=1),
        session_close_prob=close_prob.astype(np.float32),
        raw_session_close_prob=raw_close_prob.astype(np.float32),
    )
    with open(
        os.path.join(output_dir, "v21_metrics.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(metrics, handle, ensure_ascii=False, indent=2)
    return metrics


def main():
    parser = argparse.ArgumentParser(
        description="训练 V2.1 盘中双头 Transformer",
    )
    parser.add_argument("--data", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--max-epochs", type=int, default=40)
    parser.add_argument("--patience", type=int, default=6)
    args = parser.parse_args()
    metrics = train_intraday_v21(
        args.data,
        args.out_dir,
        seed=args.seed,
        batch_size=args.batch_size,
        max_epochs=args.max_epochs,
        patience=args.patience,
    )
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print("INTRADAY_V21_TRAINING_OK")


if __name__ == "__main__":
    main()
