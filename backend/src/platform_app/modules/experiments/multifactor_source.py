"""Immutable point-in-time source archive for A-share multifactor features."""

from __future__ import annotations

import concurrent.futures
import gzip
import hashlib
import json
import math
import os
import time
from datetime import UTC, datetime
from pathlib import Path


SCHEMA_VERSION = "multifactor-source-archive.v2"
AUDIT_SCHEMA_VERSION = "multifactor-source-audit.v2"
DAILY_BASIC_FIELDS = (
    "ts_code,trade_date,pe_ttm,pb,ps_ttm,dv_ttm,total_mv,circ_mv"
)
INCOME_FIELDS = (
    "ts_code,ann_date,f_ann_date,end_date,report_type,comp_type,update_flag,"
    "revenue,total_revenue,n_income_attr_p"
)
BALANCE_FIELDS = (
    "ts_code,ann_date,f_ann_date,end_date,report_type,comp_type,update_flag,"
    "total_assets,total_liab,total_hldr_eqy_exc_min_int"
)
CASHFLOW_FIELDS = (
    "ts_code,ann_date,f_ann_date,end_date,report_type,comp_type,update_flag,"
    "n_cashflow_act"
)
DIVIDEND_FIELDS = (
    "ts_code,end_date,ann_date,div_proc,cash_div_tax,"
    "record_date,ex_date,pay_date"
)
INDUSTRY_FIELDS = "l1_code,l1_name,ts_code,name,in_date,out_date,is_new"
SOURCE_REQUESTS = {
    "income_vip": INCOME_FIELDS,
    "balancesheet_vip": BALANCE_FIELDS,
    "cashflow_vip": CASHFLOW_FIELDS,
}
PAGE_SIZE = 5000
MAXIMUM_PAGES = 100


def _date(value) -> str | None:
    text = "".join(char for char in str(value or "") if char.isdigit())[:8]
    if len(text) != 8:
        return None
    try:
        datetime.strptime(text, "%Y%m%d")
    except ValueError:
        return None
    return text


def _finite(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _canonical_bytes(value) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _write_gzip_json(path: Path, value) -> str:
    raw = _canonical_bytes(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as output:
        with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as stream:
            stream.write(raw)
    os.replace(temporary, path)
    return _file_sha256(path)


def read_source_partition(root: Path, source: str, key: str) -> list[dict]:
    path = root.expanduser().resolve() / "raw" / source / f"{key}.json.gz"
    try:
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            payload = json.load(stream)
    except (OSError, ValueError) as exc:
        raise ValueError(
            f"MULTIFACTOR_SOURCE_PARTITION_INVALID:{source}:{key}"
        ) from exc
    if (
        payload.get("schemaVersion") != SCHEMA_VERSION
        or payload.get("source") != source
        or payload.get("key") != key
        or not isinstance(payload.get("rows"), list)
    ):
        raise ValueError(
            f"MULTIFACTOR_SOURCE_PARTITION_INVALID:{source}:{key}"
        )
    return payload["rows"]


def source_rows(root: Path, source: str) -> list[dict]:
    rows = []
    for path in sorted(
        (root.expanduser().resolve() / "raw" / source).glob("*.json.gz")
    ):
        if path.name.startswith("._"):
            continue
        rows.extend(read_source_partition(root, source, path.name[:-8]))
    return rows


def financial_periods_for_dates(decision_dates: list[str]) -> list[str]:
    dates = sorted({_date(value) for value in decision_dates})
    if None in dates or not dates:
        raise ValueError("MULTIFACTOR_DECISION_DATES_INVALID")
    start_year = int(dates[0][:4]) - 3
    end_date = dates[-1]
    periods = []
    for year in range(start_year, int(end_date[:4]) + 1):
        for suffix in ("0331", "0630", "0930", "1231"):
            period = f"{year}{suffix}"
            if period <= end_date:
                periods.append(period)
    return periods


def _statement_events(rows: list[dict]) -> tuple[list[tuple], int]:
    versions: dict[tuple[str, str, str], list[dict]] = {}
    for source in rows:
        code = str(source.get("ts_code") or "").upper()
        period = _date(source.get("end_date"))
        available = _date(source.get("f_ann_date") or source.get("ann_date"))
        if (
            len(code) != 9
            or code[6] != "."
            or not code[:6].isdigit()
            or period is None
            or available is None
            or period > available
            or str(source.get("report_type") or "1") != "1"
        ):
            continue
        versions.setdefault((code, period, available), []).append(dict(source))

    events = []
    conflicts = 0
    for (code, period, available), candidates in versions.items():
        signatures = {
            tuple(
                sorted(
                    (key, value)
                    for key, value in candidate.items()
                    if key != "update_flag"
                )
            )
            for candidate in candidates
        }
        if len(signatures) > 1:
            conflicts += 1
            continue
        source = max(
            candidates,
            key=lambda row: (
                1 if str(row.get("update_flag") or "") == "1" else 0
            ),
        )
        events.append((available, code, period, source))
    return sorted(events, key=lambda item: item[:3]), conflicts


def _statement_value(row: dict | None, *fields: str) -> float | None:
    for field in fields:
        value = _finite((row or {}).get(field))
        if value is not None:
            return value
    return None


def _prior_period(period: str) -> str:
    return f"{int(period[:4]) - 1}{period[4:]}"


def _annual_period(period: str) -> str:
    return f"{int(period[:4]) - 1}1231"


def _ttm_value(rows: dict[str, dict], period: str, *fields: str) -> float | None:
    current = _statement_value(rows.get(period), *fields)
    if current is None:
        return None
    if period.endswith("1231"):
        return current
    annual = _statement_value(rows.get(_annual_period(period)), *fields)
    prior = _statement_value(rows.get(_prior_period(period)), *fields)
    if annual is None or prior is None:
        return None
    return annual + current - prior


def _growth(current: float | None, prior: float | None) -> float | None:
    if current is None or prior is None or prior <= 0:
        return None
    return (current / prior - 1) * 100


def _financial_metrics(
    income: dict[str, dict],
    balance: dict[str, dict],
    cashflow: dict[str, dict],
) -> dict | None:
    periods = sorted(set(income) & set(balance) & set(cashflow))
    if not periods:
        return None
    period = periods[-1]
    revenue = _ttm_value(income, period, "revenue", "total_revenue")
    net_profit = _ttm_value(income, period, "n_income_attr_p")
    operating_cash = _ttm_value(cashflow, period, "n_cashflow_act")
    assets = _statement_value(balance.get(period), "total_assets")
    liabilities = _statement_value(balance.get(period), "total_liab")
    equity = _statement_value(
        balance.get(period),
        "total_hldr_eqy_exc_min_int",
    )
    prior_equity = _statement_value(
        balance.get(_prior_period(period)),
        "total_hldr_eqy_exc_min_int",
    )
    average_equity = (
        (equity + prior_equity) / 2
        if equity is not None and prior_equity is not None
        else equity
    )
    current_revenue = _statement_value(
        income.get(period),
        "revenue",
        "total_revenue",
    )
    prior_revenue = _statement_value(
        income.get(_prior_period(period)),
        "revenue",
        "total_revenue",
    )
    current_profit = _statement_value(income.get(period), "n_income_attr_p")
    prior_profit = _statement_value(
        income.get(_prior_period(period)),
        "n_income_attr_p",
    )
    available_dates = [
        _date(table[period].get("f_ann_date") or table[period].get("ann_date"))
        for table in (income, balance, cashflow)
    ]
    return {
        "reportPeriod": period,
        "reportAvailableAt": max(
            value for value in available_dates if value is not None
        ),
        "roeWaa": (
            net_profit / average_equity * 100
            if net_profit is not None
            and average_equity is not None
            and average_equity > 0
            else None
        ),
        "netProfitMargin": (
            net_profit / revenue * 100
            if net_profit is not None and revenue is not None and revenue > 0
            else None
        ),
        "operatingCashToSales": (
            operating_cash / revenue * 100
            if operating_cash is not None and revenue is not None and revenue > 0
            else None
        ),
        "debtToAssets": (
            liabilities / assets * 100
            if liabilities is not None and assets is not None and assets > 0
            else None
        ),
        "netProfitYoY": _growth(current_profit, prior_profit),
        "revenueYoY": _growth(current_revenue, prior_revenue),
    }


def financial_metric_snapshots_for_dates(
    income_rows: list[dict],
    balance_rows: list[dict],
    cashflow_rows: list[dict],
    as_of_dates: list[str],
) -> dict[str, dict[str, dict]]:
    dates = sorted({_date(value) for value in as_of_dates})
    if None in dates:
        raise ValueError("MULTIFACTOR_FINANCIAL_AS_OF_INVALID")
    event_sets = [
        _statement_events(income_rows)[0],
        _statement_events(balance_rows)[0],
        _statement_events(cashflow_rows)[0],
    ]
    states: list[dict[str, dict[str, dict]]] = [{}, {}, {}]
    cursors = [0, 0, 0]
    current = {}
    snapshots = {}
    for cutoff in dates:
        changed = set()
        for source_index, events in enumerate(event_sets):
            while (
                cursors[source_index] < len(events)
                and events[cursors[source_index]][0] <= cutoff
            ):
                _available, code, period, row = events[cursors[source_index]]
                states[source_index].setdefault(code, {})[period] = row
                changed.add(code)
                cursors[source_index] += 1
        for code in changed:
            if all(code in state for state in states):
                metrics = _financial_metrics(
                    states[0][code],
                    states[1][code],
                    states[2][code],
                )
                if metrics is not None:
                    current[code] = metrics
                    continue
            current.pop(code, None)
        snapshots[cutoff] = dict(current)
    return snapshots


def industry_members_as_of(rows: list[dict], as_of_date: str) -> dict[str, str]:
    selected = {}
    for row in rows:
        code = str(row.get("ts_code") or "").upper()
        entered = _date(row.get("in_date"))
        exited = _date(row.get("out_date"))
        if not code or entered is None or entered > as_of_date:
            continue
        if exited is not None and exited < as_of_date:
            continue
        current = selected.get(code)
        if current is None or entered > current[0]:
            selected[code] = (entered, str(row.get("l1_name") or ""))
    return {code: value[1] for code, value in selected.items()}


def dividend_continuity_as_of(
    rows: list[dict],
    as_of_date: str,
) -> dict[str, float]:
    as_of_year = int(as_of_date[:4])
    years_by_code: dict[str, set[int]] = {}
    for row in rows:
        code = str(row.get("ts_code") or "").upper()
        period = _date(row.get("end_date"))
        ex_date = _date(row.get("ex_date"))
        if (
            not code
            or period is None
            or ex_date is None
            or ex_date > as_of_date
            or not as_of_year - 3 <= int(period[:4]) < as_of_year
            or (_finite(row.get("cash_div_tax")) or 0) <= 0
            or str(row.get("div_proc") or "")
            not in {"\u5b9e\u65bd", "\u5b9e\u65bd\u5b8c\u6210"}
        ):
            continue
        years_by_code.setdefault(code, set()).add(int(period[:4]))
    return {
        code: min(1.0, len(years) / 3)
        for code, years in years_by_code.items()
    }


def _fetch_partition(
    *,
    client,
    root: Path,
    source: str,
    key: str,
    params: dict,
    fields: str,
    maximum_attempts: int,
) -> dict:
    path = root / "raw" / source / f"{key}.json.gz"
    if path.is_file():
        try:
            with gzip.open(path, "rt", encoding="utf-8") as stream:
                payload = json.load(stream)
        except (OSError, ValueError):
            payload = None
        if (
            isinstance(payload, dict)
            and payload.get("schemaVersion") == SCHEMA_VERSION
            and payload.get("source") == source
            and payload.get("key") == key
            and payload.get("params") == params
            and payload.get("fields") == fields.split(",")
            and isinstance(payload.get("rows"), list)
        ):
            return {
                "source": source,
                "key": key,
                "path": str(path.relative_to(root)),
                "rows": len(payload["rows"]),
                "sha256": _file_sha256(path),
            }
    rows = []
    previous_page_hash = None
    for page in range(MAXIMUM_PAGES):
        request_params = dict(params)
        if source != "daily_basic":
            request_params.update({
                "limit": PAGE_SIZE,
                "offset": page * PAGE_SIZE,
            })
        for attempt in range(1, maximum_attempts + 1):
            try:
                page_rows = client.rows(source, request_params, fields)
                break
            except Exception as exc:
                if attempt == maximum_attempts:
                    raise ValueError(
                        "MULTIFACTOR_SOURCE_FETCH_FAILED:"
                        f"{source}:{key}:{exc}"
                    ) from exc
                time.sleep(min(30, 2 ** (attempt - 1)))
        page_hash = hashlib.sha256(_canonical_bytes(page_rows)).hexdigest()
        if page and page_hash == previous_page_hash:
            raise ValueError(
                f"MULTIFACTOR_SOURCE_PAGINATION_STALLED:{source}:{key}"
            )
        rows.extend(page_rows)
        if source == "daily_basic" or len(page_rows) != PAGE_SIZE:
            break
        previous_page_hash = page_hash
    else:
        raise ValueError(
            f"MULTIFACTOR_SOURCE_PAGINATION_LIMIT:{source}:{key}"
        )
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "source": source,
        "key": key,
        "params": params,
        "fields": fields.split(","),
        "rows": rows,
    }
    digest = _write_gzip_json(path, payload)
    return {
        "source": source,
        "key": key,
        "path": str(path.relative_to(root)),
        "rows": len(rows),
        "sha256": digest,
    }


def _requests(decision_dates: list[str], financial_periods: list[str]) -> list[dict]:
    requests = [
        {
            "source": "daily_basic",
            "key": trade_date,
            "params": {"trade_date": trade_date},
            "fields": DAILY_BASIC_FIELDS,
        }
        for trade_date in decision_dates
    ]
    for source, fields in SOURCE_REQUESTS.items():
        requests.extend(
            {
                "source": source,
                "key": period,
                "params": {"period": period},
                "fields": fields,
            }
            for period in financial_periods
        )
    requests.extend(
        {
            "source": "dividend",
            "key": period,
            "params": {"end_date": period},
            "fields": DIVIDEND_FIELDS,
        }
        for period in financial_periods
    )
    requests.append({
        "source": "index_member_all",
        "key": "all",
        "params": {},
        "fields": INDUSTRY_FIELDS,
    })
    return requests


def build_multifactor_source_archive(
    *,
    client,
    output_root,
    decision_dates: list[str],
    financial_periods: list[str] | None = None,
    workers: int = 1,
    maximum_attempts: int = 5,
    on_progress=lambda _event: None,
) -> dict:
    root = Path(output_root).expanduser().resolve()
    dates = sorted({_date(value) for value in decision_dates})
    periods = sorted(
        {
            _date(value)
            for value in (
                financial_periods
                if financial_periods is not None
                else financial_periods_for_dates(decision_dates)
            )
        }
    )
    if None in dates or not dates:
        raise ValueError("MULTIFACTOR_DECISION_DATES_INVALID")
    if None in periods or not periods:
        raise ValueError("MULTIFACTOR_FINANCIAL_PERIODS_INVALID")
    if workers < 1 or workers > 8:
        raise ValueError("MULTIFACTOR_WORKERS_INVALID")
    if maximum_attempts < 1 or maximum_attempts > 10:
        raise ValueError("MULTIFACTOR_MAXIMUM_ATTEMPTS_INVALID")

    manifest_path = root / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        if (
            manifest.get("schemaVersion") != SCHEMA_VERSION
            or manifest.get("decisionDates") != dates
            or manifest.get("financialPeriods") != periods
        ):
            raise ValueError("MULTIFACTOR_SOURCE_ARCHIVE_ALREADY_SEALED")
        audit_multifactor_source_archive(
            root,
            expected_decision_dates=dates,
            expected_financial_periods=periods,
        )
        return manifest

    requests = _requests(dates, periods)

    def fetch(request):
        result = _fetch_partition(
            client=client,
            root=root,
            maximum_attempts=maximum_attempts,
            **request,
        )
        on_progress(result)
        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        partitions = list(executor.map(fetch, requests))
    partitions.sort(key=lambda item: (item["source"], item["key"]))
    identity = {
        "schemaVersion": SCHEMA_VERSION,
        "decisionDates": dates,
        "financialPeriods": periods,
        "partitions": partitions,
    }
    manifest = {
        **identity,
        "createdAt": datetime.now(UTC).isoformat(),
        "partitionCount": len(partitions),
        "rowCount": sum(item["rows"] for item in partitions),
        "contentSha256": hashlib.sha256(_canonical_bytes(identity)).hexdigest(),
    }
    root.mkdir(parents=True, exist_ok=True)
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_bytes(_canonical_bytes(manifest) + b"\n")
    os.replace(temporary, manifest_path)
    return manifest


def audit_multifactor_source_archive(
    output_root,
    *,
    expected_decision_dates: list[str] | None = None,
    expected_financial_periods: list[str] | None = None,
) -> dict:
    root = Path(output_root).expanduser().resolve()
    try:
        manifest = json.loads((root / "manifest.json").read_text())
    except (OSError, ValueError) as exc:
        raise ValueError("MULTIFACTOR_SOURCE_MANIFEST_INVALID") from exc
    identity = {
        key: manifest.get(key)
        for key in (
            "schemaVersion",
            "decisionDates",
            "financialPeriods",
            "partitions",
        )
    }
    if (
        manifest.get("schemaVersion") != SCHEMA_VERSION
        or hashlib.sha256(_canonical_bytes(identity)).hexdigest()
        != manifest.get("contentSha256")
    ):
        raise ValueError("MULTIFACTOR_SOURCE_MANIFEST_INVALID")

    declared_dates = manifest.get("decisionDates")
    declared_periods = manifest.get("financialPeriods")
    expected_requests = _requests(declared_dates, declared_periods)
    expected_keys = {
        (item["source"], item["key"]) for item in expected_requests
    }
    declared_keys = {
        (item.get("source"), item.get("key"))
        for item in manifest.get("partitions", [])
    }
    blockers = []
    if declared_keys != expected_keys:
        blockers.append("SOURCE_PARTITION_COVERAGE_MISMATCH")
    if (
        expected_decision_dates is not None
        and not set(_date(value) for value in expected_decision_dates).issubset(
            declared_dates
        )
    ):
        blockers.append("SOURCE_DECISION_DATE_COVERAGE_MISMATCH")
    if (
        expected_financial_periods is not None
        and not set(_date(value) for value in expected_financial_periods).issubset(
            declared_periods
        )
    ):
        blockers.append("SOURCE_FINANCIAL_PERIOD_COVERAGE_MISMATCH")

    source_stats = {}
    statement_rows = {source: [] for source in SOURCE_REQUESTS}
    partition_hashes_valid = True
    for partition in manifest.get("partitions", []):
        source = str(partition.get("source") or "")
        key = str(partition.get("key") or "")
        path = root / str(partition.get("path") or "")
        if not path.is_file() or _file_sha256(path) != partition.get("sha256"):
            partition_hashes_valid = False
            continue
        rows = read_source_partition(root, source, key)
        stats = source_stats.setdefault(source, {"partitions": 0, "rows": 0})
        stats["partitions"] += 1
        stats["rows"] += len(rows)
        if source in statement_rows:
            statement_rows[source].extend(rows)
    if not partition_hashes_valid:
        blockers.append("SOURCE_PARTITION_HASH_MISMATCH")

    conflict_count = 0
    for source, rows in statement_rows.items():
        _events, conflicts = _statement_events(rows)
        missing_dates = sum(
            _date(row.get("f_ann_date") or row.get("ann_date")) is None
            for row in rows
        )
        source_stats.setdefault(source, {"partitions": 0, "rows": 0}).update({
            "missingPublicationRows": missing_dates,
            "conflictingPointInTimeKeys": conflicts,
        })
        conflict_count += conflicts
        if missing_dates:
            blockers.append("FINANCIAL_STATEMENT_PUBLICATION_DATE_MISSING")
    return {
        "schemaVersion": AUDIT_SCHEMA_VERSION,
        "archiveSchemaVersion": manifest["schemaVersion"],
        "contentSha256": manifest["contentSha256"],
        "partitionHashesValid": partition_hashes_valid,
        "sources": source_stats,
        "state": "READY" if not blockers else "RESEARCH",
        "productionEligible": not blockers,
        "blockers": sorted(set(blockers)),
        "warnings": (
            ["FINANCIAL_STATEMENT_CONFLICTING_KEYS_EXCLUDED"]
            if conflict_count
            else []
        ),
        "excludedConflictingStatementKeys": conflict_count,
    }
