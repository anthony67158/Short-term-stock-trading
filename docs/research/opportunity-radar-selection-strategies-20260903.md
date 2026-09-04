# A 股 1-5 个交易日短线选股策略：证据综述与机会雷达落地建议

> 研究日期：2026-09-03
> 目标系统：`stock-dashboard` 的唯一选股入口“机会雷达”
> 决策边界：研究与人工执行辅助，不自动下单，不承诺准确率或收益
> 研究问题：如何设计高召回候选层、可校准排序层、可成交性/交易成本风控层

## 1. 执行摘要

证据不支持把“动量”“反转”或任何单一技术形态写成固定方向的 A 股 1-5 日买入公式。经典横截面动量主要研究 3-12 个月；中国市场的日内、隔夜、最近 1 日及数日尺度研究同时观察到动量和反转，而且方向会随时间分段、流动性、波动率、涨跌停事件及多空腿变化。[S5][S6][S7][S8] 因此最稳妥的工程结论是：

1. **规则负责高召回，不负责声称有效。** 将短周期相对动量、短周期反转、行业/板块强度、量价异常、事件催化分别作为候选 lane；完整读取市场后并集合并，保留每只股票的入池与拒绝原因。
2. **三头模型继续成立，但要扩大特征和监督样本。** 现有 `pFill`、`pWinGivenFill`、`expectedNetR` 分解比单一“上涨概率”更符合 A 股实际。LightGBM 适合学习市场状态、板块、量价、波动率和公式类型的非线性交互，但模型类型本身不是 alpha 证据。[S9][S10]
3. **排序必须建立在时间外概率校准和净收益上。** AUC/准确率不足以支持阈值或仓位；应同时看 Brier、Log Loss、可靠性图、`Precision@K`、`NDCG@K`、扣费后 `NetR@K` 及其按交易日 block bootstrap 下界。[S12][S13]
4. **“触价”不等于“成交”。** T+1、涨跌停、价格笼子、价格优先/时间优先、停牌、整手、盘口容量和盘后固定价格交易都必须进入标签与模拟，而不能只作为 UI 提示。[S1][S2]
5. **事件只做带时点的条件特征。** 正式公告是可审计事实源，但中国 PEAD 研究结论并不一致，且常用 1-12 周或 60 日窗口，不能直接外推到 1-5 日；新闻、题材和龙虎榜不得被包装成确定性催化。[S4][S17][S18]
6. **最终输出应是独立机会集合，而非逐股分数前五。** 先按净期望下界排序，再按行业/概念、收益相关性、已有持仓、资金占用和 T+1 锁定敞口去重。

建议保留当前已经实现的全市场完整性校验、全候选账本、成交结果解析、三头 LightGBM、独立校准、影子门禁、板块风险上限和漂移监控；下一步重点不是再建一套模型，而是扩大候选与特征覆盖、补齐相关性去重，并把研究试验次数和线上校准漂移纳入发布闸门。

## 2. 研究方法与证据边界

### 2.1 两轮网络检索

本报告执行了两轮检索，检索日均为 2026-09-03。

**第一轮：广度检索**

- `site:sse.com.cn 2026 交易规则 股票 T+1 涨跌幅 盘后固定价格交易`
- `site:szse.cn 2026 交易规则 股票 T+1 涨跌幅 创业板`
- `short-term reversal China A-share stocks peer reviewed liquidity price limits`
- `cross-sectional momentum short horizon reversal industry momentum original paper`
- `Microsoft Qlib official paper LightGBM official paper probability calibration walk-forward`
- `backtest overfitting multiple testing finance original paper`
- `event catalyst post earnings announcement drift China A shares peer reviewed`

**第二轮：冲突核验与缺口补齐**

- 精确检索 LightGBM、Qlib、概率校准、White Reality Check、PBO、Harvey-Liu-Zhu 原文。
- 核验中国 A 股“最近 1 日动量 vs 短周期反转”的冲突。
- 核验涨跌停后的延续/反转与可成交性。
- 核验交易成本、官方披露时点、事件后漂移及组合聚类。
- 回到沪深交易所 2026 现行规则正文核对 T+1、申报单位、涨跌幅、价格笼子、撮合和盘后交易。

共整理 20 组来源，其中 4 组官方规则/政策、15 组同行评议研究、1 组原始 arXiv 平台论文与官方项目；部分来源组包含用于交叉验证的第二篇原文。营销文、券商策略宣传、回测截图和未披露样本口径的“胜率”不作为有效性证据。

### 2.2 证据等级

- **A：可直接作为制度或工程约束。** 交易所、证监会、财政部正式规则；原始算法/平台文档仅能证明能力。
- **B：可形成待验证假设。** 同行评议论文，但样本市场、频率、持有期、是否可做空可能与本项目不同。
- **C：探索性线索。** arXiv、单一新论文、跨市场结果；只能进入影子实验。
- **不采信：** 无完整样本、成本、时点、基准和多重检验说明的营销策略。

## 3. 经交叉验证的研究结论

### 3.1 横截面动量与短周期反转

**有证据的结论**

- 经典个股横截面动量主要是 3-12 个月形成期与持有期，不是 1-5 个交易日信号；只能支持“过去收益可能有横截面信息”，不能支持本项目直接追逐近几日涨幅。[S8]
- 中国 A 股证据具有明显尺度和状态依赖。2019 年日内研究发现首半小时收益对后续日内收益同时存在动量与反转，并明确指出交易成本妨碍套利。[S6]
- 2022 年中国短期反转研究发现，最近 1 日表现为动量，反转收益仅由少数特定日期驱动，且不符合美国市场常见的流动性提供解释。[S5]
- 涨停事件会扭曲普通动量度量。中国研究发现，排除涨停日后中期动量才更明显；另一项高频研究发现涨跌停次日延续比反转更常见，尤其是跌停。[S7]
- 2026 年中国聚类反转论文的增益主要来自空头腿、月度组合和聚类后构造，不能外推为本项目长仓 1-5 日策略。[S19]

**对候选层的含义**

- 同时保留 `MOMENTUM_1D`、`MOMENTUM_2_5D`、`REVERSAL_1D`、`REVERSAL_2_5D` lane，不预设哪个方向永久有效。
- 过去收益应拆成 `ret_1d` 与 `ret_2_5d`，再计算相对市场、相对行业的残差收益；不能把 5 日累计涨幅一个字段同时解释为趋势和超买。
- 涨停、开板、接近涨停、跌停、无价格限制期必须单独编码；不能把受制度截断的收益当普通连续收益。
- 所有 lane 只产生候选和解释，是否优先由时间外三头模型决定。

### 3.2 行业/板块动量

行业动量可解释相当部分个股动量，这是支持“先看方向，再看个股”的强证据；但原研究是美国中期组合，不能证明 A 股某概念板块当日净流入会在未来 1-5 日延续。[S11]

可落地做法：

- 板块特征进入排序模型，不作为一票通过条件：`sector_ret_1d/3d/5d`、相对大盘强度、上涨家数占比、成交额扩散、龙头集中度、资金持续性、板块内个股排名。
- 个股使用板块残差收益：`stock_return - sector_return`，区分“板块普涨中的跟随股”和“板块内真正走强的股票”。
- 板块处于加速、背离或退潮时分别校准，不共享一个概率桶。
- 概念标签会变动，必须使用决策时点可见的历史成分，禁止用今天的板块映射回填过去。

### 3.3 量价、流动性与波动率

机器学习资产定价研究中，动量、流动性和波动率是一组稳定的重要信息族，树模型的主要价值来自非线性交互；该研究使用美国月度横截面，不能证明 LightGBM 在 A 股 1-5 日必胜。[S9]

交易成本研究显示，高换手异常经成本调整后大多显著衰减；建立新仓与继续持有使用不同阈值的 buy/hold spread，是更有效的成本控制方法。[S14] 这与当前“触发后观察、复核后行动”一致。

可由现有 Level-1 行情直接构造：

| 信息族 | 建议字段 | 用途 |
| --- | --- | --- |
| 收益 | `ret_1d`、`ret_2_5d`、隔夜缺口、相对指数/板块残差 | 同时表达动量和反转假设 |
| 量能 | `volumeRatio`、5/20 日成交量 z-score、放量方向、量价背离 | 区分有效扩张与噪声 |
| 流动性 | `logAmount`、成交额横截面分位、换手率、`abs(return)/amount` 的 Amihud 代理 | 预测成交与冲击成本 |
| 波动 | ATR/价格、5/20 日实现波动率、日内振幅、跳空、下行波动 | 识别可达性和尾部风险 |
| 位置 | 距 VWAP、MA10/20、20 日高低点、涨跌停价的 ATR 距离 | 描述入场难度，不直接定方向 |
| 资金代理 | 主力/小单当日和 5 日序列、背离状态 | 条件特征；不解释为真实账户身份 |

硬性原则：

- 流动性同时进入 `pFill`、滑点压力测试和组合容量，不能只作为收益特征。
- 波动率不能只作“高波动高机会”；它也扩大止损、T+1 锁定回撤和概率漂移。
- 固定 5 bps 滑点只保留为基线，至少增加按成交额分位、波动率、时段、接近涨跌停程度划分的基准/压力两档。

### 3.4 涨跌停、T+1 与成交约束

截至 2026-09-03，沪深 2026 年交易规则已于 2026-07-06 生效。[S1][S2]

- 普通股票买入后在交收前不得卖出，即 A 股短线必须处理 T+1；当日触发止损只能记录为锁定风险，下一可卖时段再执行。
- 深市竞价买入通常为 100 股或整数倍，零股余额卖出需一次申报；不同板块的申报数量规则应由版本化规则表决定。
- 深市主板涨跌幅通常为 10%，创业板为 20%；IPO 后前五个交易日等情形无涨跌幅限制。沪市科创板和其他特殊情形应按各自规则解析。
- 连续竞价存在有效申报价格范围，撮合遵循价格优先、时间优先。K 线“触价”不证明队列中订单成交。
- 2026-07-06 起盘后固定价格交易扩展到全部沪深 A 股及相关品种；如果产品不支持该执行模式，必须明确按次日计划结算，不能把 15:00 后价格当作普通连续竞价成交。
- 2023-08-28 起证券交易印花税减半；股票交易印花税由出让方缴纳，当前模型使用卖出侧 `0.05%` 与法规一致。[S3]

结果标签至少区分：

```text
NOT_TRIGGERED
TRIGGERED_UNFILLED
LIMIT_UP_UNFILLED
FILLED_T1_LOCKED
TARGET_FILLED
STOP_FILLED
AMBIGUOUS_PATH
LIMIT_DOWN_EXIT_BLOCKED
TIME_EXIT
DATA_INCOMPLETE
```

建议将 `pFill` 进一步解释为“在给定订单语义、有效窗口和容量约束下成交”，不能只看下一根 K 线是否有量。若只有 OHLC，同 bar 同时触及止盈止损时采用损失优先或标记路径不明，不允许最有利成交。

### 3.5 事件催化

证监会 2025 年信息披露规则要求真实、准确、完整、及时、公平披露，并覆盖定期报告及可能显著影响价格的重大事件。[S4] 因而正式公告可作为事件源，但必须保存 `publishedAt`、来源 URL、公告类别、首次披露/更正/进展和信号时点。

同行评议结果并不支持“利好公告后一律追涨”：

- 中国研究发现机构持仓、羊群行为、信息不透明度会改变 PEAD，且长期还会反转。[S17]
- 2025 年 A 股研究甚至报告年度业绩公告后的逆向漂移，窗口为 60 日，与 1-5 日目标不一致。[S18]

因此事件层应采用如下口径：

- **召回事件：** 业绩预告/快报、重大合同、回购/增持、减持、并购重组、监管处罚、停复牌、风险警示、控制权变化。
- **可见时点：** 收盘后公告只能进入下一交易日候选；盘中公告只能在真实抓取时间之后使用。
- **特征而非标签：** 事件类型、方向、金额/市值比例、新颖度、距披露分钟数、公告后价格/成交量反应。
- **不采用：** LLM 自行判断“重大利好”后直接提升为 `READY`；新闻转载时间代替原公告时间；把未来更正公告回填到初始事件。

### 3.6 因子组合与非线性模型

LightGBM 的官方论文证明了 GOSS/EFB 带来的训练效率与可扩展性，不证明金融预测有效。[S10] Gu、Kelly、Xiu 的同行评议研究支持树和神经网络利用非线性交互，并指出动量、流动性、波动率是重要信号族，但其美国月频、长短组合结果不能直接外推。[S9]

适合本项目的顺序是：

1. 以逻辑回归/岭回归为可解释基线。
2. 使用受约束的 LightGBM 学习 `公式 × 市场 × 板块 × 流动性 × 波动 × 事件` 交互。
3. 不修改现有 `/predict` 的 36 维 OHLCV 口径；把其版本化输出作为旁路先验特征。
4. 只有在相同时间切分、相同成本和相同候选集上稳定优于基线，非线性模型才有资格进入影子排序。
5. 特征重要度只作诊断，不解释为因果。

Qlib 的价值是将数据、模型、信号、组合、执行和回测解耦，并支持滚动训练与实验记录；Qlib benchmark 数字不是本项目预期收益。[S15]

### 3.7 概率校准

模型分数和固定公式分不是概率。概率校准要求预测的 0.60 在相同条件样本中接近 60% 的实际发生频率；原始研究显示 boosted trees 的输出可能存在系统性概率失真，Platt scaling 和 isotonic regression 可改善概率质量，但必须使用独立数据拟合与评估。[S12]

三头模型建议：

```text
pFill = P(在有效窗口内按订单规则成交)
pWinGivenFill = P(成交后扣费净收益 > 0 | 已成交)
expectedNetR = E(扣费后 R | 已成交)
```

- `pFill` 与 `pWinGivenFill` 分别在独立、时间靠后的 calibration window 校准。
- 小样本优先 sigmoid/Platt；样本充分且可靠性曲线明显非线性时再用 isotonic。
- 校准方法必须由 calibration 数据选择，最终 holdout 只评估一次。
- 报告 Brier、Log Loss、可靠性分桶、校准斜率/截距；AUC 只表示排序能力。
- 分市场状态/板块阶段/时段展示校准，但小桶不足时回退全局校准或返回 `NOT_READY`，不能输出伪精确概率。
- `expectedNetR` 同时报均值、按交易日 bootstrap 下界和最差 10% 条件期望。

### 3.8 Walk-forward、多重检验与回测过拟合

White 的 Reality Check 直接针对“在大量模型中选择最优者是否只是数据窥探”的问题。[S13] Harvey、Liu、Zhu 表明因子研究中普通 `t > 2` 在大规模试验后不够严格。[S16] Bailey 等进一步指出简单 holdout 在投资回测中仍可能被反复使用而污染，并提出 CSCV/PBO。[S20]

本项目必须：

- 按交易日切分，禁止同一天横截面股票分散到训练和验证。
- 使用扩展窗口 walk-forward；每个边界净化至少 5 个交易日，覆盖最长标签窗口。
- 最终 holdout 冻结一次；改特征、阈值、股票池、成本、排序式后都生成新 trial。
- 保存所有 trial，而非只保存胜者：特征版本、参数、训练窗、校准窗、测试窗、成本假设、随机种子和结果。
- 日级指标用 moving/block bootstrap，不能把同日数千只股票视作独立样本。
- 对同一研究族使用 Reality Check/SPA、PBO 或控制 FDR 的等价方法；PBO 不能替代最终前向影子运行。
- 基线至少包括：随机同流动性、成交额排序、现有公式分、现有 36 维量化分、当前机会雷达、线性三头模型。

### 3.9 组合去重

同板块五只股票不是五个独立机会。当前固定板块上限是正确的第一步，但行业标签无法捕获跨概念供应链、指数 beta 和近期同涨同跌。

建议使用透明的约束式贪心选择：

1. 先按 `pFill × netRLowerBound - λ × abs(expectedShortfall10)` 排序。
2. 每个申万行业/主要概念最多 1-2 只。
3. 对候选与已有持仓计算截至决策时点的 20/60 日收益相关性；高相关候选只保留效用更高者。
4. 在停牌、涨跌停等缺失日使用 pairwise overlap，并要求最小共同样本；样本不足不宣称低相关。
5. 限制单股、单板块、总新增风险、现金占用和 T+1 锁定风险。
6. 记录“个股合格但因组合重复被降级”，不修改个股模型结论。

不建议首期直接做无约束均值方差优化或复杂 HRP。1-5 日样本下预期收益与协方差噪声大，透明的行业上限加相关性去重更容易审计。

## 4. 面向当前实现的差距判断

### 4.1 应保留

- `api/_formula_selection_data.js` 已在筛选前校验全市场数量和股票代码唯一性，满足“先完整读取、后分层减负”的底线。
- `shared/opportunityRadarLedger.js` 已保存预筛、技术、证据和展示阶段，以及规则/公式版本和拒绝原因。
- `shared/opportunityOutcomeResolver.js` 已区分未触发、触发未成交、涨停买不到、T+1 锁定、跌停退出受阻、路径不明和扣费后结果。
- `qlib-service/train_opportunity_score.py` 已实现 `pFill / pWinGivenFill / expectedNetR`、逻辑/岭基线、独立校准窗、5 日净化、walk-forward、Top-5 排序指标和 block bootstrap 下界。
- `shared/opportunityPortfolio.js` 已有单股、单板块和总新增风险上限；`shared/opportunityDriftMonitor.js` 已监控净 R、胜率、覆盖率和连续亏损。
- 当前旁路保持 `shadowOnly`、不改变展示排序，是正确上线顺序。

### 4.2 当前主要缺口

1. **召回域过窄。** 盘中预筛固定要求涨幅 `0.5%-5%`、成交额不低于 5000 万、换手不低于 2%；收盘要求涨幅 `-3%-4%`。这些是经验阈值，不是已证明的最优召回边界，可能系统性漏掉低换手机构票、事件跳空、弱转强和深跌反转。
2. **账本从预筛后开始。** `candidateEvents` 只覆盖通过实时预筛的股票，无法测量“预筛漏掉了多少成熟好结果”，因此当前只能评估精度，不能可靠评估召回率。
3. **三头特征仍偏薄。** 现有特征主要为公式分、当日涨幅、成交额、换手、量比、主力比例、价格合同、市场/板块枚举；缺少 `ret_1d` 与 `ret_2_5d` 分解、板块残差、实现波动、Amihud 代理、涨跌停路径和事件时点。
4. **组合层未做收益相关性去重。** 当前主要按板块名称和固定仓位上限约束，跨概念同向暴露仍可能重复。
5. **成本仍有固定假设。** 佣金和 5 bps 滑点适合作为基线，但不应成为唯一回测情景。
6. **试验登记已存在，但多重检验统计尚未成为硬门禁。** `opportunity_trials.jsonl` 是良好基础，应继续计算有效试验数、PBO/Reality Check/FDR 结果。

## 5. 可直接映射到 Level-1 与三头模型的 P0/P1/P2

## P0：把召回与标签测对，不改变用户排序

### P0-1 候选 lane 扩展

在完整市场快照之后生成并集，不按排名提前截断：

| Lane | Level-1 可计算条件 | 进入三头模型的新增字段 |
| --- | --- | --- |
| 1 日相对动量 | `ret_1d` 高于行业/指数，量能未衰减，非一字涨停 | `ret1dResidual`、`closeLocation`、`limitDistanceAtr` |
| 2-5 日相对动量 | `ret_2_5d` 与板块同向，扩散未恶化 | `ret2to5dResidual`、`sectorRet3d/5d` |
| 1 日反转 | 大幅负残差后缩量止跌或重新站回 VWAP | `shockReturn1d`、`vwapRecovery`、`downsideVol` |
| 2-5 日反转 | 2-5 日超跌但未处于连续跌停/退潮板块 | `ret2to5d`、`atrDistanceFromLow` |
| 量价扩张 | 成交额/量比异常且收盘位置强 | `amountPctRank`、`volumeZ5/20`、`rangePct` |
| 事件观察 | 正式公告后首个可交易时点 | `eventType`、`eventAgeMin`、`eventReaction` |
| 现有公式 | 回踩、资金先行、趋势回踩、蓄势突破、尾盘反转 | 保留现有 `formula*` 字段 |

P0 不改变现有公式结论，只把上述 lane 记入 shadow ledger。每个交易日额外保存一小份按流动性分层的随机未入池样本，用于估算机会召回率；不得只给展示候选贴标签。

### P0-2 特征合同 v2

保持 `/predict` 36 维模型不变，为 `opportunity-score-feature.v2` 增加：

```text
return: ret1d, ret2to5d, marketResidual, sectorResidual
sector: sectorRet1d/3d/5d, breadth, flowPersistence, leaderConcentration
liquidity: logAmount, amountPctRank, turnover, amihud5d, volumeRatio
volatility: atrPct, realizedVol5d/20d, downsideVol5d, intradayRangePct
execution: distanceToLimitAtr, atLimit, noLimitPeriod, gapPct, timeBucket
event: type, directionUnknown, ageMinutes, officialSource, reactionReturn
contract: entry/stop/target distance, riskReward, validityMinutes
```

所有横截面分位按“当日、可交易股票池”计算；缺失用显式 missing flag，不用 `0` 冒充真实值。

### P0-3 标签与成本审计

- 对至少 100 个随机事件人工核对触发、下一 bar 成交、T+1、涨跌停、同 bar 路径、费用和时间退出。
- 费用配置版本化：用户佣金/最低佣金、卖出印花税、过户费；回测保存 fee policy ID。
- 滑点至少三档：`0 bps` 诊断、Level-1 基准、压力档；正式门禁看基准与压力，不看乐观档。
- 增加订单参与率上限。只有日/分钟成交量而无盘口时，超过 bar 成交量固定比例的订单应拒绝或施加冲击，不可默认全成。

### P0-4 评价面板

- 候选层：相对事后“可成交且净 R > 0”事件的 recall、每次扫描候选数、各 lane 重叠率。
- 三头：Brier、Log Loss、AUC、MAE、Rank IC。
- 排序：`Precision@3/5`、`NDCG@5`、`NetR@5`、下置信界。
- 执行：触发率、成交率、涨停未成交率、跌停退出受阻率、T+1 锁定止损率。
- 分桶：公式、lane、市场状态、板块阶段、时段、流动性、波动率、事件/非事件。

**P0 退出条件：** 数据时点审计通过；召回可测；成本与规则版本化；前台仍使用现有确定性排序。

## P1：训练并校准候选排序，仍只影子运行

### P1-1 三头训练

- `pFill` 使用全部成熟候选，未成交保留为负样本。
- `pWinGivenFill` 与 `expectedNetR` 仅使用真实可成交且结果成熟的条件样本。
- 先训练逻辑/岭基线，再训练浅层、强正则 LightGBM；超参数搜索范围预注册。
- 采用按日期扩展窗口 walk-forward，训练/校准/测试边界均净化 5 个交易日。
- 分别评估 1、3、5 日结果；首期可共享特征但不混成一个含义不清的标签。

### P1-2 概率与排序

建议影子效用：

```text
grossUtility = calibratedPFill * netRLowerBound
riskAdjustedUtility =
  grossUtility
  - lambdaTail * abs(expectedShortfall10)
  - liquidityPenalty
```

`pWinGivenFill` 用于解释和阈值，不重复乘入已经由 `expectedNetR` 包含的胜负结果，避免双重计数。只有当最终测试窗和至少两个 walk-forward 窗同时满足以下条件，才进入只读展示：

- 两个分类头的 Brier/Log Loss不劣于线性基线。
- `NetR@5` 下置信界大于 0，且优于当前公式分排序。
- 压力成本下没有转为显著负期望。
- 主要市场状态、lane 和流动性桶不存在灾难性失效。
- 校准样本不足、过期或 OOD 时返回 `NOT_READY`，自动回退现有排序。

### P1-3 多重检验门禁

- `opportunity_trials.jsonl` 记录所有成功和失败试验。
- 每个研究族计算 PBO 或 White Reality Check/SPA；同时报告有效试验数和 FDR 调整。
- 最终 holdout 不参与阈值、特征、校准方法或成本参数选择。
- 禁止以单个高 AUC、单次高胜率、单月收益或某只牛股案例发布模型。

**P1 退出条件：** 模型只读展示；概率有时间外校准证据；任何失败自动回退；不改变 `/predict` 36 维口径。

## P2：组合去重、事件质量和线上漂移

### P2-1 组合选择

- 在现有板块上限上增加 20/60 日相关性去重及与已有持仓的边际相关性。
- 同行业/主概念最多 1-2 只；高相关候选保留 `riskAdjustedUtility` 更高者。
- 仓位按止损距离计算风险金额，再向下取整到合法申报单位。
- 同时约束现金、未完成买入占用、单股、单板块、总新增风险和 T+1 锁定敞口。

### P2-2 事件质量

- 正式公告源进入 point-in-time 存储；新闻/搜索只作补充。
- 建立公告去重、修订链和发布时间审计。
- 只有事件模型在独立样本中证明对现有 Level-1 模型有增量，才保留事件特征；否则事件只用于解释。

### P2-3 线上监控

- 滚动监控 Brier、Log Loss、校准截距/斜率、`NetR@5`、成交率、覆盖率和 OOD。
- 分 lane、市场状态、板块阶段、流动性与事件类型监控。
- 漂移只触发降级或人工复核，不自动重新训练并发布。
- 新模型遵循 champion-challenger：影子运行、只读展示、有限排序、正式排序逐级晋级。

**P2 退出条件：** 组合层相对逐股 Top-5 降低集中度和压力回撤；概率在前向样本中保持校准；线上失效可自动回退。

## 6. 明确不采用项

| 不采用项 | 原因 |
| --- | --- |
| 固定声称“短期动量有效”或“超跌必反弹” | 中国证据在不同尺度、状态和流动性下相互冲突。[S5][S6] |
| 把经典 3-12 月动量直接改成 1-5 日策略 | 时间尺度、市场和交易约束不一致。[S8] |
| 追涨停、连板数、封单额直接作为买入充分条件 | 涨停会扭曲收益，触价不等于成交，后续既有延续也有过度反应证据。[S7] |
| LLM 读新闻后生成概率、目标价或“必涨催化” | 不可校准、不可重放，且新闻时间可能晚于原始公告。 |
| 把“主力资金”当真实机构身份 | Level-1 大小单只是成交规模代理，缺少账户身份。 |
| 仅按 AUC/准确率选模型 | 不能说明概率可信、Top-K 有效或扣费后盈利。 |
| 全市场先按涨幅榜/资金榜截 Top-N 再筛 | 破坏召回率并引入选择偏差；只允许完整读取后的计算分层。 |
| 将未成交样本删除或算作普通亏损 | 会分别高估策略质量或混淆选股与执行；应由 `pFill` 单独监督。 |
| 固定 5 bps 作为唯一成本 | 无法覆盖低流动性、开盘/尾盘、高波动和接近涨跌停情形。[S14] |
| 只报告最佳参数、最佳月份或最佳股票 | 属于数据窥探；必须保存全部试验并做多重检验。[S13][S16][S20] |
| 直接采用复杂深度网络 | 当前成熟事件样本有限，LightGBM/线性基线更易校准、审计和回退。 |
| 无约束均值方差优化或直接上 HRP | 1-5 日协方差和收益估计噪声大；先做板块上限和透明相关性去重。 |
| 引用平台 benchmark、券商回测或营销“胜率”作为上线证据 | 数据、成本、股票池、时点和多重试验通常与本项目不一致。 |

## 7. 推荐的最小发布合同

候选记录：

```json
{
  "decisionId": "2026-09-03:INTRADAY:1035:000001",
  "asOf": 1788402900000,
  "code": "000001",
  "candidateLanes": ["MOMENTUM_1D", "INTRADAY_VWAP_PULLBACK"],
  "featureSchemaVersion": "opportunity-score-feature.v2",
  "ruleVersion": "CN_A_SHARE_2026_07_06",
  "formulaVersion": "formula-selection.v1",
  "quantModelVersion": "current-36d-version",
  "eventVersion": null,
  "features": {},
  "priceContract": {},
  "rejectionReasons": []
}
```

排序输出：

```json
{
  "state": "READY",
  "modelVersion": "opportunity-score.v2",
  "pFill": 0.0,
  "pWinGivenFill": 0.0,
  "expectedNetR": 0.0,
  "netRLowerBound": 0.0,
  "expectedShortfall10": 0.0,
  "calibration": {
    "method": "sigmoid|isotonic",
    "sampleCount": 0,
    "asOf": "YYYY-MM-DD",
    "bucket": "..."
  },
  "outOfDistribution": false
}
```

面向用户只表达条件概率与样本边界，例如“同条件 186 次，实际成交 121 次；当前桶样本不足，降级观察”，不显示未经校准的百分比，不使用“高胜率”“稳赚”“必涨”等措辞。

## 8. 来源评价表

评分：可信度、时效性、相关性均为 0-10；综合分 = `0.5×可信度 + 0.2×时效性 + 0.3×相关性`。旧论文的时效分低不代表失效，而是提醒其制度与样本外推风险。

| ID | 来源与日期 | 类型 | 可信度 | 时效性 | 相关性 | 综合 | 主要用途 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| S1 | 上交所《交易规则（2026 年修订）》；2026-04-24/07-06 生效 | 官方规则 | 10 | 10 | 10 | 10.0 | 沪市交易与涨跌停约束 |
| S2 | 深交所《交易规则（2026 年修订）》；2026-04-24/07-06 生效 | 官方规则 | 10 | 10 | 10 | 10.0 | T+1、申报、价格笼子、撮合 |
| S3 | 《印花税法》；2021-06-10；财政部、税务总局减半征税公告；2023-08-27 | 官方法律/政策 | 10 | 6 | 9 | 8.9 | 卖出侧成本 |
| S4 | 证监会《上市公司信息披露管理办法》；2025-03-26/07-01 生效 | 官方规则 | 10 | 9 | 8 | 9.2 | 事件事实源和时点 |
| S5 | Neszveda et al., Finance Research Letters；2022 | 同行评议 | 9 | 5 | 10 | 8.5 | 中国短期动量/反转冲突 |
| S6 | Chu et al., Finance Research Letters；2019 | 同行评议 | 9 | 4 | 9 | 8.0 | 中国日内动量、反转与成本 |
| S7 | Liu et al., Economic Modelling；2022；Wan et al., PLOS ONE；2015 | 同行评议 | 9 | 5 | 9 | 8.2 | 涨跌停后的收益与制度截断 |
| S8 | Jegadeesh & Titman, Journal of Finance；1993 | 同行评议 | 10 | 1 | 7 | 7.3 | 经典中期横截面动量边界 |
| S9 | Gu, Kelly & Xiu, Review of Financial Studies；2020 | 同行评议 | 10 | 4 | 8 | 8.2 | 非线性交互与信号族 |
| S10 | Ke et al., NeurIPS；2017 | 原始同行评议论文 | 10 | 3 | 8 | 8.0 | LightGBM 能力边界 |
| S11 | Moskowitz & Grinblatt, Journal of Finance；1999 | 同行评议 | 10 | 2 | 8 | 7.8 | 行业动量条件变量 |
| S12 | Niculescu-Mizil & Caruana, ICML；2005；Guo et al., ICML；2017 | 原始同行评议论文 | 10 | 3 | 9 | 8.3 | Boosted trees 与概率校准 |
| S13 | White, Econometrica；2000 | 同行评议 | 10 | 2 | 9 | 8.1 | 数据窥探 Reality Check |
| S14 | Novy-Marx & Velikov, RFS；2016 | 同行评议 | 10 | 3 | 10 | 8.6 | 换手、成本、buy/hold spread |
| S15 | Microsoft Qlib 原论文；2020 | 原始 arXiv/官方项目 | 9 | 4 | 9 | 8.0 | 量化工作流与解耦 |
| S16 | Harvey, Liu & Zhu, RFS；2016 | 同行评议 | 10 | 3 | 9 | 8.3 | 因子多重检验 |
| S17 | Cai et al., Accounting and Business Research；2020 | 同行评议 | 9 | 4 | 7 | 7.4 | 中国 PEAD 条件性 |
| S18 | Wang, Applied Economics Letters；2025 | 同行评议 | 9 | 9 | 6 | 8.1 | A 股逆向 PEAD 反证 |
| S19 | Jiao & Zheng, Pacific-Basin Finance Journal；2026 | 同行评议 | 9 | 10 | 6 | 8.3 | 聚类反转及不可外推边界 |
| S20 | Bailey et al., Journal of Computational Finance；2017 | 同行评议 | 9 | 3 | 9 | 7.8 | PBO/CSCV |

## 9. 来源链接与核验摘录

[S1] **上海证券交易所交易规则（2026 年修订）**，上交所，发布 2026-04-24，生效 2026-07-06。
https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml
核验点：现行有效；盘后固定价格交易扩展至全部 A 股；主板风险警示股票涨跌幅改为 10%。

[S2] **深圳证券交易所交易规则（2026 年修订）**，深交所，发布 2026-04-24，生效 2026-07-06。
http://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf
核验点：3.1.4 交收前不得卖出；3.3.8 买入 100 股或整数倍；3.3.13 主板 10%、创业板 20%；3.3.16 价格笼子；3.4.2 价格优先、时间优先。

[S3] **中华人民共和国印花税法**，全国人大常委会，2021-06-10；**关于减半征收证券交易印花税的公告**，财政部、税务总局，2023-08-27。
http://www.npc.gov.cn/npc/c2/c30834/202106/t20210610_311898.html
https://www.gov.cn/zhengce/zhengceku/202308/content_6900443.htm
核验点：证券交易印花税只对出让方征收；2023-08-28 起减半。

[S4] **上市公司信息披露管理办法（证监会令第 226 号）**，中国证监会，2025-03-26，2025-07-01 生效。
https://www.csrc.gov.cn/csrc/c101953/c7547359/content.shtml
核验点：信息披露应真实、准确、完整、及时、公平；为事件数据的官方时点边界。

[S5] **Is short-term reversal driven by liquidity provision in emerging markets? Evidence from China**，Neszveda et al., *Finance Research Letters*, 2022。
https://doi.org/10.1016/j.frl.2022.103220
核验点：中国样本最近 1 日呈动量，反转由少数日期驱动，流动性解释与美国证据不一致。

[S6] **Intraday momentum and reversal in Chinese stock market**，Chu, Gu & Zhou, *Finance Research Letters*, 2019。
https://doi.org/10.1016/j.frl.2019.04.002
核验点：中国日内同时存在动量与反转；论文明确指出成本妨碍套利。

[S7] **Price overreaction to up-limit events and revised momentum strategies in the Chinese stock market**，Liu, Wu & Zhu, *Economic Modelling*, 2022。
https://doi.org/10.1016/j.econmod.2022.105910
补充交叉验证：Wan et al., **Statistical Properties and Pre-hit Dynamics of Price Limit Hits in the Chinese Stock Markets**, *PLOS ONE*, 2015。
https://doi.org/10.1371/journal.pone.0120312
核验点：涨跌停事件会改变普通动量度量；涨跌停后延续/反转具有非对称性。

[S8] **Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency**，Jegadeesh & Titman, *Journal of Finance*, 1993。
https://doi.org/10.1111/j.1540-6261.1993.tb04702.x
核验点：经典横截面动量的主要时间尺度为月度中期，不能直接外推至 A 股 1-5 日。

[S9] **Empirical Asset Pricing via Machine Learning**，Gu, Kelly & Xiu, *Review of Financial Studies*, 2020。
https://academic.oup.com/rfs/article/33/5/2223/5758276
核验点：树/神经网络的增益来自非线性交互；重要信号族包括动量、流动性与波动率；样本为美国、月频。

[S10] **LightGBM: A Highly Efficient Gradient Boosting Decision Tree**，Ke et al., NeurIPS, 2017。
https://proceedings.neurips.cc/paper/2017/hash/6449f44a102fde848669bdd9eb6b76fa-Abstract.html
核验点：GOSS/EFB 提升 GBDT 训练效率；不提供金融 alpha 保证。

[S11] **Do Industries Explain Momentum?**，Moskowitz & Grinblatt, *Journal of Finance*, 1999。
https://doi.org/10.1111/0022-1082.00146
核验点：行业动量解释相当部分个股动量；原研究不是中国 1-5 日策略。

[S12] **Predicting good probabilities with supervised learning**，Niculescu-Mizil & Caruana, ICML, 2005；**On Calibration of Modern Neural Networks**，Guo et al., ICML/PMLR, 2017。
https://doi.org/10.1145/1102351.1102430
https://proceedings.mlr.press/v70/guo17a.html
核验点：boosted trees 的原始概率可能失真；Platt scaling 与 isotonic regression 可用于校准；校准应在独立数据上评估。

[S13] **A Reality Check for Data Snooping**，White, *Econometrica*, 2000。
https://doi.org/10.1111/1468-0262.00152
核验点：反复复用同一历史进行模型选择会把偶然结果误判为预测优势。

[S14] **A Taxonomy of Anomalies and Their Trading Costs**，Novy-Marx & Velikov, *Review of Financial Studies*, 2016。
https://doi.org/10.1093/rfs/hhv063
核验点：高换手异常经成本后大幅衰减；新建仓与持有使用不同阈值能有效控制成本。

[S15] **Qlib: An AI-oriented Quantitative Investment Platform**，Microsoft Research，arXiv 原论文，2020-09-22。
https://arxiv.org/abs/2009.11189
官方仓库：https://github.com/microsoft/qlib
核验点：覆盖数据、模型、信号、组合、执行、回测与滚动训练工作流；平台能力不等于策略有效。

[S16] **...and the Cross-Section of Expected Returns**，Harvey, Liu & Zhu, *Review of Financial Studies*, 2016。
https://www.nber.org/papers/w20592
核验点：大量因子试验下普通显著性阈值不足，需控制多重检验。

[S17] **The role of institutional investors in post-earnings announcement drift: evidence from China**，Cai et al., *Accounting and Business Research*, 2020。
https://doi.org/10.1080/00014788.2020.1773755
核验点：中国 PEAD 随机构行为和信息不透明度变化，且更长窗口存在反转。

[S18] **Inverse post-earnings-announcement drift**，Wang, *Applied Economics Letters*, 2025-12-28。
https://doi.org/10.1080/13504851.2025.2608299
核验点：A 股年度公告后 60 日报告逆向漂移；对 1-5 日只构成“不可预设方向”的反证。

[S19] **Clustering-augmented reversal strategy improves return performance: Evidence from Chinese stock market**，Jiao & Zheng, *Pacific-Basin Finance Journal*, 2026。
https://doi.org/10.1016/j.pacfin.2025.102996
核验点：聚类后月度反转改善主要来自空头腿；不适用于本项目长仓、1-5 日直接复制。

[S20] **The Probability of Backtest Overfitting**，Bailey, Borwein, López de Prado & Zhu, *Journal of Computational Finance*, 2017。
https://escholarship.org/uc/item/4w1110bb
核验点：普通 holdout 在投资策略选择中仍可能失效；CSCV 用于估计 PBO。

## 10. 最终结论

机会雷达不应寻找一条“最准公式”，而应把问题拆成三个可验证层次：

```text
高召回候选：
  多 lane、完整市场、保留失败样本，不预设动量或反转永远有效

可校准排序：
  pFill + pWinGivenFill + expectedNetR
  独立校准、walk-forward、Top-K 净收益、多重检验

可成交与组合风控：
  T+1 + 涨跌停 + 队列/容量 + 费用/滑点
  板块上限 + 相关性去重 + 现金与锁定风险
```

当前代码已经完成了这条路线最难的基础设施部分。优先级应是：P0 扩大且测量召回、升级 Level-1 特征与成本标签；P1 用现有三头模型做严格时间外校准和多重检验；P2 再加入相关性去重、官方事件质量与线上校准漂移。任何阶段都不应承诺准确率，只有在同一候选集、同一成本、同一规则和不可重复使用的时间外样本上，才讨论相对现有基线的增量。
