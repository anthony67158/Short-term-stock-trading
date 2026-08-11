"""Minute-data primitives shared by the lab downloader and training pipeline."""

import math
import re
import json
import os
import tempfile
from calendar import monthrange
from datetime import datetime

import numpy as np


MINUTE_FIELDS = (
    "ts_code",
    "trade_time",
    "open",
    "close",
    "high",
    "low",
    "vol",
    "amount",
)
_CACHED_CODE_RE = re.compile(r"^(sh|sz|bj)(\d{6})$", re.IGNORECASE)
_TUSHARE_CODE_RE = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")
_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"
_FREQUENCY_RE = re.compile(r"^(1|5|15|30|60)min$")
_SOURCE_QUALITY_ERRORS = frozenset(
    {
        "分钟 OHLC 必须为正数",
        "分钟 high 小于 open/close",
        "分钟 low 大于 open/close",
        "分钟月度数据质量缺口",
    }
)
MAX_SOURCE_ROW_DROP_FRACTION = 0.001


def to_tushare_code(code):
    """Convert the cached ``sh600519`` form to ``600519.SH``."""
    if not isinstance(code, str):
        raise ValueError("股票代码必须是字符串")
    text = code.strip()
    if _TUSHARE_CODE_RE.fullmatch(text.upper()):
        return text.upper()
    match = _CACHED_CODE_RE.fullmatch(text)
    if not match:
        raise ValueError(f"无效股票代码: {code!r}")
    exchange, digits = match.groups()
    return f"{digits}.{exchange.upper()}"


def calendar_windows(start, end, *, months_per_request=1):
    """Yield non-overlapping calendar windows within ``[start, end]``."""
    if not isinstance(start, datetime) or not isinstance(end, datetime):
        raise TypeError("start 和 end 必须是 datetime")
    if end < start:
        raise ValueError("end 不得早于 start")
    if (
        not isinstance(months_per_request, int)
        or isinstance(months_per_request, bool)
        or months_per_request < 1
    ):
        raise ValueError("months_per_request 必须是正整数")

    cursor = start
    while cursor <= end:
        final_month = cursor.month - 1 + months_per_request - 1
        final_year = cursor.year + final_month // 12
        final_month = final_month % 12 + 1
        last_day = monthrange(final_year, final_month)[1]
        window_end = datetime(final_year, final_month, last_day, 15, 0)
        yield cursor, min(window_end, end)

        next_month = cursor.month - 1 + months_per_request
        next_year = cursor.year + next_month // 12
        next_month = next_month % 12 + 1
        cursor = datetime(next_year, next_month, 1, 9, 30)


def month_windows(start, end):
    """Yield non-overlapping single-month windows within ``[start, end]``."""
    yield from calendar_windows(start, end, months_per_request=1)


def _numeric(row, field):
    try:
        value = float(row[field])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"分钟数据缺少有效的 {field}") from error
    if not math.isfinite(value):
        raise ValueError(f"分钟数据 {field} 不是有限值")
    return value


def normalize_rows(rows, expected_code):
    """Validate, de-duplicate, and sort a Tushare ``stk_mins`` response."""
    code = to_tushare_code(expected_code)
    normalized = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("分钟数据行必须是对象")
        if row.get("ts_code") != code:
            raise ValueError("分钟数据股票代码与请求不一致")
        time_text = str(row.get("trade_time") or "")
        try:
            datetime.strptime(time_text, _TIME_FORMAT)
        except ValueError as error:
            raise ValueError("分钟数据时间格式无效") from error

        item = {"ts_code": code, "trade_time": time_text}
        for field in ("open", "close", "high", "low", "vol", "amount"):
            item[field] = _numeric(row, field)
        if min(item["open"], item["close"], item["low"]) <= 0:
            raise ValueError("分钟 OHLC 必须为正数")
        if item["high"] < max(item["open"], item["close"]):
            raise ValueError("分钟 high 小于 open/close")
        if item["low"] > min(item["open"], item["close"]):
            raise ValueError("分钟 low 大于 open/close")
        if item["vol"] < 0 or item["amount"] < 0:
            raise ValueError("分钟成交量和成交额不得为负")
        existing = normalized.get(time_text)
        if existing is not None and existing != item:
            raise ValueError("同一时间存在不一致的分钟数据")
        normalized[time_text] = item
    return [normalized[key] for key in sorted(normalized)]


def _format_time(value):
    return value.strftime(_TIME_FORMAT)


def _validate_frequency(frequency):
    if not isinstance(frequency, str) or not _FREQUENCY_RE.fullmatch(frequency):
        raise ValueError("分钟频率仅支持 1/5/15/30/60min")
    return frequency


def month_cache_path(root, frequency, code, start):
    """Return a deterministic, lab-local cache path for one calendar month."""
    frequency = _validate_frequency(frequency)
    if not isinstance(root, (str, os.PathLike)) or not str(root):
        raise ValueError("缓存根目录不能为空")
    code = to_tushare_code(code)
    if not isinstance(start, datetime):
        raise TypeError("start 必须是 datetime")
    safe_code = code.replace(".", "_")
    return os.path.join(
        os.fspath(root),
        frequency,
        safe_code,
        f"{start:%Y-%m}.npz",
    )


def write_month_cache(path, *, frequency, code, start, end, rows):
    """Atomically persist a validated minute slice, including request metadata."""
    code = to_tushare_code(code)
    frequency = _validate_frequency(frequency)
    if not isinstance(start, datetime) or not isinstance(end, datetime):
        raise TypeError("start 和 end 必须是 datetime")
    if end < start:
        raise ValueError("end 不得早于 start")
    clean_rows = normalize_rows(rows, code)
    metadata = {
        "version": 1,
        "frequency": frequency,
        "code": code,
        "start": _format_time(start),
        "end": _format_time(end),
        "rows": len(clean_rows),
        "fields": list(MINUTE_FIELDS),
    }
    columns = {
        "trade_time": np.array(
            [row["trade_time"] for row in clean_rows],
            dtype="U19",
        ),
    }
    for field in ("open", "close", "high", "low", "vol", "amount"):
        columns[field] = np.array(
            [row[field] for row in clean_rows],
            dtype=np.float64,
        )

    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=".minute-",
        suffix=".npz",
        dir=directory,
    )
    os.close(descriptor)
    try:
        np.savez_compressed(
            temporary,
            metadata=np.array(json.dumps(metadata, sort_keys=True)),
            **columns,
        )
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def load_month_cache(
    path,
    *,
    expected_frequency,
    expected_code,
    expected_start,
    expected_end,
):
    """Load a cache file only when its metadata exactly matches the request."""
    code = to_tushare_code(expected_code)
    frequency = _validate_frequency(expected_frequency)
    if not isinstance(expected_start, datetime) or not isinstance(expected_end, datetime):
        raise TypeError("缓存边界必须是 datetime")
    with np.load(path, allow_pickle=False) as data:
        try:
            metadata = json.loads(str(data["metadata"].item()))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise ValueError("分钟缓存元数据损坏") from error
        required = ("trade_time", "open", "close", "high", "low", "vol", "amount")
        if any(field not in data.files for field in required):
            raise ValueError("分钟缓存缺少字段")
        expected = {
            "version": 1,
            "frequency": frequency,
            "code": code,
            "start": _format_time(expected_start),
            "end": _format_time(expected_end),
            "fields": list(MINUTE_FIELDS),
        }
        if any(metadata.get(key) != value for key, value in expected.items()):
            raise ValueError("分钟缓存元数据与当前请求不一致")
        size = len(data["trade_time"])
        if any(len(data[field]) != size for field in required):
            raise ValueError("分钟缓存列长度不一致")
        rows = []
        for index in range(size):
            rows.append(
                {
                    "ts_code": code,
                    "trade_time": str(data["trade_time"][index]),
                    **{
                        field: float(data[field][index])
                        for field in required[1:]
                    },
                }
            )
    rows = normalize_rows(rows, code)
    if metadata.get("rows") != len(rows):
        raise ValueError("分钟缓存行数不一致")
    return metadata, rows


def _sanitize_source_rows(rows, code):
    """Keep valid provider rows while retaining an auditable count of bad rows."""
    valid_rows = []
    rejected = []
    for row in rows:
        try:
            valid_rows.extend(normalize_rows([row], code))
        except ValueError as error:
            rejected.append(
                {
                    "trade_time": (
                        str(row.get("trade_time") or "")
                        if isinstance(row, dict)
                        else ""
                    ),
                    "reason": str(error),
                }
            )
    return normalize_rows(valid_rows, code), rejected


def _keep_qualified_days(clean_rows, rejected, minimum_valid_bars_per_day):
    """Exclude an affected day if it cannot provide a complete enough sequence."""
    if not minimum_valid_bars_per_day:
        return clean_rows, 0, 0
    rows_by_date = {}
    for row in clean_rows:
        rows_by_date.setdefault(row["trade_time"][:10], []).append(row)
    dates = set(rows_by_date)
    dates.update(
        item["trade_time"][:10]
        for item in rejected
        if item["trade_time"]
    )
    dropped_dates = {
        date
        for date in dates
        if len(rows_by_date.get(date, [])) < minimum_valid_bars_per_day
    }
    dropped_valid_rows = sum(
        len(rows_by_date.get(date, []))
        for date in dropped_dates
    )
    kept = [
        row
        for row in clean_rows
        if row["trade_time"][:10] not in dropped_dates
    ]
    return kept, len(dropped_dates), dropped_valid_rows


def download_month(
    client,
    *,
    root,
    frequency,
    code,
    start,
    end,
    allow_source_row_drops=False,
    max_source_row_drop_fraction=MAX_SOURCE_ROW_DROP_FRACTION,
    minimum_valid_bars_per_day=0,
    max_source_day_drop_fraction=0.0,
):
    """Fetch a missing monthly slice, or reuse a previously validated cache."""
    code = to_tushare_code(code)
    if (
        not isinstance(max_source_row_drop_fraction, (int, float))
        or isinstance(max_source_row_drop_fraction, bool)
        or not 0 <= max_source_row_drop_fraction <= 1
    ):
        raise ValueError("max_source_row_drop_fraction 必须在 0 到 1 之间")
    if (
        not isinstance(minimum_valid_bars_per_day, int)
        or isinstance(minimum_valid_bars_per_day, bool)
        or minimum_valid_bars_per_day < 0
    ):
        raise ValueError("minimum_valid_bars_per_day 必须是非负整数")
    if (
        not isinstance(max_source_day_drop_fraction, (int, float))
        or isinstance(max_source_day_drop_fraction, bool)
        or not 0 <= max_source_day_drop_fraction <= 1
    ):
        raise ValueError("max_source_day_drop_fraction 必须在 0 到 1 之间")
    path = month_cache_path(root, frequency, code, start)
    if os.path.exists(path):
        metadata, _rows = load_month_cache(
            path,
            expected_frequency=frequency,
            expected_code=code,
            expected_start=start,
            expected_end=end,
        )
        return {"status": "cached", "path": path, "rows": metadata["rows"]}

    rows = client.rows(
        "stk_mins",
        {
            "ts_code": code,
            "freq": frequency,
            "start_date": _format_time(start),
            "end_date": _format_time(end),
        },
        ",".join(MINUTE_FIELDS),
    )
    if allow_source_row_drops:
        clean_rows, rejected = _sanitize_source_rows(rows, code)
        dropped_rows = len(rejected)
        dropped_trading_days = 0
        if minimum_valid_bars_per_day:
            all_dates = {
                str(row.get("trade_time") or "")[:10]
                for row in rows
                if isinstance(row, dict) and row.get("trade_time")
            }
            clean_rows, dropped_trading_days, dropped_valid_rows = (
                _keep_qualified_days(
                    clean_rows,
                    rejected,
                    minimum_valid_bars_per_day,
                )
            )
            dropped_rows += dropped_valid_rows
            if (
                dropped_trading_days
                / max(1, len(all_dates))
                > max_source_day_drop_fraction
            ):
                raise ValueError(
                    "上游分钟异常交易日比例超过修复阈值: "
                    f"{dropped_trading_days}/{len(all_dates)}"
                )
        elif dropped_rows / max(1, len(rows)) > max_source_row_drop_fraction:
            raise ValueError(
                "上游分钟异常行比例超过修复阈值: "
                f"{dropped_rows}/{len(rows)}"
            )
    else:
        clean_rows = normalize_rows(rows, code)
        dropped_rows = 0
        dropped_trading_days = 0
    write_month_cache(
        path,
        frequency=frequency,
        code=code,
        start=start,
        end=end,
        rows=clean_rows,
    )
    return {
        "status": "repaired" if dropped_rows else "downloaded",
        "path": path,
        "rows": len(clean_rows),
        "dropped_rows": dropped_rows,
        "dropped_trading_days": dropped_trading_days,
    }


def download_universe(
    client,
    *,
    root,
    frequency,
    codes,
    start,
    end,
    months_per_request=1,
):
    """Download a universe sequentially and report every unresolved slice."""
    if not isinstance(codes, (list, tuple)) or not codes:
        raise ValueError("codes 必须是非空股票代码列表")
    normalized_codes = []
    seen = set()
    for raw_code in codes:
        code = to_tushare_code(raw_code)
        if code not in seen:
            normalized_codes.append(code)
            seen.add(code)

    summary = {
        "codes": len(normalized_codes),
        "requested_slices": 0,
        "completed_slices": 0,
        "downloaded_slices": 0,
        "cached_slices": 0,
        "repaired_slices": 0,
        "source_quality_dropped_rows": 0,
        "source_quality_dropped_trading_days": 0,
        "rows": 0,
        "failed_slices": [],
    }
    for code in normalized_codes:
        for window_start, window_end in calendar_windows(
            start,
            end,
            months_per_request=months_per_request,
        ):
            summary["requested_slices"] += 1
            try:
                result = download_month(
                    client,
                    root=root,
                    frequency=frequency,
                    code=code,
                    start=window_start,
                    end=window_end,
                )
            except Exception as error:  # noqa: BLE001
                error_message = str(error).strip()
                summary["failed_slices"].append(
                    {
                        "code": code,
                        "start": _format_time(window_start),
                        "end": _format_time(window_end),
                        "error_type": type(error).__name__,
                        "error_message": (
                            error_message[:240]
                            if error_message
                            else type(error).__name__
                        ),
                    }
                )
                continue
            summary["completed_slices"] += 1
            summary["rows"] += result["rows"]
            summary[f"{result['status']}_slices"] += 1
            summary["source_quality_dropped_rows"] += result.get(
                "dropped_rows",
                0,
            )
            summary["source_quality_dropped_trading_days"] += result.get(
                "dropped_trading_days",
                0,
            )
    return summary


def retry_failed_slices(
    client,
    *,
    root,
    frequency,
    report,
    allow_source_row_drops=False,
    minimum_valid_bars_per_day=0,
    max_source_day_drop_fraction=0.0,
):
    """Retry only unresolved slices and merge their outcomes into a report."""
    if not isinstance(report, dict):
        raise ValueError("report 必须是对象")
    failed_slices = report.get("failed_slices")
    if not isinstance(failed_slices, list):
        raise ValueError("report.failed_slices 必须是列表")

    summary = {
        "codes": int(report.get("codes", 0)),
        "requested_slices": int(report.get("requested_slices", 0)),
        "completed_slices": int(report.get("completed_slices", 0)),
        "downloaded_slices": int(report.get("downloaded_slices", 0)),
        "cached_slices": int(report.get("cached_slices", 0)),
        "repaired_slices": int(report.get("repaired_slices", 0)),
        "source_quality_dropped_rows": int(
            report.get("source_quality_dropped_rows", 0)
        ),
        "source_quality_dropped_trading_days": int(
            report.get("source_quality_dropped_trading_days", 0)
        ),
        "rows": int(report.get("rows", 0)),
        "failed_slices": [],
    }
    for failed in failed_slices:
        try:
            code = to_tushare_code(failed["code"])
            start = datetime.strptime(failed["start"], _TIME_FORMAT)
            end = datetime.strptime(failed["end"], _TIME_FORMAT)
            result = download_month(
                client,
                root=root,
                frequency=frequency,
                code=code,
                start=start,
                end=end,
                allow_source_row_drops=allow_source_row_drops,
                minimum_valid_bars_per_day=minimum_valid_bars_per_day,
                max_source_day_drop_fraction=max_source_day_drop_fraction,
            )
        except Exception as error:  # noqa: BLE001
            error_message = str(error).strip()
            summary["failed_slices"].append(
                {
                    "code": failed.get("code"),
                    "start": failed.get("start"),
                    "end": failed.get("end"),
                    "error_type": type(error).__name__,
                    "error_message": (
                        error_message[:240]
                        if error_message
                        else type(error).__name__
                    ),
                }
            )
            continue
        summary["completed_slices"] += 1
        summary["rows"] += result["rows"]
        summary[f"{result['status']}_slices"] += 1
        summary["source_quality_dropped_rows"] += result.get(
            "dropped_rows",
            0,
        )
        summary["source_quality_dropped_trading_days"] += result.get(
            "dropped_trading_days",
            0,
        )
    return summary


def expand_failed_slices_by_month(failed_slices):
    """Expand unresolved multi-month windows into deterministic month slices."""
    if not isinstance(failed_slices, list):
        raise ValueError("failed_slices 必须是列表")
    expanded = []
    for failed in failed_slices:
        if not isinstance(failed, dict):
            raise ValueError("failed_slices 元素必须是对象")
        code = to_tushare_code(failed.get("code"))
        try:
            start = datetime.strptime(failed["start"], _TIME_FORMAT)
            end = datetime.strptime(failed["end"], _TIME_FORMAT)
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("failed_slices 时间边界无效") from error
        for window_start, window_end in month_windows(start, end):
            expanded.append(
                {
                    "code": code,
                    "start": _format_time(window_start),
                    "end": _format_time(window_end),
                    "parent_start": _format_time(start),
                    "parent_end": _format_time(end),
                }
            )
    return expanded


def validate_download_report_for_training(report, *, minimum_coverage=0.85):
    """Accept a report only when any exclusions are known source-quality defects."""
    if not isinstance(report, dict):
        raise ValueError("report 必须是对象")
    if not isinstance(minimum_coverage, (int, float)):
        raise ValueError("minimum_coverage 必须是数字")
    requested = report.get("requested_slices")
    completed = report.get("completed_slices")
    failed_slices = report.get("failed_slices")
    dropped_rows = report.get("source_quality_dropped_rows", 0)
    if (
        not isinstance(requested, int)
        or not isinstance(completed, int)
        or not isinstance(failed_slices, list)
        or not isinstance(dropped_rows, int)
        or requested < 1
        or not 0 <= completed <= requested
        or dropped_rows < 0
    ):
        raise ValueError("分钟下载报告字段无效")

    unknown = [
        item
        for item in failed_slices
        if not (
            isinstance(item, dict)
            and item.get("error_type") == "ValueError"
            and item.get("error_message") in _SOURCE_QUALITY_ERRORS
        )
    ]
    coverage = completed / requested
    if unknown:
        raise ValueError("分钟下载包含非数据质量类失败，拒绝训练")
    if coverage < minimum_coverage:
        raise ValueError("分钟下载覆盖率低于训练门槛")
    if completed + len(failed_slices) != requested:
        raise ValueError("分钟下载报告切片计数不一致")
    return {
        "requested_slices": requested,
        "completed_slices": completed,
        "coverage": coverage,
        "source_quality_exclusions": len(failed_slices),
        "source_quality_dropped_rows": dropped_rows,
    }
