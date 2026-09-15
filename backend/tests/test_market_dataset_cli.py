import argparse
from pathlib import Path

import pytest

from platform_app.entrypoints.cli import cross_source_sample, external_dataset_root


def test_market_dataset_output_must_be_absolute_and_outside_repository(tmp_path):
    assert external_dataset_root(tmp_path / "dataset") == (tmp_path / "dataset").resolve()
    with pytest.raises(ValueError, match="absolute"):
        external_dataset_root(Path("relative"))
    repository = Path(__file__).resolve().parents[2]
    with pytest.raises(ValueError, match="outside"):
        external_dataset_root(repository / "local-market-data")


def test_cross_source_sample_requires_canonical_identity_and_date():
    assert cross_source_sample("BJ.920000@20221115") == ("BJ.920000", "20221115")
    with pytest.raises(argparse.ArgumentTypeError, match="INSTRUMENT_ID"):
        cross_source_sample("920000.BJ:20221115")
