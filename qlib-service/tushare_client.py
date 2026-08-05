"""
Tushare Pro 轻量 HTTP 客户端（P1 正交数据源接入）。
================================================================
为什么是 HTTP 直连而非 SDK/MCP：
  - 训练/每日重训是 FC 上的批量定时任务，不是交互式 agent → MCP 不适用。
  - 官方 SDK 依赖 pandas（重）、且需硬改私有属性指向自建网关；HTTP 直连最轻。
  - 自建网关会 307 跳到 ts2 子域、可能返回 gzip；此处一并处理，并做令牌桶限速+重试。

安全：token 从环境变量 TUSHARE_TOKEN 读取，绝不硬编码/落库。网关地址可用
      TUSHARE_URL 覆盖（默认已是 307 后的最终地址 ts2，省一次跳转）。

用法：
    from tushare_client import TushareClient
    ts = TushareClient()                       # 读 env
    items, fields = ts.call("daily_basic",
                            {"ts_code": "600519.SH", "trade_date": "20260805"},
                            "ts_code,turnover_rate_f,volume_ratio,pe_ttm,pb,ps_ttm,total_mv")
    rows = ts.rows("daily_basic", {...}, "field1,field2")   # 返回 list[dict]
"""
import gzip
import json
import os
import threading
import time
import urllib.error
import urllib.request

DEFAULT_URL = os.environ.get("TUSHARE_URL", "https://ts2.gyzcloud.top/api")
# 官方入口 https://ts.gyzcloud.top/api 会 307 → ts2；默认直连 ts2 省一跳，但仍保留跟随逻辑兜底。


class _RateLimiter:
    """简单令牌桶：限制每分钟最多 max_per_min 次调用（线程安全）。
    Tushare 网关限频 150 次/分；默认留 10% 余量取 135。"""
    def __init__(self, max_per_min=135):
        self.capacity = max_per_min
        self.interval = 60.0 / max_per_min   # 每次调用最小间隔
        self._lock = threading.Lock()
        self._next_at = 0.0

    def acquire(self):
        with self._lock:
            now = time.time()
            wait = self._next_at - now
            if wait > 0:
                time.sleep(wait)
                now = time.time()
            self._next_at = max(now, self._next_at) + self.interval


class TushareClient:
    def __init__(self, token=None, url=None, max_per_min=135, timeout=40, retries=4):
        self.token = token or os.environ.get("TUSHARE_TOKEN", "")
        if not self.token:
            raise RuntimeError("TUSHARE_TOKEN 未设置（应从环境变量读取，勿硬编码）")
        self.url = url or DEFAULT_URL
        self.timeout = timeout
        self.retries = retries
        self._rl = _RateLimiter(max_per_min)

    def _post_once(self, body_bytes, url):
        """单次 POST，自动跟随 307 到 ts2，解 gzip。返回 (obj, final_url)。"""
        cur = url
        for _ in range(3):  # 最多跟随 3 次跳转
            req = urllib.request.Request(
                cur, data=body_bytes,
                headers={"Content-Type": "application/json",
                         "Accept-Encoding": "gzip"})
            # 关掉自动重定向以便手动跟随（默认 opener 遇 307 会抛错）
            class _NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *a, **k):
                    return None
            opener = urllib.request.build_opener(_NoRedirect)
            try:
                with opener.open(req, timeout=self.timeout) as r:
                    raw = r.read()
                    if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                        raw = gzip.decompress(raw)
                    return json.loads(raw.decode("utf-8", "ignore")), cur
            except urllib.error.HTTPError as e:
                if e.code in (301, 302, 307, 308):
                    loc = e.headers.get("Location")
                    if loc:
                        cur = loc
                        continue
                raise
        raise RuntimeError(f"重定向次数过多: {url}")

    def call(self, api_name, params=None, fields=""):
        """调用一个 Tushare 接口。返回 (items, fields)；items 为二维数组（行×列）。"""
        body = json.dumps({
            "api_name": api_name,
            "token": self.token,
            "params": params or {},
            "fields": fields,
        }).encode()
        last = None
        for i in range(self.retries):
            self._rl.acquire()
            try:
                obj, final = self._post_once(body, self.url)
                if final != self.url:
                    self.url = final  # 记住最终地址，后续免跳转
                code = obj.get("code")
                if code == 0:
                    d = obj.get("data") or {}
                    return (d.get("items") or []), (d.get("fields") or [])
                msg = obj.get("msg") or ""
                # 限频类错误 → 退避重试；其它业务错误直接抛
                if "每分钟" in msg or "频率" in msg or "limit" in msg.lower():
                    time.sleep(2.0 * (i + 1))
                    last = RuntimeError(f"{api_name} 限频: {msg}")
                    continue
                raise RuntimeError(f"{api_name} 返回 code={code} msg={msg}")
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last = e
                time.sleep(1.5 * (i + 1))
        raise last or RuntimeError(f"{api_name} 调用失败")

    def rows(self, api_name, params=None, fields=""):
        """便捷封装：返回 list[dict]（每行一个 dict，键为字段名）。"""
        items, fs = self.call(api_name, params, fields)
        return [dict(zip(fs, row)) for row in items]

    # ---------- 常用接口便捷方法 ----------
    def daily_basic(self, ts_code=None, trade_date=None, start_date=None,
                    end_date=None, fields="ts_code,trade_date,turnover_rate_f,"
                    "volume_ratio,pe_ttm,pb,ps_ttm,dv_ttm,total_mv,circ_mv"):
        p = {}
        if ts_code:
            p["ts_code"] = ts_code
        if trade_date:
            p["trade_date"] = trade_date
        if start_date:
            p["start_date"] = start_date
        if end_date:
            p["end_date"] = end_date
        return self.rows("daily_basic", p, fields)

    def moneyflow(self, ts_code=None, trade_date=None, start_date=None,
                  end_date=None, fields="ts_code,trade_date,buy_lg_amount,"
                  "sell_lg_amount,buy_elg_amount,sell_elg_amount,net_mf_amount"):
        p = {}
        if ts_code:
            p["ts_code"] = ts_code
        if trade_date:
            p["trade_date"] = trade_date
        if start_date:
            p["start_date"] = start_date
        if end_date:
            p["end_date"] = end_date
        return self.rows("moneyflow", p, fields)

    def daily(self, ts_code, start_date=None, end_date=None,
              fields="ts_code,trade_date,open,high,low,close,vol,amount"):
        p = {"ts_code": ts_code}
        if start_date:
            p["start_date"] = start_date
        if end_date:
            p["end_date"] = end_date
        return self.rows("daily", p, fields)

    def adj_factor(self, ts_code, start_date=None, end_date=None):
        p = {"ts_code": ts_code}
        if start_date:
            p["start_date"] = start_date
        if end_date:
            p["end_date"] = end_date
        return self.rows("adj_factor", p, "trade_date,adj_factor")

    def index_daily(self, ts_code="000300.SH", start_date=None, end_date=None):
        p = {"ts_code": ts_code}
        if start_date:
            p["start_date"] = start_date
        if end_date:
            p["end_date"] = end_date
        return self.rows("index_daily", p, "trade_date,close")

    def stock_basic(self, list_status="L",
                    fields="ts_code,symbol,name,market,list_date"):
        return self.rows("stock_basic", {"list_status": list_status}, fields)


if __name__ == "__main__":
    # 自检：需先 `set -a; . ../.env; set +a` 或 export TUSHARE_TOKEN
    c = TushareClient()
    t0 = time.time()
    sb = c.stock_basic()
    print(f"stock_basic n={len(sb)} sample={sb[:1]}")
    db = c.daily_basic(ts_code="600519.SH", start_date="20260701", end_date="20260805")
    print(f"daily_basic n={len(db)} sample={db[:1]}")
    mf = c.moneyflow(ts_code="600519.SH", start_date="20260701", end_date="20260805")
    print(f"moneyflow n={len(mf)} sample={mf[:1]}")
    print(f"[selfcheck ok] {time.time()-t0:.1f}s")
