"""Entry-head projection for unowned instruments."""

from __future__ import annotations


HEAD_VERSION = "entry-head.adapter-v1"


def entry_value(p_fill, expected_net_r):
    return float(p_fill) * float(expected_net_r)
