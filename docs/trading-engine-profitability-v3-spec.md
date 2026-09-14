# Spec: 交易价值模型盈利能力 V3 五项改造

日期：2026-09-14
状态：SPECIFY（实施按 slice 推进，未通过冠军挑战者门禁前不切换生产）

## 目标

把已部署复核模型 `decision-review.*.ensemble3` 从“薄利、低利用率”（5bps `+0.42%`、
10bps 转负、45 笔、平均资金利用率 3.01%）推进到可验证的账户级目标：

- 滚动 12 个月账户盈利概率 ≥ 70%（不是单笔胜率）
- 年度收益中位数 10%–20%，最大回撤 ≤ 8%–10%
- 10bps 压力测试仍为正收益
- 机会净 R 95% 下界 ≥ 0.02R
- 有效成交提升到每年约 120–160 笔

只做建议、不自动下单：系统最终只输出唯一人工动作、手数、价格区间、有效期、
止损/目标/失效条件；未成交按作废处理，禁止用理论价记账。

## 现状事实（已核对，勿再假设）

- 本地历史数据：`~/.v3-year-relabel-work/daily.json.gz`，**260 交易日
  （2025-08-18 → 2026-09-11）**，5587 代码；成熟结果 77,466（FILLED 17,630）。
- 打法：`MOMENTUM_BREAKOUT / LEADER_PULLBACK / ACCUMULATION / CATALYST /
  PANIC_REVERSAL / RANGE_REVERSION`（`shared/opportunityPlaybooks.js`）。
- 路径：`IMMEDIATE / PULLBACK / BREAKOUT`。
- 每条成熟成交 `metrics` 已含：`netR / netPnl / totalFees / initialRiskCash /
  actualFillRiskCash / mfePct / maePct / holdingTradingSessions`。
- 当前机会标签：`y_opportunity_r = netR(FILLED) 或 0(TRIGGERED_UNFILLED)`
  （`review_dataset.py`）。测试 `test_decision_review_dataset.py` 固定
  `[1.2, 0.0]`——**任何改造默认必须保持此恒等**。
- 每日重训已接入主板过滤 + 冠军挑战者门禁（本会话前置任务已上线）。
- Alpha158 连续信号与联合排序、人工成交学习：**已由并行提交/未提交改动接入**
  （`接入Alpha158连续信号联合排序`、`将联合排序贯穿人工成交学习`），本 spec
  不重复实现，只在其之上补齐标签、退出与数据缺口。

## 五项改造与状态映射

1. **不做 Alpha158 Top50 硬过滤，改为连续特征** —— 已在并行改动中落地，本 spec
   仅做验收与回归保护，不新写并行实现。
2. **提升有效机会数量（六打法分层 + 联合排序，目标 120–160 笔/年）** —— 联合排序
   已接入；本 spec 负责按打法/路径分层评估与相关性去重的可验证口径。
3. **直接优化账户收益：费后机会奖励 `pFill × expectedNetRGivenFill`，惩罚换手、
   最低佣金、资金占用、尾部亏损** —— **本 spec 新增，未开始**。
4. **单独训练退出模型：比较继续持有 / 部分减仓 / 全部退出三动作价值，硬止损仍由
   账本执行** —— **本 spec 新增，未开始**。
5. **扩充跨市场 3–5 年数据并保留未调参年度测试集** —— **数据受限阻断**：本地仅
   260 交易日，且每日训练禁用 Tushare。只能人工历史回填，需单独授权与数据源。

## Commands

```
Python 复核训练测试：/private/tmp/qenv/bin/python -m unittest \
  qlib-service/tests/test_decision_review_dataset.py \
  qlib-service/tests/test_opportunity_reward.py
Node 账户回放测试：node --test test/review-v3-account-replay.test.js
奖励口径最小验证：/private/tmp/qenv/bin/python -m unittest qlib-service/tests/test_opportunity_reward.py
```

## Project Structure（本 spec 涉及）

```
qlib-service/decision_engine/training/opportunity_reward.py  → 新增，费后奖励与惩罚（纯函数）
qlib-service/decision_engine/training/review_dataset.py      → 接线（默认恒等）
qlib-service/decision_engine/training/review_exit.py         → 新增，退出动作价值数据/训练
qlib-service/tests/test_opportunity_reward.py                → 新增单测
qlib-service/tests/test_review_exit.py                       → 新增单测
docs/trading-engine-profitability-v3-*.md                    → spec/plan/tasks
```

## Code Style

纯函数、显式单位、缺失值不当 0、默认参数保持旧行为。例：

```python
def cost_aware_opportunity_reward(metrics, *, turnover_penalty_r=0.0,
                                  min_commission_penalty_r=0.0,
                                  capital_days_penalty_r=0.0,
                                  tail_penalty_r=0.0):
    """默认全 0 惩罚时返回原始 netR，保持与现有标签恒等。"""
```

## Testing Strategy

- 每个新纯函数先写 `unittest`，覆盖恒等默认、单项惩罚、缺失字段降级。
- 接线改动必须让 `test_decision_review_dataset.py` 的 `[1.2, 0.0]` 继续通过。
- 退出模型用四段时间隔离，禁止用未来信息，复用现有 `four_way_interval_split`。
- 任何生产切换仍走 `review_release.py` 冠军挑战者门禁，不旁路。

## Boundaries

- Always：新纯函数带单测；接线默认恒等；改动后跑对应 Python/Node 测试；
  只改本 spec 列出的 clean 文件。
- Ask first：改动并行会话正在重构的 Alpha158/联合排序文件；开启任何非零惩罚
  默认值；引入新数据源或 Tushare 回填；调整生产门禁阈值。
- Never：直接覆盖 DIRECT 生产清单；把未成交按理论价记账；把 260 日结果冒充
  年度稳定性；提交 `.env`/密钥/大二进制。

## Success Criteria

- 费后奖励函数：默认恒等；各惩罚项单调、可解释、缺失降级；单测通过。
- 退出模型：三动作价值可比较，硬止损独立；四段隔离；单测通过。
- 分层评估：按打法/路径给出成交数、净 R 下界、相关性去重后有效机会数。
- 数据缺口：明确记录 3–5 年不可得，给出人工回填与未调参测试集方案，不静默跳过。
- 所有改动可被冠军挑战者门禁独立评估，未达标则 KEEP_CURRENT。

## Open Questions

1. 3–5 年跨市场数据的授权数据源与回填窗口（Tushare 人工回填？其他？）。
2. 惩罚项系数的目标口径（换手/最低佣金/资金占用/尾部）由谁定标，先离线搜索。
3. 退出模型的动作粒度（部分减仓档位）与账本 T+1 的交互边界确认。
