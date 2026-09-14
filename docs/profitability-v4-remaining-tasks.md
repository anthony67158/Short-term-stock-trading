# 盈利能力改造 · 剩余工作与数据依赖（路线2）

日期：2026-09-14
状态：可离线核心已全部落地并单测；训练/接线/验证部分**阻塞于 5 年数据回填**。

## 已完成（本批，均带单测、独立提交）

| 提交 | 内容 | 验证 |
|---|---|---|
| `b7bc5cb` | 主板 3-5 年历史采集器 `scripts/backfill-mainboard-history.py` | 真实 2 日端到端 + 5 项单测 |
| `6bfda5e` | 验收门槛 `shared/profitabilityAcceptance.js` | 6 项单测 |
| `a01de55` | 建议应然 vs 人工执行偏差 `shared/adviceExecutionDivergence.js` | 5 项单测 |
| `881c110` | 费后奖励塑形接入 `review_dataset.py`（默认恒等） | 17 项单测 |
| `15095cf` | Alpha158 连续特征 v4 契约（JS+Python 跨语言对齐） | 13 项单测 |
| `054cca9` | 低相关有效机会选择器 `shared/lowCorrelationSelection.js` | 6 项单测 |
| `520c89b` | 退出反事实动作价值内核 `shared/exitActionValue.js` | 5 项单测 |
| `9d1d3a5` | 市场状态分段 + 未调参年度 `shared/marketRegimeSegmentation.js` | 6 项单测 |

## 数据前提

- 已验证 Tushare token 有效，可拉 2021→2026 日线（约 1381 交易日）+ moneyflow。
- 后台采集：`~/.mainboard-5y/`，产物 `mainboard.json.gz` + `coverage.json`。
- 完成后必须先看 `coverage.json.passed==true`（交易日历对齐、无缺失/多余日、
  覆盖率达标），否则不得进入训练。

## 剩余工作（严格按序，均依赖上面的 5 年数据）

### R1 · Alpha158 主板扩展分数（任务4 数据侧）
- 用 `alpha158_mainboard.py` 在 5 年主板面板上跑扩展时序，产出每日横截面
  分数/分位；额外计算滚动 RankIC(20/60) 与 5 日分数动量，落成 alpha 快照。
- alpha 快照按 `shared/alpha158SignalFeatures.js` 的字段口径产出，供 v4 特征装配。

### R2 · V4 训练管线接线（任务4 模型侧）
- 训练/推理显式选用 `review_contract_v4`（176 维）；装配时把 alpha 块拼到
  v3 的 168 维之后，缺失填 0 中性 + Missing 掩码。
- 价格合同哈希、上传/下载校验、门禁同步支持 v4；**v3 生产链路保持不变**。
- v4 仅作挑战者，走冠军挑战者门禁。

### R3 · 退出反事实落地（任务6 数据侧）
- 扩展 `opportunityOutcomeResolver.js`：结算时用 `computeExitActionValues`
  额外落地 HOLD/PARTIAL/FULL 三条退出路径净R（类比入场侧 counterfactualPlans）。
- 在 5 年数据回填时一并生成；`hardStopHit` 样本排除出退出模型训练。

### R4 · 退出动作价值头 + 门禁（任务6 模型侧）
- 四段时间隔离训练退出头；接入 `holding-exit` 复核；账本硬止损独立执行。
- 冠军挑战者门禁，未提升 KEEP_CURRENT。

### R5 · 六打法分层召回（任务4 覆盖侧）
- 动量/资金潜伏/回踩修复/事件催化分别召回，联合排序后过
  `shared/lowCorrelationSelection.js`，用 `effectiveCount` 度量年化有效机会数
  （目标 120-160 笔）。

### R6 · 跨市场年度验证（任务7）
- 用 `shared/marketRegimeSegmentation.js` 分段 + 划最后一整年未调参 holdout。
- 在未调参年度上跑 10 万账户回放，用 `shared/profitabilityAcceptance.js`
  的门槛出结论：滚动 12 月盈利概率≥70%、年度中位数 10-20%、回撤≤10%、
  10bps 正收益、费后净R 95%下界≥0.02R。
- **纪律**：完整年不足或数据不足时 `provable=false`，不给年度结论，绝不用
  260 日或半年样本伪造“年度稳定/70% 概率”。

## 人工执行模式（贯穿全程）

- 系统只输出唯一操作建议（动作/手数/价格区间/有效期/止损目标失效条件）。
- 未成交明确作废，不按理论价记账。
- 用 `adviceExecutionDivergence` 把“建议应然表现”与“人工执行偏差”分开统计。

## 不做/不伪造

- 不在数据到位前硬写训练头/门禁空壳。
- 不改 v3 生产契约与已部署模型。
- 不提高当前 V3 风险仓位，直到 v4+退出模型在未调参年度回放通过全部门槛。
