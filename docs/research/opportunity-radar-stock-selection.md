# 机会雷达升级为实用选股利器：研究结论与实施路线

> 研究日期：2026-09-02
> 范围：A 股 1-5 个交易日短线决策；研究与人工执行工具，不含自动下单
> 结论边界：本文不承诺“选对股”。可被工程化改善的目标是条件胜率、扣费后期望值、概率可信度、可成交性和组合风险。

## 一、执行摘要

当前机会雷达的方向是对的：它已经把板块前瞻、盘中/收盘公式和尾盘反转合并为一个确定性入口，并且要求完整价格合同、数据新鲜度、板块资格和至少 `1.8:1` 的事前盈亏比。真正的短板不是再增加几个技术指标，而是缺少一条从“候选出现”到“可成交净结果”的统一证据链。

最值得投入的升级不是让 LLM 直接选股，也不是继续调整手工权重，而是建立以下闭环：

```text
时点一致的全市场候选
  -> 市场/板块条件
  -> 个股触发与可成交性
  -> T+1 约束下的卖出路径
  -> 扣除佣金、印花税、过户费、滑点后的净结果
  -> 严格走样本外验证
  -> 概率校准
  -> 组合去重与风险预算
  -> 全候选影子结算 + 真实成交归因
```

核心建议只有三条：

1. **先改评价对象，再改模型。** 当前量化主标签是“未来 5 日最高价是否触及目标”，它不能回答触发后能否成交、止损是否先发生、T+1 后能否退出，以及扣费后是否赚钱。机会雷达需要独立的“可执行交易结果标签”，但不应修改现有 `/predict` 的 36 维口径。
2. **把规则当召回器，把模型当排序与校准器。** 盘中回踩、资金先行、趋势回踩、蓄势突破和尾盘反转适合产生可解释候选；是否优先展示，应由走样本外的条件概率、净期望和下行风险决定，而不是固定公式分或新的黑盒总分。
3. **先做影子账本，后谈上线概率。** 对所有候选而非仅用户成交的股票持续结算结果，按公式、市场状态、板块阶段、时段和流动性分桶评估。只有在时间外样本中同时改善校准、Top-K 质量和扣费后期望，才允许从“观察”升级为带概率的“优先关注”。

## 二、最有价值的 10 组一手来源

下表将“市场规则”“可验证研究结论”和“平台能力”分开。平台文档只能证明工具支持某项功能，不能证明某个选股公式有效。

| # | 一手来源 | 可支持的结论 | 不能推出的结论 |
| --- | --- | --- | --- |
| 1 | [上海证券交易所交易规则（2026 年修订）](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml) | 沪市交易时段、T+1、申报单位、价格笼子、涨跌幅和盘后固定价格交易的现行规则 | 任何技术指标有超额收益 |
| 2 | [深圳证券交易所交易规则（2026 年修订）](http://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf) | 深市 T+1、100 股申报单位、主板/创业板涨跌幅、价格笼子和盘后交易规则 | 平台默认撮合能代表真实成交 |
| 3 | [财政部、税务总局关于减半征收证券交易印花税的公告](https://www.gov.cn/zhengce/zhengceku/202308/content_6900443.htm)；[中国结算收费标准入口](http://www.chinaclear.cn/zdjs/fbzyls/service_tlist.shtml) | 证券交易印花税减半政策；过户费应从中国结算现行表读取并版本化 | 券商佣金固定为同一个费率 |
| 4 | Tushare 官方文档：[股票基础信息](https://tushare.pro/document/2?doc_id=25)、[日线行情](https://tushare.pro/document/2?doc_id=27)、[复权因子](https://tushare.pro/document/2?doc_id=28)、[每日指标](https://tushare.pro/document/2?doc_id=32)、[停复牌](https://tushare.pro/document/2?doc_id=214)、[资金流](https://tushare.pro/document/2?doc_id=170) | 可构建上市/退市、复权、停牌、流动性和订单规模代理数据；文档给出了字段及更新时间 | “主力资金”字段等于真实机构身份，或该字段天然有预测力 |
| 5 | [Microsoft Qlib 论文](https://arxiv.org/abs/2009.11189)；[Qlib 官方工作流](https://qlib.readthedocs.io/en/latest/component/workflow.html) | 数据、模型、信号、组合、执行、回测和实验记录应解耦；训练/验证/测试可按时间分段 | 使用 Qlib 或 LightGBM 本身即可获得稳定 alpha |
| 6 | Jegadeesh & Titman, [Returns to Buying Winners and Selling Losers](https://doi.org/10.1111/j.1540-6261.1993.tb04702.x) | 3-12 个月横截面动量是经典、可复核的经验事实 | 该结论可直接外推为 A 股 1-5 日买点 |
| 7 | Moskowitz & Grinblatt, [Do Industries Explain Momentum?](https://doi.org/10.1111/0022-1082.00146) | 行业动量可解释相当部分个股动量，支持将板块状态作为个股条件变量 | 某个概念板块当日流入必然延续 |
| 8 | Daniel & Moskowitz, [Momentum Crashes](https://www.kentdaniel.net/papers/published/jfe_16.pdf) | 动量收益有明显状态依赖，高波动、市场下跌后的反弹阶段可能发生崩溃 | 简单的牛熊标签即可消除所有状态风险 |
| 9 | Gu, Kelly & Xiu, [Empirical Asset Pricing via Machine Learning](https://academic.oup.com/rfs/article/33/5/2223/5758276) | 非线性和变量交互可能改善横截面预测；动量、流动性、波动率是重要信息族；必须看样本外经济价值 | 更深、更复杂的模型必然更好，或论文结果可直接迁移到 A 股短线 |
| 10 | Novy-Marx & Velikov, [A Taxonomy of Anomalies and Their Trading Costs](https://academic.oup.com/rfs/article-abstract/29/1/104/1844518)；Bailey 等，[The Probability of Backtest Overfitting](https://escholarship.org/uc/item/4w1110bb)；Harvey、Liu、Zhu，[...and the Cross-Section of Expected Returns](https://www.nber.org/papers/w20592)；Guo 等，[On Calibration of Modern Neural Networks](https://proceedings.mlr.press/v70/guo17a.html) | 交易成本会侵蚀异常收益；多重试验会抬高最佳回测结果；概率输出需要独立校准与可靠性检验 | 一次 holdout、一个高 AUC 或一个漂亮 Sharpe 足以证明可上线 |

补充的平台能力参考：

- [TradingView Pine 策略文档](https://www.tradingview.com/pine-script-docs/concepts/strategies/)说明其经纪商模拟器依赖图表数据并对 bar 内路径作假设；[Bar Magnifier](https://www.tradingview.com/support/solutions/43000669285-what-is-bar-magnifier-backtesting-mode/)可提高粒度，但仍是模拟。适合原型验证，不是收益证据。
- [QuantConnect Reality Modeling](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/key-concepts)和[滑点文档](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/slippage/key-concepts)展示了成交、费用、滑点、结算和容量应作为独立模型。适合作为回测架构参考，不是 A 股规则来源。
- [聚宽官方 API 文档](https://www.joinquant.com/help/api/help?name=api)明确提供退市股票、历史指数成分和真实价格模式，并说明未来数据防护；[米筐 RQAlpha Plus 配置](https://www.ricequant.com/doc/rqalpha-plus/api/config)提供 T+1、涨跌停、成交量限制、撮合、滑点和时点税率配置。这些是平台能力，不等于其示例策略有效。

## 三、A 股约束必须进入标签，而不只是前端提示

截至本文日期，沪深交易所 2026 年修订规则已经生效。与机会雷达直接相关的事实是：

- 普通 A 股买入通常要求 100 股或其整数倍；零股余额卖出需一次申报。科创板另有最低申报数量安排，应按板块规则单独配置，而不能只用一个全市场 `lotSize`。[上交所规则 3.3.8、科创板特别规定](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml)、[深交所规则 3.3.8](http://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf)
- 投资者买入的普通股票在交收前不得卖出，即短线回测必须显式处理 T+1；买入当日触发的止损不是可执行卖出。[上交所规则 3.1.4](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml)、[深交所规则 3.1.4](http://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf)
- 主板通常为 10%，创业板和科创板通常为 20%；首次公开发行上市后的前五个交易日等情形不设日涨跌幅限制。2026 年 7 月 6 日起，沪深主板风险警示股票的涨跌幅限制已调整为 10%。[上交所 2026 修订说明](http://big5.sse.com.cn/site/cht/www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20260424_10816474.shtml)、[深交所 2026 规则](http://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf)
- 连续竞价存在有效申报价格范围，撮合遵循价格优先、时间优先；“价格触及”不等于你的订单必然成交。[上交所规则 3.3.14、3.5.1](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml)、[深交所规则 3.3.16、3.4.2](http://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf)
- 2026 年 7 月 6 日起，盘后固定价格交易扩展至沪深全部 A 股和 ETF，交易时段为 15:05-15:30。这意味着“15:00 后一律只能做次日计划”已不再完整描述可用交易窗口，但是否把该时段纳入产品仍需单独评估流动性和用户券商支持。[上交所 2026 规则 3.7](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml)、[深交所技术通知](http://www.szse.cn/marketServices/technicalservice/notice/t20260424_620199.html)
- 印花税只向出让方征收，2023 年 8 月 28 日起减半，即当前股票卖出侧税率为成交额的 `0.05%`；佣金是账户级参数，不应被写死为所有用户相同。[印花税法](http://www.npc.gov.cn/npc/c2/c30834/202106/t20210610_311898.html)、[减半征收公告](https://www.gov.cn/zhengce/zhengceku/202308/content_6900443.htm)

因此，回测中的一次候选结果至少要区分：

```text
未触发
触发但不可成交
部分成交
已成交但 T+1 锁定
止盈先到
止损先到
同 bar 路径不明
跌停无法卖出
时间退出
样本未成熟
```

只用未来最高价判断“达标”，会把不可成交、先止损后反弹、涨停买不到、跌停卖不出和成本侵蚀都混入正样本。

## 四、当前系统已经具备的正确基础

### 4.1 候选发现

- 公式选股会先读取完整市场，校验 `allList.length === inspectedCount === total`，再做预筛；这是避免“只扫涨幅榜前 N 名”的正确底座。[`api/_formula_selection_data.js`](../../api/_formula_selection_data.js#L55-L70)
- 盘中与收盘公式为确定性代码，LLM 不参与命中；当前四类公式覆盖回踩承接、资金先行、趋势回踩和波动收敛突破。[`shared/formulaSelection.js`](../../shared/formulaSelection.js#L1-L32)
- 公式候选在补抓日线、分时、资金和标签后才形成价格合同，并且最终只限制展示数量，而非限制参与初筛的股票。[`api/_formula_selection_data.js`](../../api/_formula_selection_data.js#L157-L215)

### 4.2 市场、板块与时点

- 板块前瞻已把资金持续性、加速度、相对位置、成分股扩散、龙头结构、流动性和市场适配拆开，并对拥挤与背离单独惩罚。[`shared/sectorForecast.js`](../../shared/sectorForecast.js#L257-L401)
- 机会雷达只聚合现有权威快照，按日期判断新鲜度，并将板块、盘中/收盘公式和尾盘结果分 lane 合并。[`shared/opportunityRadar.js`](../../shared/opportunityRadar.js#L482-L641)
- 当前状态设计 `READY / WAIT_TRIGGER / SECTOR_WATCH / AVOID` 能把“方向值得看”和“个股可以执行”分开，这是正确的产品语义。

### 4.3 价格、卖出与执行

- 未持仓候选必须形成入场、止损、目标和至少 `1.8:1` 的事前盈亏比；否则返回不可执行。[`shared/formulaPriceEngine.js`](../../shared/formulaPriceEngine.js#L49-L145)
- 已持仓路径已经考虑硬止损、资金背离减仓、目标减仓、移动风险边界和今日可卖数量。[`shared/formulaPriceEngine.js`](../../shared/formulaPriceEngine.js#L148-L248)
- 回测基础设施已按下一根 K 线成交、T+1、100 股整手、涨跌停不可成交、费用和滑点建模，并保存逐笔成交与 FIFO 配对结果。[`shared/backtest/engine.js`](../../shared/backtest/engine.js#L1-L227)
- 真实人工成交归因已记录成交率、决策/执行滑点、VWAP 偏离、费用、MFE、MAE 和利润捕获率，并且只有完整核验结果才允许学习。[`shared/executionAttribution.js`](../../shared/executionAttribution.js#L107-L217)

### 4.4 量化验证

- 现有日线模型保持 36 维训练/推理同源，扩展因子曾因样本外表现下降而未进入线上口径。[`qlib-service/factors_lib.py`](../../qlib-service/factors_lib.py#L22-L44)
- 冠军-挑战者流程使用适配窗和前向盲测窗，并比较 AUC、LogLoss 和 Top10% 精度；生产模型还持续结算训练截止日之后的成熟样本。[`qlib-service/retrain_daily.py`](../../qlib-service/retrain_daily.py#L1-L29)、[`qlib-service/production_backtest.py`](../../qlib-service/production_backtest.py#L258-L399)

这些能力应保留，不需要推倒重来。

## 五、当前系统的关键差距

### P0：规则口径已经出现生产偏差

[`shared/priceLimitPolicy.js`](../../shared/priceLimitPolicy.js#L17-L22) 和 [`shared/ashareStrategyExecution.js`](../../shared/ashareStrategyExecution.js#L29-L40) 仍把主板 ST 股票按 5% 涨跌幅处理；2026 年 7 月 6 日生效的沪深规则已调整为 10%。即使雷达当前排除 ST，这个共享策略执行模块仍会影响历史回测、其它策略或未来扩展。

同时，当前公式池在 [`api/_formula_selection_data.js`](../../api/_formula_selection_data.js#L40-L52) 排除 `68`、`4`、`8`、`9` 开头股票，实际上并非覆盖“全部 A 股可选标的”。这可以是合理的风险范围，但产品与评测必须明确写成“完整读取全市场后，仅选择沪深主板与创业板非 ST 股票”，或者在补齐科创板/北交所规则和样本外验证后再扩围。

### P0：量化标签与用户真正关心的交易结果不一致

现役主模型的目标是：

```text
未来 5 日最高价 >= 当前收盘价 × (1 + max(3%, 0.8 × ATR14 / 当前价))
```

见 [`qlib-service/factors_lib.py`](../../qlib-service/factors_lib.py#L479-L482) 和 [`qlib-service/retrain_daily.py`](../../qlib-service/retrain_daily.py#L760-L769)。

这个标签适合衡量“未来是否曾出现上冲”，但不等价于：

- 用户在信号后是否有合法成交机会。
- 入场后是止盈先到还是止损先到。
- T+1 锁定期间是否先发生大幅回撤。
- 目标价是否因涨停排队而不可买，止损是否因跌停而不可卖。
- 扣除佣金最低收费、印花税、过户费和滑点后是否仍为正收益。

所以当前 AUC 可以继续作为 36 维模型自身的监控指标，但不能作为机会雷达“可以买入”的充分证据。

### P0：雷达没有自己的全候选结果账本

板块层已有次日/五日相对收益、最大回撤、Top 20% 命中率和 NDCG 结算。[`shared/sectorForecast.js`](../../shared/sectorForecast.js#L685-L792)
量化层已有前向未见样本准确率。
真实交易层已有人工成交归因。

缺失的是中间一层：**每次雷达扫描中所有候选的不可变决策快照和成熟结果**。若只学习用户实际买入且完整记录的交易，会混入用户选择偏差、仓位差异和漏记成交；没有被用户买入的候选也无法判断是好机会还是坏机会。

### P1：固定规则分和手工权重不是可解释概率

- 四个公式命中后分别给固定分 `88/84/86/82`，并统一标记 `OBSERVE_ONLY`。[`shared/formulaSelection.js`](../../shared/formulaSelection.js#L178-L196)
- 最终公式排序是“公式固定分 + 当日主力净流入的截断值”。[`api/_formula_selection_data.js`](../../api/_formula_selection_data.js#L350-L406)
- 雷达同状态内按 blocker 数、公式分、板块名次、成交额排序。[`shared/opportunityRadar.js`](../../shared/opportunityRadar.js#L430-L451)

这些规则解释性强，适合召回和风险闸门；但 `88` 不能解释成 88% 胜率，不同公式的分数也没有共同概率尺度。研究应保留规则结构，只把最终排序升级为经过校准的条件概率和净期望。

### P1：市场与板块状态尚未进入个股结果模型

学术证据支持“个股信号受行业与市场状态影响”，但不能直接证明当前板块手工权重有效。行业动量研究说明行业因素能解释大量个股动量；动量崩溃研究则说明趋势策略在高波动、急跌后反弹等状态下可能表现显著不同。[Moskowitz & Grinblatt](https://doi.org/10.1111/0022-1082.00146)、[Daniel & Moskowitz](https://www.kentdaniel.net/papers/published/jfe_16.pdf)

当前系统主要把板块和市场状态用作规则门槛或加权项，尚未回答：

```text
P(净盈利 | 公式类型, 市场状态, 板块阶段, 时段, 流动性, 入场距离)
```

### P1：固定 5 bps 滑点不足以描述短线成交

当前 JS/Python 回测均默认 5 bps 滑点，并以开盘是否等于涨跌停判断不可成交。真实滑点会随波动、成交额、盘口深度、订单占比、时段和涨跌停队列变化。QuantConnect 和米筐都把滑点、成交量占比、撮合与费用做成独立现实模型，这说明它们是回测输入而不是常数；该平台能力本身不证明任何特定模型正确。[QuantConnect](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/slippage/key-concepts)、[米筐](https://www.ricequant.com/doc/rqalpha-plus/api/config)

### P1：尚未系统控制研究者自由度

公式阈值、权重、入场距离、持有天数和概率门槛一旦反复试验，就会产生多重检验偏差。金融研究中，仅报告最优回测会高估结果；PBO、Deflated Sharpe Ratio 或 White Reality Check 的共同原则是记录试验次数并提高证据门槛。[PBO 原文](https://escholarship.org/uc/item/4w1110bb)、[Harvey 等](https://www.nber.org/papers/w20592)

### P2：机会排序尚未考虑组合冗余

雷达目前逐股排序。若前五名都属于同一概念、同一高 beta 风格或高度相关的供应链，五只股票并不等于五个独立机会。应在保持个股结论不变的前提下，增加：

- 单股风险上限。
- 单板块/同概念暴露上限。
- 同时新增风险的总预算。
- 高相关候选去重。
- 已持仓与候选的边际风险贡献。

这提升的是组合生存能力，不是个股预测准确率。

## 六、目标系统：六段式决策链

### 6.1 候选发现层：追求召回，不直接下结论

保留现有全市场完整读取和四类公式，并将来源分成互补的 lane：

| Lane | 目标 | 当前来源 | 评价指标 |
| --- | --- | --- | --- |
| 回踩 | 找趋势内低风险回撤 | VWAP/MA/支撑、缩量 | 触发率、成交率、净期望 |
| 突破 | 找收敛后扩张 | BOLL/压力位/量能 | 假突破率、T+1 回撤 |
| 资金先行 | 找价格未充分反映的变化 | 大小单代理、量比 | 条件增益、数据稳定性 |
| 尾盘 | 找次日可执行机会 | TN6、14:50 分时 | 次日可卖前回撤、T+1/T+3 净收益 |
| 板块映射 | 提供方向与拥挤状态 | 板块前瞻 | Top-K 相对收益、扩散持续性 |

候选层必须保存所有进入公式检查的股票及其失败原因，不能只保存最终 5 只。显示仍可限制为 5-8 只。

### 6.2 市场/板块状态层：做条件变量，不做收益承诺

建议形成不可变的 `contextSnapshot`：

```json
{
  "market": {
    "breadth": 0,
    "limitUpDownBalance": 0,
    "turnoverPercentile": 0,
    "realizedVolatility": 0,
    "indexTrend": "..."
  },
  "sector": {
    "phase": "ACCUMULATION",
    "relativeStrength": 0,
    "flowPersistence": 0,
    "breadth": 0,
    "crowding": 0
  }
}
```

市场状态用于：

- 分桶展示条件胜率和净期望。
- 对概率做分层校准。
- 缩减仓位和新增风险预算。
- 标记分布外状态，必要时只观察。

它不应删除研究结果，也不应把弱个股升级为买入。

### 6.3 个股时机层：从“触价”升级为“触发且可成交”

每类公式要定义自己的订单语义：

- 回踩：限价触及后，需出现站回 VWAP/确认 bar；成交价不能默认等于观察价。
- 突破：使用突破触发价，下一可用 tick/bar 才允许成交，不能用同一根完整 K 线的收盘信息买在该根开盘。
- 尾盘：严格限定信号、下单和失效时间，15:00 后若评估盘后固定价格交易，应单列执行模式。
- 同一根 bar 同时触及止盈和止损：有分钟数据则按路径结算；没有则采用损失优先或标记不确定，不取最有利结果。TradingView 官方文档也明确说明，仅有 OHLC 时经纪商模拟器必须假定 bar 内路径。[TradingView 策略文档](https://www.tradingview.com/pine-script-docs/concepts/strategies/)

建议单独预测三个量：

```text
pFill       = 触发后在有效窗口内可成交的概率
pWinGivenFill = 成交后、T+1 约束下止盈先于止损的概率
expectedNetR  = 成交后扣除全部成本的期望 R 倍数
```

这样能区分“好股票但买不到”“容易成交但赔率差”和“可成交且期望为正”。

### 6.4 卖出计划层：标签与产品计划必须同构

每个买入候选都应在信号产生时冻结：

- 入场类型、触发价和有效期。
- 初始止损、目标和时间退出。
- T+1 最早可卖日期。
- 跌停无法卖出时的顺延规则。
- 分批止盈是否允许及对应仓位。

训练标签必须执行完全相同的计划。否则模型学习的是一种目标，产品执行的是另一种策略。

### 6.5 排序层：按净期望和风险，而非“看起来很强”

建议排序键为：

```text
状态优先级
-> 下置信界后的 expectedNetR
-> pFill
-> pWinGivenFill 的校准后概率
-> 尾部风险/MAE
-> 与现有持仓的相关性惩罚
-> 流动性
```

一个简化、可审计的效用值可以是：

```text
utility = pFill × (expectedNetR - λ × expectedShortfall10)
          - concentrationPenalty
```

UI 不必展示 `utility`，只展示：

- “同类历史 126 次，实际成交 91 次”。
- “校准后成功概率 61%，区间 53%-68%”。
- “扣费后平均 +0.24R，最差 10% 为 -1.18R”。
- “当前高波动状态下样本不足，降级观察”。

### 6.6 组合层：从 Top 5 股票变成 Top 5 独立机会

最终入选不应简单取逐股前五。建议用贪心约束选择：

1. 先取净期望下界最高者。
2. 同概念最多 2 只，单一行业风险不超过账户预设。
3. 与已持仓或已选股票 20/60 日相关性过高时降权。
4. 按止损距离计算风险金额，仓位向下取整到合法申报单位。
5. 总新增风险、现金占用和 T+1 锁定敞口必须同时满足。

不要直接使用无约束均值方差优化。短样本下预期收益和协方差估计误差很大，先用透明约束更稳健。

## 七、数据与标签设计

### 7.1 Point-in-time 数据集

每个扫描时点保存：

```json
{
  "decisionId": "...",
  "asOf": "2026-09-02T14:50:00+08:00",
  "universeVersion": "...",
  "securityMasterVersion": "...",
  "ruleVersion": "ashare-rules-2026-07-06",
  "formulaVersion": "...",
  "sectorVersion": "...",
  "quantModelVersion": "...",
  "code": "000001",
  "stageReached": "PREFILTER|TECHNICAL|EVIDENCE|DISPLAYED",
  "features": {},
  "decision": {},
  "rejectionReasons": []
}
```

历史证券主表至少包含上市、退市、停牌、名称/ST 区间、板块、涨跌幅制度和复权因子。Tushare 的 `stock_basic` 提供上市/退市状态与日期，`namechange` 可恢复历史名称区间，`suspend_d` 提供停复牌，`adj_factor` 提供复权因子；这些字段足以构建基础版本，但需要自行形成每日可见快照。[Tushare 股票基础信息](https://tushare.pro/document/2?doc_id=25)、[股票曾用名](https://tushare.pro/document/2?doc_id=100)、[停复牌](https://tushare.pro/document/2?doc_id=214)、[复权因子](https://tushare.pro/document/2?doc_id=28)

必须禁止：

- 用今天仍上市的股票池回测过去。
- 用今天的板块成分回填历史。
- 用最终复权因子直接生成过去的可成交价。
- 用收盘后才发布的资金、龙虎榜或财务数据参与盘中信号。
- 删除退市、长期停牌或无后续价格的失败样本。

### 7.2 可执行标签

对每个候选按公式自身的入场合同结算：

```text
entry:
  信号后第一个允许执行的 bar
  + 价格触发
  + 非涨停无卖盘/停牌
  + 成交量参与率限制
  + 不优于真实可见价格

exit:
  最早 T+1
  + 止损/止盈/时间退出先到先执行
  + 跌停无买盘则顺延
  + 分红送转按当时可知的公司行动处理

outcome:
  netReturn
  netR
  MFE
  MAE
  holdingDays
  fillStatus
  exitStatus
```

候选质量标签与执行质量标签应分开。未成交不能简单算亏损，也不能从样本中删除；它是 `pFill` 的监督样本。

### 7.3 成本模型

基础成本：

```text
买入成本 = 佣金(账户费率及最低收费) + 过户费 + 滑点/冲击
卖出成本 = 佣金(账户费率及最低收费) + 过户费 + 印花税 + 滑点/冲击
```

固定 5 bps 只能作为基线。至少报告三档压力测试：

| 档位 | 用途 |
| --- | --- |
| 乐观 | 高流动性、低参与率 |
| 基准 | 按成交额/波动/时段分桶估计 |
| 压力 | 低流动性、开盘/尾盘、高波动或接近涨跌停 |

实盘后使用人工成交记录估计 `决策价 -> 委托触发价 -> 实际成交价 -> VWAP` 的滑点分布，但不能用少数已成交样本反向证明选股有效。

## 八、走样本外验证与概率校准

### 8.1 切分

建议按交易日做扩展窗口 walk-forward：

```text
训练窗 -> 净化区 -> 校准窗 -> 净化区 -> 最终测试窗
```

- 同一交易日的所有股票必须在同一分区，避免横截面泄漏。
- 净化长度至少覆盖最长标签窗口；当前 1-5 日策略至少净化 5 个交易日。
- 最终测试窗只评估一次，任何阈值修改都进入下一轮实验。
- 公式、特征、阈值、滑点、股票池、时间窗的每次尝试都写入 trial registry。
- 置信区间按“交易日”做 block bootstrap，不能把同一天数千只股票当独立样本。

### 8.2 对照组

每次挑战者必须同时比较：

1. 随机抽取同流动性股票。
2. 只按成交额排序。
3. 现有公式固定分排序。
4. 现有 36 维量化分排序。
5. 板块前瞻 + 公式的现有机会雷达排序。
6. 新的校准后净期望排序。

### 8.3 指标

首要指标不是总体准确率：

| 层级 | 指标 |
| --- | --- |
| 候选发现 | 机会捕获率、候选覆盖率、每次扫描候选数 |
| 排序 | Precision@3/5、NDCG@5、Top-K 相对基线增益 |
| 概率 | Brier Score、Log Loss、可靠性图、分桶校准误差 |
| 交易 | 成交率、扣费后胜率、平均盈利/亏损、净期望、Profit Factor |
| 风险 | MAE、最差 10% 收益、最大回撤、连续亏损、跌停延迟退出 |
| 稳定性 | 按年份、市场状态、公式、板块阶段、时段、流动性分桶 |

Brier Score 的原始定义用于评估概率预测，Guo 等的研究说明分类模型的置信度可能失准且可在独立验证集上后校准。[Brier 原文](https://journals.ametsoc.org/view/journals/mwre/78/1/1520-0493_1950_078_0001_vofeit_2_0_co_2.xml?tab_body=pdf)、[Guo 等](https://proceedings.mlr.press/v70/guo17a.html)

### 8.4 建议上线闸门

不预设“必须 60% 胜率”，因为胜率必须和赔率、成本、覆盖率一起看。建议所有条件同时满足：

- 最终时间外测试的扣费后 `expectedNetR` 下置信界大于 0。
- 相对当前雷达的 Top-5 净期望和 Precision@5 有稳定增益。
- Brier Score 和 Log Loss 不劣于未校准基线，可靠性图无明显系统性高估。
- 至少跨越多个市场状态，任一主要状态没有灾难性负期望。
- 压力成本下仍不出现不可接受的回撤或连续亏损。
- 记录并校正全部试验次数；高搜索自由度时报告 PBO/DSR 或等价多重检验结果。
- 先影子运行，再只读展示，最后才允许影响排序；始终不自动下单。

## 九、推荐架构：不改 36 维主模型

保持现有职责：

```text
公式选股       -> 高召回、可解释候选
板块前瞻       -> 方向、阶段、拥挤和市场上下文
现有 /predict  -> 36 维日线量价先验
机会雷达       -> 确定性聚合与展示
LLM            -> 解释证据，不制造候选/概率/价格
```

新增独立旁路：

```text
radar event ledger
  -> executable outcome resolver
  -> opportunity-score trainer
  -> calibrated sidecar endpoint
  -> radar ranking policy
```

建议新模型只消费已保存的时点特征：

- 公式 ID、命中强度、距触发价/止损价的 ATR 距离。
- 市场宽度、涨跌停结构、成交额分位、实现波动率。
- 板块阶段、资金持续性、扩散、拥挤度和相对强弱。
- 个股相对板块强弱、成交额/换手/Amihud 流动性代理。
- 现有 36 维模型输出及版本，而不是复制或修改其输入口径。
- 时段、上市板块、最小交易单位、涨跌停制度和数据新鲜度。

首选 LightGBM/逻辑回归基线，而不是深度模型。Gu、Kelly、Xiu 的研究支持非线性与交互可能有价值，但也显示金融信号弱、正则化和样本外表现比模型复杂度更重要。[原文](https://academic.oup.com/rfs/article/33/5/2223/5758276)

输出合同建议：

```json
{
  "modelVersion": "opportunity-score.v1",
  "asOf": 0,
  "code": "000001",
  "formulaId": "INTRADAY_VWAP_PULLBACK",
  "pFill": 0.74,
  "pWinGivenFill": 0.61,
  "expectedNetR": 0.18,
  "netRLowerBound": 0.03,
  "expectedShortfall10": -1.12,
  "calibration": {
    "method": "isotonic",
    "sampleCount": 426,
    "bucket": "NEUTRAL:ACCUMULATION:INTRADAY"
  },
  "outOfDistribution": false
}
```

样本不足、校准过期或状态分布外时，概率字段返回 `null`，雷达继续按现有确定性逻辑工作。

## 十、三阶段实施路线

### 阶段一：把结果测对（P0，2-4 周）

目标：在不改变前台选股结论的情况下，建立可信的雷达级事实与结算口径。

交付：

- 建立版本化 A 股规则表，修正 2026-07-06 后主板 ST 涨跌幅，并明确科创板、创业板、北交所和盘后固定价格交易范围。
- 明确机会雷达真实选股范围；若继续排除科创板/北交所，在 UI 和报告中显式说明。
- 建立 point-in-time 证券主表和板块成分历史，保留退市、停牌、历史 ST 和复权事件。
- 为每次扫描保存全候选/全阶段决策账本，不只保存最终展示或实际成交。
- 实现符合触发、成交、T+1、涨跌停、费用和时间退出的成熟结果标签。
- 生成现有五类公式和当前雷达排序的基线报告，按状态/公式/时段分桶。

退出门槛：

- 任意候选可以从决策快照完整重放到结算结果。
- 抽样人工核对不少于 100 个事件，信号时点、成交、T+1、涨跌停和费用无口径错误。
- 不存在当前股票池回填历史、同 bar 偷看未来或删除失败标的。

### 阶段二：把候选排对（P1，4-8 周）

目标：不改 36 维 `/predict`，新增雷达旁路排序与概率校准。

交付：

- 训练 `pFill`、`pWinGivenFill` 和 `expectedNetR` 三个头，先用逻辑回归/LightGBM。
- 市场状态、板块阶段、公式类型和流动性作为交互条件。
- 使用训练/净化/校准/净化/测试的 walk-forward；保存全部试验记录。
- 输出 Brier、Log Loss、可靠性图、Precision@K、NDCG、净期望、尾部风险和压力成本结果。
- 影子运行至少覆盖多个市场状态；不改变当前用户排序。

退出门槛：

- 时间外 Top-5 扣费后净期望下置信界为正，并稳定优于当前排序。
- 概率校准优于原始模型分，且没有把固定公式分包装成概率。
- 至少两个独立时间窗口、主要公式和主要市场状态不出现结构性失效。
- 多重试验校正后结论仍成立。

### 阶段三：把机会用对（P2，8-12 周以上）

目标：将验证通过的概率用于只读排序和组合风险控制，并形成持续反馈。

交付：

- 先在雷达中显示“历史样本、校准概率、净期望区间、尾部风险”，仍保留确定性 blocker。
- 排序从逐股 Top 5 升级为组合约束后的 Top 5 独立机会。
- 账户费率、最小佣金和实际成交滑点进入个性化计划。
- 对所有候选做影子结算，对真实成交做执行归因；两类数据分开统计。
- 使用滚动窗口监控校准漂移、特征漂移、覆盖率、连续亏损和市场状态失效。
- 继续使用冠军-挑战者；任何新模型只在成熟样本和前向盲测上晋级。

退出门槛：

- 只读展示期的条件概率与实际频率一致，净期望没有显著衰减。
- 组合层最大回撤和同板块集中度优于逐股排序基线。
- 模型失效、数据缺失或分布外时能自动回退现有确定性雷达。
- 产品仍只提供研究、提醒和人工计划，不产生券商自动委托。

## 十一、优先级路线图

| 优先级 | 工作项 | 价值 | 依赖 |
| --- | --- | --- | --- |
| P0-1 | 更新并版本化 2026 沪深交易规则口径 | 防止涨跌停、成交和历史回测直接算错 | 无 |
| P0-2 | 建立雷达全候选事件账本 | 消除只看展示股/成交股的选择偏差 | OSS 结构设计 |
| P0-3 | 建立 T+1、涨跌停、费用和滑点一致的可执行标签 | 把评价目标从“曾上涨”改成“可成交净结果” | P0-1、P0-2 |
| P0-4 | 审计 point-in-time 股票池、ST、停牌、退市、板块成分和复权 | 防幸存者偏差与未来函数 | 历史主数据 |
| P1-1 | 产出现有公式/雷达的分桶基线 | 知道真正有效的是哪种公式、在哪种状态有效 | P0 |
| P1-2 | 训练独立机会排序旁路，不改 36 维 `/predict` | 降低改造风险，直接优化雷达目标 | P0 |
| P1-3 | 独立校准 `pFill`、`pWinGivenFill`、`expectedNetR` | 让概率可用于阈值和仓位，而非装饰 | P1-2 |
| P1-4 | Walk-forward、日期 block bootstrap、多重试验校正 | 防止把搜索运气当能力 | P1-2 |
| P2-1 | 组合去重、板块上限、风险预算和现金占用 | 控制同向回撤和 T+1 锁定风险 | P1 通过 |
| P2-2 | 影子上线、只读概率、漂移监控和冠军-挑战者 | 让升级可回滚、可持续验证 | P1 通过 |

## 十二、最终判断

机会雷达要变得“真正有用”，关键不是增加更多候选，而是减少错误确定性：

- 对候选发现，追求完整、可追溯和高召回。
- 对买入建议，只认可真实时点下可成交、扣费后、符合 T+1 的结果。
- 对模型，只展示经过独立样本校准的条件概率。
- 对排名，优化净期望下界和组合风险，不优化表面胜率。
- 对学习，结算全部候选并分离模型、策略、执行和用户选择的贡献。

这条路线不会让系统“保证选对股”，但能逐步回答更可靠的问题：**在当前市场和板块状态下，这类候选以当前价格计划成交后，历史上有多大概率取得正的扣费后结果，可能承受多大损失，以及它是否值得占用有限的风险预算。**
