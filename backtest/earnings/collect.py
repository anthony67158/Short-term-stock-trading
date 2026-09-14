"""Manual earnings evidence export. Existing Tushare gateway and CNINFO only.

Contracts: tushare.pro/document/2?doc_id=45,46,176 and api/_pre_catalyst_data.js.
No market returns, credentials or production account data are written.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "qlib-service"))
from tushare_client import TushareClient

FIELDS = ("ts_code,ann_date,end_date,type,p_change_min,p_change_max,"
          "net_profit_min,net_profit_max,last_parent_net,first_ann_date,summary,change_reason")
CNINFO = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
SHANGHAI = dt.timezone(dt.timedelta(hours=8))


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def store(output, label, value):
    raw = encode(value)
    name = f"{label}-{sha(raw)}.json"
    target = output / name
    if not target.exists():
        target.write_bytes(raw)
    return {"file": name, "sha256": sha(raw)}


def load(output, reference):
    raw = (output / reference["file"]).read_bytes()
    if sha(raw) != reference["sha256"]:
        raise ValueError("CHECKSUM_MISMATCH")
    return json.loads(raw)


def choose_samples(rows, spec):
    groups = {}
    for row in rows:
        key = (row.get("ts_code"), row.get("end_date"))
        groups.setdefault(key, []).append(row)
    samples = []
    for period in spec["periods"]:
        candidates = []
        for (code, end), versions in groups.items():
            if end != period or not any(re.fullmatch(p, code or "") for p in spec["mainBoardPatterns"]):
                continue
            row = sorted(versions, key=lambda item: (str(item.get("ann_date") or ""), sha(encode(item))))[0]
            if not isinstance(row.get("net_profit_min"), (float, int)) or row["net_profit_min"] <= 0:
                continue
            candidates.append({"code": code, "period": end, "annDate": row["ann_date"],
                "sampleKey": sha(f"{spec['sampleSeed']}:{code}:{end}".encode())})
        samples.extend(sorted(candidates, key=lambda item: item["sampleKey"])[:spec["samplePerPeriod"]])
    return samples


def cninfo_page(params, output):
    key = sha(encode(params))
    cache = output / f"cninfo-request-{key}.json"
    if cache.exists():
        return load(output, json.loads(cache.read_bytes()))
    request = urllib.request.Request(CNINFO, data=urllib.parse.urlencode(params).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                 "Referer": "https://www.cninfo.com.cn/", "User-Agent": "Mozilla/5.0"})
    time.sleep(0.25)
    with urllib.request.urlopen(request, timeout=20) as response:
        if urllib.parse.urlparse(response.url).hostname != "www.cninfo.com.cn":
            raise ValueError("UNEXPECTED_REDIRECT")
        raw = response.read(12_000_001)
        if len(raw) > 12_000_000:
            raise ValueError("RESPONSE_TOO_LARGE")
        value = json.loads(raw)
    cache.write_bytes(encode(store(output, "cninfo", value)))
    return value


def cninfo_history(sample, spec, output):
    ann = dt.datetime.strptime(sample["annDate"], "%Y%m%d").date()
    start = dt.date(int(sample["period"][:4]), 1, 1)
    end = min(ann + dt.timedelta(days=10),
              dt.datetime.strptime(spec["latestObservation"], "%Y%m%d").date())
    code = sample["code"].split(".")[0]
    # The observed endpoint repeats page 1 for oversized requests; 30 paginates correctly.
    base = {"pageSize": str(min(30, spec["cninfoPageSize"])), "column": "szse",
        "tabName": "fulltext", "plate": "", "stock": "", "searchkey": code,
        "secid": "", "category": "", "trade": "", "seDate": f"{start}~{end}",
        "sortName": "time", "sortType": "desc", "isHLtitle": "false"}
    first = cninfo_page({**base, "pageNum": "1"}, output)
    issuer = next((row for row in first.get("announcements") or []
                   if row.get("secCode") == code and row.get("orgId")), None)
    if not issuer:
        # This catalog resolves an issuer id only; it never selects historical securities.
        catalog_file = output / "cninfo-issuer-catalog.json"
        if catalog_file.exists():
            catalog = load(output, json.loads(catalog_file.read_bytes()))
        else:
            with urllib.request.urlopen("https://www.cninfo.com.cn/new/data/szse_stock.json", timeout=20) as response:
                raw = response.read(8_000_001)
                if len(raw) > 8_000_000:
                    raise ValueError("CATALOG_TOO_LARGE")
                catalog = json.loads(raw)
            catalog_file.write_bytes(encode(store(output, "issuer-catalog", catalog)))
        issuer = next((row for row in catalog.get("stockList") or []
                       if row.get("code") == code and row.get("orgId")), None)
        if not issuer:
            raise ValueError("ISSUER_NOT_FOUND")
    base.update(stock=f"{code},{issuer['orgId']}", searchkey="")
    rows, seen = [], set()
    expected = None
    for page in range(1, spec["cninfoMaxPages"] + 1):
        payload = cninfo_page({**base, "pageNum": str(page)}, output)
        total = payload.get("totalAnnouncement")
        if not isinstance(total, int) or (expected is not None and total != expected):
            raise ValueError("UNSTABLE_TOTAL")
        expected = total
        batch = payload.get("announcements") or []
        for row in batch:
            key = row.get("announcementId")
            if not key or key in seen or row.get("secCode") != code:
                raise ValueError("DUPLICATE_OR_WRONG_ISSUER")
            seen.add(key)
            rows.append(row)
        if len(rows) == expected:
            return {"scopeStart": str(start), "scopeEnd": str(end),
                    "total": total, "completeWithinScope": True, "rows": rows}
        if not batch or len(rows) > expected:
            break
    raise ValueError("INCOMPLETE_ANNOUNCEMENT_PAGES")


def get_pdf(row, spec, output):
    url_path = str(row.get("adjunctUrl") or "")
    if not re.fullmatch(r"finalpage/\d{4}-\d{2}-\d{2}/[A-Za-z0-9_-]+\.pdf", url_path, re.I):
        raise ValueError("INVALID_PDF_PATH")
    url = f"https://static.cninfo.com.cn/{url_path}"
    identifier = sha(url.encode())
    cached = output / f"pdf-reference-{identifier}.json"
    if cached.exists():
        ref = json.loads(cached.read_bytes())
        if sha((output / ref["file"]).read_bytes()) != ref["sha256"]:
            raise ValueError("PDF_CHECKSUM_MISMATCH")
        return ref
    with urllib.request.urlopen(url, timeout=25) as response:
        if urllib.parse.urlparse(response.url).hostname != "static.cninfo.com.cn":
            raise ValueError("UNEXPECTED_PDF_REDIRECT")
        raw = response.read(spec["pdfMaxBytes"] + 1)
    if len(raw) > spec["pdfMaxBytes"] or not raw.startswith(b"%PDF-"):
        raise ValueError("INVALID_PDF")
    name = f"original-{sha(raw)}.pdf"
    (output / name).write_bytes(raw)
    import fitz
    with fitz.open(stream=raw, filetype="pdf") as doc:
        if len(doc) > 50:
            raise ValueError("PDF_PAGE_CAP")
        text = "\n".join(page.get_text() for page in doc)
    text_ref = store(output, "pdf-text", {"url": url, "text": text})
    ref = {"url": url, "file": name, "sha256": sha(raw), "text": text_ref}
    cached.write_bytes(encode(ref))
    return ref


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["forecasts", "sources", "expectations"], required=True)
    parser.add_argument("--retry-failed", action="store_true")
    args = parser.parse_args()
    spec_raw = (Path(__file__).with_name("experiment.json")).read_bytes()
    spec = json.loads(spec_raw)
    output = ROOT / "backtest/cache/earnings-v1"
    output.mkdir(parents=True, exist_ok=True)
    manifest_file = output / "manifest.json"
    if manifest_file.exists():
        manifest = json.loads(manifest_file.read_bytes())
        if manifest["configHash"] != sha(spec_raw):
            raise ValueError("CONFIG_CHANGED")
    else:
        manifest = {"configHash": sha(spec_raw), "forecasts": {}, "sourceAudits": {},
                    "fetchedAt": dt.datetime.now(SHANGHAI).isoformat()}
    if args.phase == "forecasts":
        client = TushareClient(timeout=25, retries=1)
        for period in spec["periods"]:
            if period not in manifest["forecasts"]:
                rows = client.rows("forecast_vip", {"period": period, "end_date": spec["latestObservation"]}, FIELDS)
                if not rows or len(rows) >= 3500 or any(
                    row.get("end_date") != period or row.get("ann_date", "") > spec["latestObservation"]
                    for row in rows):
                    raise ValueError("EMPTY_CAPPED_OR_WRONG_PERIOD")
                manifest["forecasts"][period] = store(output, f"forecast-{period}", rows)
                manifest_file.write_bytes(encode(manifest))
            print(json.dumps({"period": period, "rows": len(load(output, manifest["forecasts"][period]))}), flush=True)
        rows = [row for ref in manifest["forecasts"].values() for row in load(output, ref)]
        manifest["samples"] = choose_samples(rows, spec)
        manifest_file.write_bytes(encode(manifest))
    elif args.phase == "expectations":
        if not manifest.get("samples"):
            raise ValueError("RUN_FORECASTS_FIRST")
        client = TushareClient(timeout=25, retries=1)
        # Nine bounded probes plus the earlier one-off probe stay within the documented trial quota.
        samples = [item for period in spec["periods"]
                   for item in [sample for sample in manifest["samples"] if sample["period"] == period][:3]]
        for sample in samples:
            key = sample["code"] + ":" + sample["period"]
            if key in manifest.get("expectationProbes", {}):
                previous = load(output, manifest["expectationProbes"][key])
                if not args.retry_failed or not previous.get("errorType"):
                    continue
                manifest.setdefault("previousExpectationAttempts", {}).setdefault(key, []).append(manifest["expectationProbes"][key])
            ann = dt.datetime.strptime(sample["annDate"], "%Y%m%d").date()
            params = {"ts_code": sample["code"], "start_date": (ann - dt.timedelta(days=90)).strftime("%Y%m%d"),
                      "end_date": (ann - dt.timedelta(days=1)).strftime("%Y%m%d")}
            try:
                rows = client.rows("report_rc", params,
                    "ts_code,report_date,quarter,np,org_name,create_time")
                if len(rows) >= 3000:
                    raise ValueError("EXPECTATION_ROW_CAP")
                record = {"sample": sample, "params": params, "rows": rows,
                          "source": "https://tushare.pro/document/2?doc_id=292"}
            except Exception as error:
                record = {"sample": sample, "params": params, "errorType": type(error).__name__}
            manifest.setdefault("expectationProbes", {})[key] = store(output, "expectation-probe", record)
            manifest_file.write_bytes(encode(manifest))
            print(json.dumps({"key": key, "expectationRows": len(record.get("rows", [])),
                              "errorType": record.get("errorType")}), flush=True)
            if record.get("errorType"):
                break
    else:
        if not manifest.get("samples"):
            raise ValueError("RUN_FORECASTS_FIRST")
        for sample in manifest["samples"]:
            key = sample["code"] + ":" + sample["period"]
            if key in manifest["sourceAudits"]:
                previous = load(output, manifest["sourceAudits"][key])
                if not args.retry_failed or previous.get("completeWithinScope"):
                    continue
                manifest.setdefault("previousSourceAttempts", {}).setdefault(key, []).append(manifest["sourceAudits"][key])
            try:
                history = cninfo_history(sample, spec, output)
                relevant = [row for row in history["rows"]
                    if re.search(r"业绩预告|业绩快报", row.get("announcementTitle", ""))
                    and sample["period"][:4] in row["announcementTitle"]
                    and re.search(r"半年度|半[年]|上半年", row["announcementTitle"])]
                documents = []
                for row in relevant:
                    try:
                        pdf = get_pdf(row, spec, output)
                        documents.append({"announcement": row, "pdf": pdf})
                    except Exception as error:
                        documents.append({"announcement": row, "errorType": type(error).__name__})
                result = {"sample": sample, "history": store(output, "issuer-history", history),
                          "documents": documents, "completeWithinScope": True}
            except Exception as error:
                result = {"sample": sample, "errorType": type(error).__name__, "completeWithinScope": False}
            manifest["sourceAudits"][key] = store(output, "source-audit", result)
            manifest_file.write_bytes(encode(manifest))
            print(json.dumps({"key": key, "documents": len(result.get("documents", [])),
                              "complete": result["completeWithinScope"]}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "errorType": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
