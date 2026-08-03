"""
量化打分 + 走势预测微服务  v3（LightGBM 打分 + GARCH 波动率）
- 数据由调用方(Vercel/FC 主服务)POST 传入 K线
- Plan A：LightGBM 达标概率模型打分（从 OSS 拉取 quantmodel/lgb_score.txt）；模型缺失自动回落纯 numpy 打分
- Plan B：GARCH(1,1) 在线拟合条件波动率喂给蒙特卡洛；拟合失败回落历史 σ
- 因子计算与训练管道共用 factors_lib，保证口径一致
- 鉴权：X-API-Key。所有输出为统计口径，非投资建议。
"""
import os
import time

from fastapi import FastAPI, Header, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
import numpy as np

from factors_lib import compute_factors, feature_vector, FEATURE_NAMES
from model_lib import model_score, garch_sigma, get_model

app = FastAPI(title="Quant Score & Forecast", version="3.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

API_KEY = os.environ.get("API_KEY", "")


def _check_key(key):
    if API_KEY and key != API_KEY:
        raise HTTPException(status_code=401, detail="bad api key")


def score_from_factors(f):
    s = 50.0
    s += float(np.clip(f["mom20"], -15, 15)) * 0.6
    s += f["ma_bull"] * 6
    s += float(np.clip(f["vs_ma20"], -12, 12)) * 0.4
    s += (f["vol_price_sync"] - 0.5) * 20
    if f["vol_ratio"] > 1.3 and f["mom5"] > 0:
        s += 4
    if f["rsi"] >= 75:
        s -= 8
    elif f["rsi"] <= 25:
        s += 8
    s += (50 - f["pos60"]) * 0.12
    score = float(np.clip(round(s, 1), 0, 100))
    bias = "偏多" if score >= 62 else ("偏空" if score <= 38 else "中性")
    if f["pos60"] >= 70 or f["rsi"] >= 70:
        t_dir = "reverse"
    elif f["pos60"] <= 30 or f["rsi"] <= 30:
        t_dir = "positive"
    else:
        t_dir = "balanced"
    return score, bias, t_dir


# ---------- 打分：优先 LightGBM 达标概率模型，缺模型回落纯 numpy 规则分 ----------
def score_stock(f):
    """返回 (score, bias, t_dir, engine, prob)。engine ∈ {'lgb','rule'}。"""
    rule_score, _, _ = score_from_factors(f)
    ms = model_score(feature_vector(f), FEATURE_NAMES)
    if ms is not None:
        score, prob = ms
        score = float(round(score, 1))
        engine = "lgb"
    else:
        score, prob, engine = rule_score, None, "rule"
    bias = "偏多" if score >= 62 else ("偏空" if score <= 38 else "中性")
    if f["pos60"] >= 70 or f["rsi"] >= 70:
        t_dir = "reverse"
    elif f["pos60"] <= 30 or f["rsi"] <= 30:
        t_dir = "positive"
    else:
        t_dir = "balanced"
    return score, bias, t_dir, engine, prob


# ---------- 走势预测（核心）----------
# 用 GARCH(1,1) 条件波动率(Plan B) 替代固定历史 σ；动量+均值回归+RSI 修正漂移，
# 蒙特卡洛模拟未来N日价格路径 → 上涨概率、预期涨跌幅、乐观/中性/悲观目标价。
def forecast(f, days=5, sims=3000):
    rets = f["_rets"] / 100.0
    last = f["_last"]
    ma20 = f["_ma20"]
    if len(rets) < 20 or last <= 0:
        return None
    recent = rets[-60:] if len(rets) >= 60 else rets
    mu = float(np.mean(recent))
    hist_sigma = float(np.std(recent)) or 0.01
    # Plan B：GARCH 条件波动率（用 % 收益率拟合），失败回落历史 σ
    sigma = garch_sigma(f["_rets"][-250:], fallback=hist_sigma)
    vol_engine = "garch" if abs(sigma - hist_sigma) > 1e-9 else "hist"

    drift = mu + (f["mom20"] / 100.0) * 0.02
    if ma20:
        gap = (last - ma20) / ma20
        drift -= gap * 0.05 * (0.5 + f["mean_rev"])
    if f["rsi"] >= 75:
        drift -= 0.003
    elif f["rsi"] <= 25:
        drift += 0.003

    rng = np.random.default_rng(42)
    daily = rng.normal(drift, sigma, size=(sims, days))
    ends = last * np.prod(1 + daily, axis=1)

    up_prob = float(np.mean(ends > last) * 100)
    exp_ret = float((np.mean(ends) / last - 1) * 100)
    p10 = float(np.percentile(ends, 10))
    p50 = float(np.percentile(ends, 50))
    p90 = float(np.percentile(ends, 90))
    if up_prob >= 60 and exp_ret > 1:
        direction = "看涨"
    elif up_prob <= 40 and exp_ret < -1:
        direction = "看跌"
    else:
        direction = "震荡"
    conf = "高" if abs(up_prob - 50) >= 18 else ("中" if abs(up_prob - 50) >= 8 else "低")
    return {
        "days": days, "upProb": round(up_prob, 0), "expRet": round(exp_ret, 2),
        "targetLow": round(p10, 2), "targetMid": round(p50, 2), "targetHigh": round(p90, 2),
        "direction": direction, "confidence": conf, "dailyVol": round(sigma * 100, 2),
        "volEngine": vol_engine,
    }


# ---------- 决策建议（结合是否持仓 + 打分 + 预测）----------
def decide(score, bias, fc, f, hold):
    last = f["_last"]
    rsi = f["rsi"]
    pos = f["pos60"]
    up = fc["upProb"] if fc else 50
    direction = fc["direction"] if fc else "震荡"
    dd = fc["days"] if fc else 5

    if not hold or not hold.get("cost"):
        if score >= 60 and up >= 55 and rsi < 70:
            return {"action": "buy", "title": "可考虑建仓", "tone": "red",
                    "detail": f"量化偏多({score})、未来{dd}日看涨概率{up:.0f}%；现价不算高位(区间{pos:.0f}%)，可分批建仓。"}
        if score <= 40 or direction == "看跌":
            return {"action": "wait", "title": "暂不建仓", "tone": "green",
                    "detail": f"量化偏空({score})、后市{direction}；建议观望，等企稳或回调到低位再看。"}
        return {"action": "watch", "title": "观望为主", "tone": "muted",
                "detail": f"量化中性({score})、后市{direction}；无明显优势，等信号更明确（放量突破/回踩支撑）再介入。"}
    cost = float(hold["cost"])
    pnl = (last - cost) / cost * 100 if cost else 0
    stat = "浮盈" if pnl >= 0 else "浮亏"
    if score >= 62 and up >= 58 and pos < 75 and rsi < 72:
        return {"action": "add", "title": "可考虑加仓", "tone": "red",
                "detail": f"量化偏多({score})、看涨概率{up:.0f}%，你当前{stat}{pnl:+.1f}%；回踩不破可加仓摊薄/加码。"}
    if score <= 40 or rsi >= 75 or pos >= 88 or direction == "看跌":
        why = "RSI超买" if rsi >= 75 else ("处于高位" if pos >= 88 else ("后市看跌" if direction == "看跌" else "量化转弱"))
        return {"action": "reduce", "title": "建议减仓", "tone": "green",
                "detail": f"量化{bias}({score})、{why}；先减仓锁定，{'保住浮盈' if pnl>=0 else '控制回撤'}(当前{stat}{pnl:+.1f}%)。"}
    return {"action": "holdT", "title": "持有 + 做T", "tone": "gold",
            "detail": f"量化中性({score})、后市{direction}；底仓持有，区间内高抛低吸做T摊成本(现价区间位置{pos:.0f}%)。"}


@app.get("/health")
def health():
    return {"ok": True, "ts": int(time.time()), "ver": "3.0-lgb-garch"}


@app.post("/predict")
def predict(payload: dict = Body(...), x_api_key: str = Header(default="")):
    _check_key(x_api_key)
    try:
        candles = payload.get("candles") or []
        code = payload.get("code", "")
        hold = payload.get("hold")
        cs = [c for c in candles if c and c.get("close") is not None
              and c.get("high") is not None and c.get("low") is not None]
        if len(cs) < 25:
            raise HTTPException(status_code=400, detail="K线数据不足(需>=25根)")
        closes = [float(c["close"]) for c in cs]
        highs = [float(c["high"]) for c in cs]
        lows = [float(c["low"]) for c in cs]
        vols = [float(c.get("volume") or 0) for c in cs]

        f = compute_factors(closes, highs, lows, vols)
        score, bias, t_dir, engine, prob = score_stock(f)
        fc = forecast(f, days=5)
        dec = decide(score, bias, fc, f, hold)

        reads = []
        if fc:
            reads.append(f"未来{fc['days']}日{fc['direction']}，上涨概率{fc['upProb']:.0f}%，预期{fc['expRet']:+.1f}%")
            reads.append(f"目标价区间 {fc['targetLow']} ~ {fc['targetHigh']}（中枢 {fc['targetMid']}）")
        reads.append(f"量化{bias}{score}分 · RSI {f['rsi']:.0f} · 60日位置{f['pos60']:.0f}%")

        return {
            "ok": True, "code": code,
            "score": score, "bias": bias, "tDir": t_dir,
            "forecast": fc, "decision": dec, "reads": reads,
            "engine": engine, "hitProb": (round(prob, 4) if prob is not None else None),
            "asOf": (cs[-1].get("date") or ""),
            "note": "统计口径，非投资建议",
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)[:120])


@app.get("/model_info")
def model_info(x_api_key: str = Header(default="")):
    _check_key(x_api_key)
    booster, meta = get_model()
    return {"loaded": booster is not None, "meta": meta}


@app.get("/score")
def score_legacy(code: str = "", x_api_key: str = Header(default="")):
    _check_key(x_api_key)
    return {"ok": False, "error": "请改用 POST /predict（传 candles）", "code": code}
