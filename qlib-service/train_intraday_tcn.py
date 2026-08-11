"""Train a T+1-compliant temporal convolutional network on minute sequences."""

import argparse
import json
import math
import os
import random
import time

import numpy as np


ARCHITECTURES = frozenset({"tcn", "gru", "transformer"})


def normalize_architecture(architecture):
    if not isinstance(architecture, str) or architecture not in ARCHITECTURES:
        raise ValueError("architecture 必须是 tcn、gru 或 transformer")
    return architecture


def purged_holdout_split(dates, *, holdout_fraction=0.15, purge_dates=1):
    dates = np.asarray(dates).astype(str)
    if dates.ndim != 1 or not len(dates):
        raise ValueError("dates 必须是一维非空数组")
    if not 0 < holdout_fraction < 0.5:
        raise ValueError("holdout_fraction 必须在 0 到 0.5 之间")
    if not isinstance(purge_dates, int) or purge_dates < 0:
        raise ValueError("purge_dates 必须是非负整数")
    unique_dates = np.unique(dates)
    holdout_count = max(1, math.ceil(len(unique_dates) * holdout_fraction))
    holdout_position = len(unique_dates) - holdout_count
    purge_position = holdout_position - purge_dates
    if purge_position <= 0:
        raise ValueError("数据不足以支撑当前留出和清洗天数")
    holdout_start = unique_dates[holdout_position]
    purge_start = unique_dates[purge_position]
    train_index = np.flatnonzero(dates < purge_start)
    holdout_index = np.flatnonzero(dates >= holdout_start)
    if not len(train_index) or not len(holdout_index):
        raise ValueError("时序切分产生空分区")
    return train_index, holdout_index, {
        "holdout_start_date": str(holdout_start),
        "purge_start_date": str(purge_start),
        "purge_dates": purge_dates,
        "train_samples": int(len(train_index)),
        "holdout_samples": int(len(holdout_index)),
    }


def map_barrier_labels(labels):
    labels = np.asarray(labels, dtype=int)
    if not set(np.unique(labels)).issubset({-1, 0, 1}):
        raise ValueError("三重障碍标签必须仅包含 -1、0、1")
    return labels + 1


def fit_normalizer(train_sequences):
    values = np.asarray(train_sequences, dtype=np.float64)
    if values.ndim != 3 or not len(values):
        raise ValueError("训练序列必须是非空三维数组")
    mean = values.mean(axis=(0, 1))
    std = values.std(axis=(0, 1))
    std = np.where(std > 1e-8, std, 1.0)
    return mean, std


def apply_normalizer(sequences, mean, std):
    values = np.asarray(sequences, dtype=np.float32)
    mean = np.asarray(mean, dtype=np.float32)
    std = np.asarray(std, dtype=np.float32)
    if values.ndim != 3 or values.shape[-1] != len(mean) or len(mean) != len(std):
        raise ValueError("序列和归一化参数维度不匹配")
    return ((values - mean) / std).astype(np.float32)


def _set_seed(seed):
    random.seed(seed)
    np.random.seed(seed)
    import torch

    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def _class_weights(labels):
    labels = np.asarray(labels, dtype=int)
    classes, counts = np.unique(labels, return_counts=True)
    weights = np.ones(3, dtype=np.float32)
    for cls, count in zip(classes, counts):
        weights[cls] = len(labels) / (len(classes) * count)
    return weights


def _build_tcn(input_features, channels=64, dropout=0.15):
    import torch

    class ResidualBlock(torch.nn.Module):
        def __init__(self, in_channels, out_channels, dilation):
            super().__init__()
            padding = dilation * 2
            self.conv1 = torch.nn.Conv1d(
                in_channels,
                out_channels,
                kernel_size=3,
                padding=padding,
                dilation=dilation,
            )
            self.conv2 = torch.nn.Conv1d(
                out_channels,
                out_channels,
                kernel_size=3,
                padding=padding,
                dilation=dilation,
            )
            self.dropout = torch.nn.Dropout(dropout)
            self.skip = (
                torch.nn.Identity()
                if in_channels == out_channels
                else torch.nn.Conv1d(in_channels, out_channels, kernel_size=1)
            )

        def forward(self, value):
            residual = self.skip(value)
            value = self.conv1(value)
            value = value[..., : residual.shape[-1]]
            value = self.dropout(torch.nn.functional.gelu(value))
            value = self.conv2(value)
            value = value[..., : residual.shape[-1]]
            return torch.nn.functional.gelu(value + residual)

    class TCN(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.blocks = torch.nn.Sequential(
                ResidualBlock(input_features, channels, 1),
                ResidualBlock(channels, channels, 2),
                ResidualBlock(channels, channels, 4),
            )
            self.head = torch.nn.Sequential(
                torch.nn.AdaptiveAvgPool1d(1),
                torch.nn.Flatten(),
                torch.nn.Dropout(dropout),
                torch.nn.Linear(channels, 3),
            )

        def forward(self, value):
            return self.head(self.blocks(value))

    return TCN()


def _build_gru(input_features, hidden_size=64, dropout=0.15):
    import torch

    class GRUClassifier(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = torch.nn.GRU(
                input_features,
                hidden_size,
                num_layers=2,
                batch_first=True,
                dropout=dropout,
            )
            self.head = torch.nn.Sequential(
                torch.nn.Dropout(dropout),
                torch.nn.Linear(hidden_size, 3),
            )

        def forward(self, value):
            _output, hidden = self.encoder(value)
            return self.head(hidden[-1])

    return GRUClassifier()


def _build_transformer(
    input_features,
    sequence_length,
    model_size=64,
    dropout=0.15,
):
    import torch

    class TransformerClassifier(torch.nn.Module):
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
            self.head = torch.nn.Sequential(
                torch.nn.LayerNorm(model_size),
                torch.nn.Dropout(dropout),
                torch.nn.Linear(model_size, 3),
            )

        def forward(self, value):
            value = self.input_projection(value) + self.position
            value = self.encoder(value)
            return self.head(value[:, -1, :])

    return TransformerClassifier()


def _build_model(architecture, input_features, sequence_length):
    architecture = normalize_architecture(architecture)
    if architecture == "tcn":
        return _build_tcn(input_features)
    if architecture == "gru":
        return _build_gru(input_features)
    return _build_transformer(input_features, sequence_length)


def _model_input(sequences, architecture):
    import torch

    tensor = torch.from_numpy(sequences)
    return tensor.permute(0, 2, 1) if architecture == "tcn" else tensor


def train_tcn(
    dataset_path,
    output_dir,
    *,
    architecture="tcn",
    seed=42,
    batch_size=512,
    max_epochs=40,
    patience=6,
    learning_rate=1e-3,
):
    import torch
    from sklearn.metrics import balanced_accuracy_score, f1_score, log_loss

    architecture = normalize_architecture(architecture)
    _set_seed(seed)
    with np.load(dataset_path, allow_pickle=False) as data:
        X = data["X"].astype(np.float32)
        dates = data["dates"].astype(str)
        labels = map_barrier_labels(data["y_barrier"])
        feature_names = [str(value) for value in data["feature_names"]]
    train_index, holdout_index, split = purged_holdout_split(dates)
    mean, std = fit_normalizer(X[train_index])
    train_x = apply_normalizer(X[train_index], mean, std)
    holdout_x = apply_normalizer(X[holdout_index], mean, std)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = _build_model(
        architecture,
        X.shape[-1],
        X.shape[1],
    ).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=learning_rate,
        weight_decay=1e-4,
    )
    criterion = torch.nn.CrossEntropyLoss(
        weight=torch.from_numpy(_class_weights(labels[train_index])).to(device),
    )
    generator = torch.Generator()
    generator.manual_seed(seed)
    loader = torch.utils.data.DataLoader(
        torch.utils.data.TensorDataset(
            _model_input(train_x, architecture),
            torch.from_numpy(labels[train_index]).long(),
        ),
        batch_size=batch_size,
        shuffle=True,
        generator=generator,
    )
    holdout_tensor = _model_input(holdout_x, architecture).to(device)
    holdout_labels = labels[holdout_index]

    os.makedirs(output_dir, exist_ok=True)
    best_loss = float("inf")
    best_epoch = 0
    best_state = None
    history = []
    for epoch in range(1, max_epochs + 1):
        model.train()
        losses = []
        for batch_x, batch_y in loader:
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch_x.to(device))
            loss = criterion(logits, batch_y.to(device))
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        model.eval()
        with torch.no_grad():
            logits = model(holdout_tensor)
            probabilities = torch.softmax(logits, dim=1).cpu().numpy()
            loss = float(
                criterion(logits, torch.from_numpy(holdout_labels).to(device))
                .detach()
                .cpu()
            )
        history.append(
            {
                "epoch": epoch,
                "train_loss": float(np.mean(losses)),
                "holdout_loss": loss,
            }
        )
        if loss < best_loss - 1e-5:
            best_loss = loss
            best_epoch = epoch
            best_state = {
                key: value.detach().cpu().clone()
                for key, value in model.state_dict().items()
            }
        elif epoch - best_epoch >= patience:
            break

    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        probabilities = torch.softmax(model(holdout_tensor), dim=1).cpu().numpy()
    predictions = probabilities.argmax(axis=1)
    metrics = {
        "model": architecture,
        "device": str(device),
        "seed": seed,
        "samples": int(len(X)),
        "sequence_length": int(X.shape[1]),
        "features": feature_names,
        "split": split,
        "best_epoch": best_epoch,
        "holdout_log_loss": float(
            log_loss(holdout_labels, probabilities, labels=[0, 1, 2])
        ),
        "holdout_macro_f1": float(
            f1_score(holdout_labels, predictions, average="macro")
        ),
        "holdout_balanced_accuracy": float(
            balanced_accuracy_score(holdout_labels, predictions)
        ),
        "trained_at": int(time.time()),
        "history": history,
    }
    torch.save(
        {
            "state_dict": model.state_dict(),
            "architecture": architecture,
            "feature_names": feature_names,
            "normalizer_mean": mean,
            "normalizer_std": std,
            "sequence_length": int(X.shape[1]),
            "metrics": metrics,
        },
        os.path.join(output_dir, f"{architecture}.pt"),
    )
    np.savez_compressed(
        os.path.join(output_dir, f"{architecture}_holdout_predictions.npz"),
        dates=dates[holdout_index],
        actual_barrier=holdout_labels,
        predicted_barrier=predictions,
        barrier_prob=probabilities.astype(np.float32),
    )
    with open(
        os.path.join(output_dir, f"{architecture}_metrics.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(metrics, handle, ensure_ascii=False, indent=2)
    return metrics


def main():
    parser = argparse.ArgumentParser(description="训练分钟时序候选模型")
    parser.add_argument("--data", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument(
        "--architecture",
        choices=sorted(ARCHITECTURES),
        default="tcn",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--max-epochs", type=int, default=40)
    parser.add_argument("--patience", type=int, default=6)
    args = parser.parse_args()
    metrics = train_tcn(
        args.data,
        args.out_dir,
        architecture=args.architecture,
        seed=args.seed,
        batch_size=args.batch_size,
        max_epochs=args.max_epochs,
        patience=args.patience,
    )
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print("INTRADAY_TCN_TRAINING_OK")


if __name__ == "__main__":
    main()
