"""
Tushare Pro 轻量 HTTP 客户端（P1 正交数据源接入）。
================================================================
为什么是 HTTP 直连而非 SDK/MCP：
  - 训练/每日重训是 FC 上的批量定时任务，不是交互式 agent → MCP 不适用。
  - 官方 SDK 依赖 pandas（重）、且需硬改私有属性指向自建网关；HTTP 直连最轻。
  - 自建网关会 307 跳到 ts2 子域、可能返回 gzip；此处一并处理，并做令牌桶限速+重试。

安全：token 从环境变量 TUSHARE_TOKEN 读取，绝不硬编码/落库。网关地址可用
      TUSHARE_URL 覆盖，但只接受文档公开入口及其已知重定向主机。

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
import urllib.parse
import urllib.request

DEFAULT_URL = os.environ.get("TUSHARE_URL", "https://ts.gyzcloud.top/api")
# 网关接口与限速说明：https://ts.gyzcloud.top/docs
ALLOWED_GATEWAY_HOSTS = frozenset({"ts.gyzcloud.top", "ts2.gyzcloud.top"})
SAFE_MAX_PER_MIN = 135
DEFAULT_MAX_PER_MIN = 90
RATE_LIMIT_COOLDOWN_SECONDS = 305


def validate_gateway_url(url):
    """只允许公开 Tushare 网关的 HTTPS API 地址，防止凭证外发或重定向 SSRF。"""
    if not isinstance(url, str) or not url.strip():
        raise ValueError("TUSHARE_URL 不能为空")
    parsed = urllib.parse.urlparse(url.strip())
    if parsed.scheme != "https":
        raise ValueError("TUSHARE_URL 必须使用 HTTPS")
    if parsed.hostname not in ALLOWED_GATEWAY_HOSTS:
        raise ValueError("TUSHARE_URL 主机不在允许列表")
    if parsed.port not in (None, 443):
        raise ValueError("TUSHARE_URL 不允许自定义端口")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("TUSHARE_URL 不得包含凭证、查询参数或片段")
    if parsed.path != "/api" or parsed.params:
        raise ValueError("TUSHARE_URL 路径必须为 /api")
    return parsed.geturl()


class _RateLimiter:
    """简单令牌桶：限制每分钟最多 max_per_min 次调用（线程安全）。
    Tushare 网关限频 150 次/分；默认留 10% 余量取 135。"""
    def __init__(self, max_per_min=135):
        if (not isinstance(max_per_min, (int, float))
                or isinstance(max_per_min, bool)
                or not 0 < max_per_min <= SAFE_MAX_PER_MIN):
            raise ValueError(f"max_per_min 必须在 0 到 {SAFE_MAX_PER_MIN} 之间")
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

    def defer(self, seconds):
        """把所有共享此 limiter 的线程统一延后，避免 429 后并发重试。"""
        with self._lock:
            self._next_at = max(self._next_at, time.time() + seconds)


class TushareClient:
    def __init__(self, token=None, url=None, max_per_min=DEFAULT_MAX_PER_MIN,
                 timeout=40, retries=4):
        self.token = token or os.environ.get("TUSHARE_TOKEN", "")
        if not self.token:
            raise RuntimeError("TUSHARE_TOKEN 未设置（应从环境变量读取，勿硬编码）")
        self.url = validate_gateway_url(url or DEFAULT_URL)
        self.timeout = timeout
        self.retries = retries
        self._rl = _RateLimiter(max_per_min)

    def _post_once(self, body_bytes, url):
        """单次 POST，自动跟随 307 到 ts2，解 gzip。返回 (obj, final_url)。"""
        cur = validate_gateway_url(url)
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
                        cur = validate_gateway_url(urllib.parse.urljoin(cur, loc))
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
            except urllib.error.HTTPError as e:
                last = e
                if e.code == 429:
                    self._rl.defer(RATE_LIMIT_COOLDOWN_SECONDS)
                    continue
                time.sleep(1.5 * (i + 1))
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

    def namechange(self, ts_code, start_date=None, end_date=None):
        p = {"ts_code": ts_code}
        if start_date:
            p["start_date"] = start_date
        if end_date:
            p["end_date"] = end_date
        return self.rows(
            "namechange",
            p,
            "ts_code,name,start_date,end_date,change_reason",
        )

    def suspend_d(self, ts_code, start_date=None, end_date=None):
        p = {"ts_code": ts_code}
        if start_date:
            p["start_date"] = start_date
        if end_date:
            p["end_date"] = end_date
        return self.rows(
            "suspend_d",
            p,
            "ts_code,trade_date,suspend_timing,suspend_type",
        )

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

    def ths_index(self, exchange="A", index_type=None,
                  fields="ts_code,name,count,exchange,list_date,type"):
        params = {"exchange": exchange}
        if index_type:
            params["type"] = index_type
        return self.rows("ths_index", params, fields)

    def ths_daily(self, ts_code=None, trade_date=None, start_date=None,
                  end_date=None, fields="ts_code,trade_date,open,high,low,"
                  "close,pct_change,vol,turnover_rate,total_mv,float_mv"):
        params = {}
        if ts_code:
            params["ts_code"] = ts_code
        if trade_date:
            params["trade_date"] = trade_date
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        return self.rows("ths_daily", params, fields)

    def moneyflow_ind_ths(
        self,
        ts_code=None,
        trade_date=None,
        start_date=None,
        end_date=None,
        fields="trade_date,ts_code,industry,lead_stock,close,pct_change,"
        "company_num,pct_change_stock,close_price,net_buy_amount,"
        "net_sell_amount,net_amount",
    ):
        params = {}
        if ts_code:
            params["ts_code"] = ts_code
        if trade_date:
            params["trade_date"] = trade_date
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        return self.rows("moneyflow_ind_ths", params, fields)

    def trade_cal(self, start_date=None, end_date=None,
                  fields="cal_date,is_open,pretrade_date"):
        params = {"exchange": "SSE"}
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        return self.rows("trade_cal", params, fields)


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
