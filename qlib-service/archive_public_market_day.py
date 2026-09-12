"""Archive one completed A-share market day without credentialed data APIs."""

import argparse
import concurrent.futures
import datetime as dt
import json
import math
import re
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

from opportunity_market_archive import (
    build_market_day_artifact,
    latest_market_day_before,
    load_market_day,
    market_close_ms,
    publish_market_days,
    select_causal_universe,
)
from opportunity_pattern_snapshot import refresh_strategy_pattern_snapshot
from model_lib import _oss_bucket
from decision_engine.data.fuyao import (
    fetch_full_snapshot as fetch_fuyao_market_snapshot,
)
from tickflow_data import (
    fetch_daily as fetch_tickflow_daily,
    fetch_minutes as fetch_tickflow_minutes,
)


EASTMONEY_REALTIME_HOSTS = (
    "https://push2.eastmoney.com",
    "https://82.push2.eastmoney.com",
    "https://48.push2.eastmoney.com",
    "https://push2delay.eastmoney.com",
)
EASTMONEY_HISTORY_HOSTS = (
    "https://push2his.eastmoney.com",
    "https://82.push2his.eastmoney.com",
    "https://45.push2his.eastmoney.com",
    "https://49.push2his.eastmoney.com",
    "https://28.push2his.eastmoney.com",
    "https://33.push2his.eastmoney.com",
    "https://48.push2his.eastmoney.com",
)
TENCENT_HISTORY_HOST = "https://ifzq.gtimg.cn"
MARKET_FILTER = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
MARKET_FIELDS = (
    "f2,f3,f5,f6,f8,f10,f12,f14,f15,f16,f17,f18,"
    "f20,f21,f62,f84,f184,f124"
)
PAGE_SIZE = 100
MAX_PAGES = 80
CODE_PATTERN = re.compile(r"^\d{6}$")
MARKET_ARCHIVE_SETTLE_MS = 10 * 60 * 1000
HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Referer": "https://quote.eastmoney.com/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
    ),
}


def _number(value):
    if value in (None, "", "-") or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _json(url, *, timeout=12):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "ignore"))


def _first_json(hosts, path, *, timeout=12):
    last_error = None
    for host in hosts:
        try:
            return _json(host + path, timeout=timeout)
        except Exception as error:
            last_error = error
    raise last_error or RuntimeError("公开行情镜像不可用")


def _secid(code):
    return f"{'1' if re.match(r'^(6|9|5)', code) else '0'}.{code}"


def _tencent_code(code):
    if re.match(r"^(4|8|92)", code):
        return "bj" + code
    return ("sh" if re.match(r"^(6|9|5)", code) else "sz") + code


def _trade_date(timestamp):
    value = _number(timestamp)
    if value is None or value <= 0:
        return None
    return dt.datetime.fromtimestamp(
        value,
        tz=ZoneInfo("Asia/Shanghai"),
    ).strftime("%Y%m%d")


def market_page_path(page):
    return (
        f"/api/qt/clist/get?pn={int(page)}&pz={PAGE_SIZE}"
        "&po=0&np=1&fltt=2&invt=2&fid=f12"
        f"&fs={urllib.parse.quote(MARKET_FILTER)}"
        f"&fields={MARKET_FIELDS}"
    )


def fetch_market_snapshot(
    *,
    fetch_page=None,
    fetch_fuyao=None,
    fetch_tickflow=None,
    workers=6,
):
    load_page = fetch_page or (
        lambda page: _first_json(
            EASTMONEY_REALTIME_HOSTS,
            market_page_path(page),
        )
    )
    first = load_page(1)
    total = int((first.get("data") or {}).get("total") or 0)
    page_count = math.ceil(total / PAGE_SIZE)
    if total < 800 or not 1 <= page_count <= MAX_PAGES:
        raise ValueError("公开源全市场股票总数异常")
    payloads = {1: first}
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=max(1, min(int(workers), 12)),
    ) as executor:
        futures = {
            executor.submit(load_page, page): page
            for page in range(2, page_count + 1)
        }
        for future in concurrent.futures.as_completed(futures):
            payloads[futures[future]] = future.result()
    raw_rows = []
    for page in range(1, page_count + 1):
        rows = (payloads[page].get("data") or {}).get("diff")
        expected = (
            PAGE_SIZE
            if page < page_count
            else total - PAGE_SIZE * (page_count - 1)
        )
        if not isinstance(rows, list) or len(rows) < expected:
            raise ValueError(f"公开源全市场第{page}页不完整")
        raw_rows.extend(rows)
    unique = {
        str(row.get("f12") or ""): row
        for row in raw_rows
        if CODE_PATTERN.fullmatch(str(row.get("f12") or ""))
    }
    if len(unique) != total:
        raise ValueError(f"公开源全市场快照不完整: {len(unique)}/{total}")
    dates = [
        value
        for value in (_trade_date(row.get("f124")) for row in unique.values())
        if value
    ]
    if not dates:
        raise ValueError("公开源全市场快照缺少交易日期")
    target = max(set(dates), key=dates.count)
    daily = []
    funds = []
    for code in sorted(unique):
        row = unique[code]
        if _trade_date(row.get("f124")) != target:
            continue
        close = _number(row.get("f2"))
        open_price = _number(row.get("f17"))
        high = _number(row.get("f15"))
        low = _number(row.get("f16"))
        if (
            close is None
            or open_price is None
            or high is None
            or low is None
            or min(close, open_price, low) <= 0
            or high < max(open_price, close)
            or low > min(open_price, close)
        ):
            continue
        daily.append({
            "date": target,
            "code": code,
            "name": str(row.get("f14") or code),
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "preClose": _number(row.get("f18")),
            "volume": (_number(row.get("f5")) or 0.0) * 100,
            "amount": _number(row.get("f6")) or 0.0,
            "turnover": _number(row.get("f8")),
            "volumeRatio": _number(row.get("f10")),
            "floatShare": (
                (_number(row.get("f21")) or 0.0) / close
                if close and close > 0
                else None
            ),
            "isSt": bool(re.search(
                r"(?:\*?ST|退)",
                str(row.get("f14") or ""),
                re.IGNORECASE,
            )),
        })
        main = _number(row.get("f62"))
        retail = _number(row.get("f84"))
        if main is not None and retail is not None:
            funds.append({
                "date": target,
                "code": code,
                "mainNetYi": round(main / 1e8, 6),
                "retailNetYi": round(retail / 1e8, 6),
                "mainRatio": _number(row.get("f184")),
            })
    if len(daily) < 800 or len(funds) < 500:
        raise ValueError("公开源日线或资金流覆盖不足")
    tickflow_loader = fetch_tickflow or (
        lambda codes, date: fetch_tickflow_daily(
            codes,
            date,
            workers=workers,
        )
    )
    try:
        tickflow_rows = tickflow_loader(
            [row["code"] for row in daily],
            target,
        )
    except Exception:
        tickflow_rows = {}
    tickflow_complete = (
        isinstance(tickflow_rows, dict)
        and len(tickflow_rows) / len(daily) >= 0.85
    )
    if tickflow_complete:
        for row in daily:
            bars = tickflow_rows.get(row["code"])
            source = bars[-1] if isinstance(bars, list) and bars else None
            if not source:
                continue
            for key in ("open", "high", "low", "close", "volume", "amount"):
                if source.get(key) is not None:
                    row[key] = source[key]
        return {
            "date": target,
            "daily": daily,
            "funds": funds,
            "priceSource": "TICKFLOW",
        }
    fuyao_loader = fetch_fuyao or (
        lambda: fetch_fuyao_market_snapshot(workers=workers)
    )
    try:
        fuyao = fuyao_loader()
    except Exception:
        fuyao = None
    fuyao_rows = (
        fuyao.get("rows")
        if isinstance(fuyao, dict)
        and fuyao.get("date") == target
        and float(fuyao.get("coverage") or 0) >= 0.85
        else None
    )
    if isinstance(fuyao_rows, dict):
        for row in daily:
            source = fuyao_rows.get(row["code"])
            if not source:
                continue
            for key in (
                "open",
                "high",
                "low",
                "close",
                "preClose",
                "volume",
                "amount",
            ):
                if source.get(key) is not None:
                    row[key] = source[key]
    return {
        "date": target,
        "daily": daily,
        "funds": funds,
        "priceSource": (
            "THS_FUYAO"
            if isinstance(fuyao_rows, dict)
            else "EASTMONEY"
        ),
    }


def _normalize_minute_lines(lines, code, date):
    bars = {}
    for line in lines if isinstance(lines, list) else []:
        values = line if isinstance(line, list) else str(line).split(",")
        stamp = re.sub(r"\D", "", str(values[0] if values else ""))
        if len(stamp) == 12:
            stamp += "00"
        if len(values) < 6 or len(stamp) != 14 or not stamp.startswith(date):
            continue
        open_price, close, high, low = (
            _number(values[index]) for index in range(1, 5)
        )
        volume = _number(values[5])
        amount = _number(values[6]) if len(values) > 6 else 0.0
        if (
            min(open_price or 0, close or 0, low or 0) <= 0
            or high is None
            or high < max(open_price, close)
            or low > min(open_price, close)
            or volume is None
            or volume < 0
        ):
            continue
        bars[stamp] = {
            "date": stamp,
            "code": code,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
            "amount": max(0.0, amount or 0.0),
            "pre_close": None,
        }
    ordered = [bars[key] for key in sorted(bars)]
    return ordered if 45 <= len(ordered) <= 60 else []


def fetch_public_minute_day(code, date, *, fetch_json=None):
    loader = fetch_json or _json
    path = (
        f"/api/qt/stock/kline/get?secid={_secid(code)}"
        "&fields1=f1,f2,f3,f4,f5,f6"
        "&fields2=f51,f52,f53,f54,f55,f56,f57,f58"
        f"&klt=5&fqt=0&beg={date}&end={date}&lmt=66"
    )
    for host in EASTMONEY_HISTORY_HOSTS:
        try:
            payload = loader(host + path)
            rows = ((payload.get("data") or {}).get("klines") or [])
            bars = _normalize_minute_lines(rows, code, date)
            if bars:
                return bars
        except Exception:
            continue
    symbol = _tencent_code(code)
    try:
        payload = loader(
            TENCENT_HISTORY_HOST
            + f"/appstock/app/kline/mkline?param={symbol},m5,,240"
        )
        rows = ((payload.get("data") or {}).get(symbol) or {}).get("m5")
        return _normalize_minute_lines(rows, code, date)
    except Exception:
        return []


def archive_latest_public(
    *,
    target_bucket=None,
    snapshot_loader=fetch_market_snapshot,
    minute_loader=fetch_public_minute_day,
    batch_minute_loader=None,
    universe_size=1000,
    workers=12,
    now_ms=None,
):
    target_bucket = target_bucket or _oss_bucket()
    if target_bucket is None:
        raise RuntimeError("市场归档OSS未配置")
    snapshot = snapshot_loader()
    target = snapshot["date"]
    existing = load_market_day(target_bucket, target)
    if existing is not None:
        pattern_manifest = refresh_strategy_pattern_snapshot(target_bucket)
        return {
            "status": "already_archived",
            "date": target,
            "source": existing.get("source"),
            "summary": existing["summary"],
            "universe": existing["universe"],
            "patternSnapshot": pattern_manifest["summary"],
        }
    previous = latest_market_day_before(target_bucket, target)
    current_ms = int(
        now_ms
        if now_ms is not None
        else dt.datetime.now(tz=dt.timezone.utc).timestamp() * 1000
    )
    if current_ms < market_close_ms(target) + MARKET_ARCHIVE_SETTLE_MS:
        return {
            "status": "market_open_skipped",
            "date": target,
            "latestArchiveDate": (
                previous.get("date")
                if isinstance(previous, dict)
                else None
            ),
            "reason": "目标交易日尚未收盘，继续使用最新完整OSS归档",
        }
    if previous is None:
        raise ValueError("公开源归档缺少前一交易日因果股票池")
    universe = select_causal_universe(
        previous["daily"],
        target,
        limit=universe_size,
    )
    if len(universe) < universe_size:
        raise ValueError(f"公开源因果股票池不足: {len(universe)}/{universe_size}")
    load_tickflow_minutes = batch_minute_loader or (
        lambda codes, date: fetch_tickflow_minutes(
            codes,
            date,
            workers=min(int(workers), 5),
        )
    )
    try:
        minutes = load_tickflow_minutes(universe, target)
    except Exception:
        minutes = {}
    if not isinstance(minutes, dict):
        minutes = {}
    tickflow_minute_codes = len(minutes)
    if tickflow_minute_codes:
        print(json.dumps({
            "stage": "TICKFLOW_MINUTE_BATCH",
            "progress": len(universe),
            "total": len(universe),
            "complete": tickflow_minute_codes,
        }), flush=True)
    missing_codes = [code for code in universe if code not in minutes]
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=max(1, min(int(workers), 20)),
    ) as executor:
        futures = {
            executor.submit(minute_loader, code, target): code
            for code in missing_codes
        }
        for completed, future in enumerate(
            concurrent.futures.as_completed(futures),
            1,
        ):
            code = futures[future]
            try:
                bars = future.result()
            except Exception:
                bars = []
            if bars:
                minutes[code] = bars
            if completed == 1 or completed % 100 == 0:
                print(json.dumps({
                    "stage": "PUBLIC_MINUTE_CODE",
                    "progress": completed,
                    "total": len(missing_codes),
                    "complete": len(minutes),
                }), flush=True)
    preclose = {
        row["code"]: row.get("preClose")
        for row in snapshot["daily"]
    }
    for code, bars in minutes.items():
        for bar in bars:
            bar["pre_close"] = preclose.get(code)
    uses_tickflow = (
        snapshot.get("priceSource") == "TICKFLOW"
        or tickflow_minute_codes > 0
    )
    artifact = build_market_day_artifact(
        date=target,
        daily=snapshot["daily"],
        funds=snapshot["funds"],
        minutes={"date": target, "codes": minutes},
        source=(
            "TICKFLOW_EM_TENCENT_DAILY_INCREMENT"
            if uses_tickflow
            else (
                "THS_FUYAO_EM_TENCENT_DAILY_INCREMENT"
                if snapshot.get("priceSource") == "THS_FUYAO"
                else "EASTMONEY_TENCENT_DAILY_INCREMENT"
            )
        ),
        universe_source_date=previous["date"],
        requested_codes=len(universe),
        generated_at=market_close_ms(target),
    )
    published = publish_market_days(target_bucket, [artifact])
    pattern_manifest = refresh_strategy_pattern_snapshot(
        target_bucket,
        published["manifest"],
    )
    return {
        "status": "published",
        "date": target,
        "source": artifact["source"],
        "entry": published["published"][0],
        "manifestSummary": published["manifest"]["summary"],
        "patternSnapshot": pattern_manifest["summary"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--universe-size", type=int, default=1000)
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()
    print(json.dumps(
        archive_latest_public(
            universe_size=args.universe_size,
            workers=args.workers,
        ),
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
