"""Minimal read-only probes for independent V2.1 Tushare inputs."""

import argparse
import json
import os
from datetime import datetime, timedelta

from tushare_client import TushareClient


def _calendar_date(value):
    parsed = datetime.strptime(str(value), "%Y%m%d")
    return parsed.strftime("%Y-%m-%d")


def _spec(
    probe_id,
    api_name,
    params,
    fields,
    *,
    availability,
    research_use,
    max_expected_rows,
):
    return {
        "id": probe_id,
        "api_name": api_name,
        "params": params,
        "fields": fields,
        "availability": availability,
        "research_use": research_use,
        "max_expected_rows": max_expected_rows,
    }


def build_probe_plan(
    *,
    trade_date,
    stock_code="600519.SH",
    index_code="000300.SH",
    industry_code="881273.TI",
):
    """Return a bounded probe plan; no endpoint requests an unrestricted range."""
    day = _calendar_date(trade_date)
    minute_params = {
        "freq": "5min",
        "start_date": f"{day} 09:00:00",
        "end_date": f"{day} 15:30:00",
    }
    return [
        _spec(
            "stock_minutes",
            "stk_mins",
            {"ts_code": stock_code, **minute_params},
            "ts_code,trade_time,open,close,high,low,vol,amount",
            availability="historical",
            research_use="existing_v21_baseline",
            max_expected_rows=64,
        ),
        _spec(
            "index_minutes_via_stock_api",
            "stk_mins",
            {"ts_code": index_code, **minute_params},
            "ts_code,trade_time,open,close,high,low,vol,amount",
            availability="experimental",
            research_use="probe_only",
            max_expected_rows=64,
        ),
        _spec(
            "index_minutes_realtime",
            "rt_idx_min",
            {"ts_code": index_code, "freq": "5MIN"},
            "ts_code,time,open,close,high,low,vol,amount",
            availability="current_session_only",
            research_use="forward_collection_only",
            max_expected_rows=64,
        ),
        _spec(
            "stock_moneyflow",
            "moneyflow",
            {"ts_code": stock_code, "trade_date": trade_date},
            "ts_code,trade_date,buy_lg_amount,sell_lg_amount,"
            "buy_elg_amount,sell_elg_amount,net_mf_amount",
            availability="after_close",
            research_use="pilot_lagged",
            max_expected_rows=1,
        ),
        _spec(
            "industry_catalog",
            "ths_index",
            {"exchange": "A", "type": "I"},
            "ts_code,name,count,exchange,list_date,type",
            availability="reference",
            research_use="recent_membership_mapping",
            max_expected_rows=5000,
        ),
        _spec(
            "industry_daily",
            "ths_daily",
            {"ts_code": industry_code, "trade_date": trade_date},
            "ts_code,trade_date,open,high,low,close,pct_change,vol,"
            "turnover_rate,total_mv,float_mv",
            availability="after_close",
            research_use="pilot_lagged",
            max_expected_rows=1,
        ),
        _spec(
            "industry_moneyflow_ths",
            "moneyflow_ind_ths",
            {"ts_code": industry_code, "trade_date": trade_date},
            "trade_date,ts_code,industry,pct_change,net_buy_amount,"
            "net_sell_amount,net_amount",
            availability="after_close",
            research_use="pilot_lagged",
            max_expected_rows=1,
        ),
        _spec(
            "industry_moneyflow_dc",
            "moneyflow_ind_dc",
            {"trade_date": trade_date, "content_type": "行业"},
            "trade_date,content_type,ts_code,name,pct_change,net_amount,"
            "net_amount_rate,rank",
            availability="after_close",
            research_use="pilot_lagged",
            max_expected_rows=5000,
        ),
        _spec(
            "market_moneyflow",
            "moneyflow_mkt_dc",
            {"trade_date": trade_date},
            "trade_date,close_sh,pct_change_sh,close_sz,pct_change_sz,"
            "net_amount,net_amount_rate,buy_elg_amount_rate",
            availability="after_close",
            research_use="pilot_lagged",
            max_expected_rows=1,
        ),
        _spec(
            "opening_auction",
            "stk_auction",
            {"ts_code": stock_code, "trade_date": trade_date, "ts_type": "STK"},
            "ts_code,trade_date,vol,price,amount,pre_close,turnover_rate,"
            "volume_ratio,float_share",
            availability="from_09_26",
            research_use="pilot_same_day",
            max_expected_rows=1,
        ),
        _spec(
            "closing_auction",
            "stk_auction_c",
            {"ts_code": stock_code, "trade_date": trade_date},
            "ts_code,trade_date,close,open,high,low,vol,amount,vwap",
            availability="after_close",
            research_use="label_diagnostics_only",
            max_expected_rows=1,
        ),
    ]


def _failure_status(error):
    message = str(error).lower()
    if any(word in message for word in ("权限", "积分", "permission", "forbidden")):
        return "permission_denied", "当前账号未开通该接口或积分不足"
    if any(word in message for word in ("频率", "每分钟", "limit", "429")):
        return "rate_limited", "接口限频，稍后可重试"
    return "failed", "接口调用失败"


def run_probe_plan(client, plan):
    """Execute probes independently so one denied endpoint cannot hide others."""
    result = {}
    for spec in plan:
        item = {
            "api": spec["api_name"],
            "availability": spec["availability"],
            "research_use": spec["research_use"],
        }
        try:
            rows = client.rows(
                spec["api_name"],
                spec["params"],
                spec["fields"],
            )
        except Exception as error:  # noqa: BLE001
            status, detail = _failure_status(error)
            result[spec["id"]] = {
                **item,
                "status": status,
                "detail": detail,
            }
            continue
        if not rows:
            result[spec["id"]] = {
                **item,
                "status": "empty",
                "rows": 0,
            }
            continue
        result[spec["id"]] = {
            **item,
            "status": "available",
            "rows": len(rows),
            "fields": sorted(rows[0].keys()),
        }
    return result


def main():
    default_date = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")
    parser = argparse.ArgumentParser(
        description="小范围探测 V2.1 可用的 Tushare 独立数据",
    )
    parser.add_argument("--trade-date", default=default_date)
    parser.add_argument("--stock-code", default="600519.SH")
    parser.add_argument("--index-code", default="000300.SH")
    parser.add_argument("--industry-code", default="881273.TI")
    args = parser.parse_args()
    if not os.environ.get("TUSHARE_TOKEN"):
        print(json.dumps({
            "status": "missing_token",
            "detail": "请通过环境变量 TUSHARE_TOKEN 临时注入，探针不会打印或保存 Token",
        }, ensure_ascii=False, indent=2))
        return 2
    plan = build_probe_plan(
        trade_date=args.trade_date,
        stock_code=args.stock_code,
        index_code=args.index_code,
        industry_code=args.industry_code,
    )
    result = run_probe_plan(TushareClient(max_per_min=30), plan)
    print(json.dumps({
        "status": "completed",
        "trade_date": args.trade_date,
        "probes": result,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
