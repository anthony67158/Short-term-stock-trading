"""
P1 正交因子提取 —— 来自 Tushare daily_basic + moneyflow 的**非量价同源**信息。
================================================================
设计原则（与 factors_lib 的 index/opens 相同）：
  - 每个因子都是"缺失即安全归零"，训练/线上/兜底口径永不报错。
  - 与现有 36 个纯量价技术因子尽量正交：估值(pe/pb/ps)、规模(mv)、真实换手、资金流。
  - 与训练管道共用，保证口径一致。

对外提供：
  ORTHO_NAMES：正交因子名单（顺序固定）。
  ortho_vector(basic_row, mf_rows_recent) -> list[float]：给定 daily_basic 当日一行
      + 最近若干日 moneyflow 行，产出正交因子向量。

注意：这些是「截面/基本面」量，Tushare 已给出当日快照值，无需再滚窗重算，
     仅做无量纲化（对数、比值、winsorize），避免量纲爆炸伤害树模型分裂。
"""
import numpy as np

ORTHO_NAMES = [
    "ts_turnover_f",     # 自由流通换手率（真实换手，比量比更干净）
    "ts_volume_ratio",   # 量比
    "ts_pe_ttm_inv",     # 1/pe_ttm（盈利收益率，负pe归零→更稳健的估值方向）
    "ts_pb_inv",         # 1/pb
    "ts_ps_ttm_inv",     # 1/ps_ttm
    "ts_logmv",          # log(总市值) 去中心（规模因子）
    "ts_dv_ttm",         # 股息率
    "ts_netmf_intensity",  # 当日主力净流入 / 流通市值（资金流强度，方向+量纲无关）
    "ts_netmf_5d",       # 近5日净流入累计 / 流通市值
    "ts_bigorder_ratio", # (大单+超大单)净买入 / 当日总成交额（主力主导度，有符号）
]


def _finite(x, d=0.0):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return float(d)
    return x if np.isfinite(x) else float(d)


def _inv(x):
    """估值倒数：正值取 1/x（收益率口径），非正/缺失归零（不猜方向）。"""
    x = _finite(x, 0.0)
    return (1.0 / x) if x > 1e-6 else 0.0


# 市值以「亿元」量级对数居中：log(total_mv[万元]) - 常数，让典型值落在 0 附近。
# total_mv 单位为万元；中位约 3e6 万元(=300亿)，log≈14.9，居中减 15。
_MV_CENTER = 15.0


def ortho_vector(basic_row, mf_rows_recent):
    """
    basic_row: daily_basic 当日一行 dict（键含 turnover_rate_f/volume_ratio/pe_ttm/
               pb/ps_ttm/dv_ttm/total_mv/circ_mv）；缺失可传 None。
    mf_rows_recent: 最近 N 日 moneyflow 行 list[dict]（按日期升序，末行为当日），
                    键含 net_mf_amount/buy_lg_amount/sell_lg_amount/buy_elg_amount/
                    sell_elg_amount；缺失可传 [] 或 None。
    返回：list[float]，顺序= ORTHO_NAMES。全部无量纲、缺失归零。
    """
    b = basic_row or {}
    turnover = _finite(b.get("turnover_rate_f"), 0.0)
    vr = _finite(b.get("volume_ratio"), 0.0)
    pe_inv = _inv(b.get("pe_ttm"))
    pb_inv = _inv(b.get("pb"))
    ps_inv = _inv(b.get("ps_ttm"))
    dv = _finite(b.get("dv_ttm"), 0.0)
    total_mv = _finite(b.get("total_mv"), 0.0)
    circ_mv = _finite(b.get("circ_mv"), 0.0)
    logmv = (float(np.log(total_mv)) - _MV_CENTER) if total_mv > 0 else 0.0

    mf = list(mf_rows_recent or [])
    # 当日资金流强度：主力净流入 / 流通市值。moneyflow 金额单位为万元、circ_mv 亦万元 → 比值无量纲。
    netmf_today = _finite(mf[-1].get("net_mf_amount"), 0.0) if mf else 0.0
    netmf_intensity = (netmf_today / circ_mv) if circ_mv > 0 else 0.0
    # 近5日净流入累计 / 流通市值
    net5 = sum(_finite(r.get("net_mf_amount"), 0.0) for r in mf[-5:]) if mf else 0.0
    netmf_5d = (net5 / circ_mv) if circ_mv > 0 else 0.0
    # 主力(大单+超大单)净买入 / 当日总买卖额 → 主力主导度（有符号，[-1,1] 附近）
    if mf:
        r = mf[-1]
        big_net = (_finite(r.get("buy_lg_amount")) - _finite(r.get("sell_lg_amount"))
                   + _finite(r.get("buy_elg_amount")) - _finite(r.get("sell_elg_amount")))
        gross = (_finite(r.get("buy_lg_amount")) + _finite(r.get("sell_lg_amount"))
                 + _finite(r.get("buy_elg_amount")) + _finite(r.get("sell_elg_amount")))
        bigorder_ratio = (big_net / gross) if gross > 1e-6 else 0.0
    else:
        bigorder_ratio = 0.0

    vec = [
        turnover, vr, pe_inv, pb_inv, ps_inv, logmv, dv,
        netmf_intensity, netmf_5d, bigorder_ratio,
    ]
    # 统一清洗 + 温和 winsorize（防极端值主导树分裂）
    out = []
    for x in vec:
        x = _finite(x, 0.0)
        out.append(float(np.clip(x, -50.0, 50.0)))
    return out


def tx_to_ts_code(sym):
    """把内部代码 sz300308/sh603986 转成 Tushare 代码 300308.SZ/603986.SH。"""
    s = str(sym).lower()
    if s.startswith("sh"):
        return s[2:] + ".SH"
    if s.startswith("sz"):
        return s[2:] + ".SZ"
    if s.startswith("bj"):
        return s[2:] + ".BJ"
    return sym
