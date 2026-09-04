# A 股预催化与资金启动预测路径研究

> 研究日期：2026-09-04
> 目标：在明显涨停、龙虎榜或市场广泛关注之前，识别未来 1–5 个交易日更可能出现资金扩张和价格启动的股票。
> 边界：只使用决策时点已经公开的信息；输出概率与观察条件，不声称识别真实账户身份，不自动交易。

## 结论

这条路径存在，但正确目标不是“猜主力下一只拉什么”，而是：

```text
公开事件或关联公司出现变化
→ 变化尚未被目标股票价格充分反映
→ 目标股票出现低拥挤的资金试探
→ 预测未来 1/3/5 日启动概率
→ 到价和量价确认后再进入可执行候选
```

最有证据支持的三个提前量来源是：

1. **机构关注异常**：机构调研频次、参与机构质量和调研内容的新信息密度。
2. **经济关系扩散**：客户、供应商、替代品、互补品和同产业链公司的事件或收益向目标公司传导。
3. **微观资金结构**：订单失衡、成交结构和资金持续性先于短周期价格变化，但方向会随预测窗口反转。

网络新闻只能承担“事件发现和关系补全”，不能直接等价为利好，也不能单独把股票升级为可买。正式公告、投资者关系记录、政策原文和可核验产业数据应作为事实层；LLM 只负责结构化抽取和关系分类；最终排序必须由时间外数据训练并经真实成交结算。

## 为什么当前系统发现得偏晚

### 1. 事件标签本身是事后确认

`qlib-service/build_event_tags.py` 当前规则为：

```text
连板 >= 2
或 涨停且封单强
或 龙虎榜净买入
```

这些条件精度可能较高，但股票已经被市场看见，适合“确认强势”，不适合“提前发现”。

### 2. 盘中公式要求价格或资金已经启动

`shared/formulaSelection.js` 的“盘中资金先行”仍要求当日涨幅、成交额、换手、主力资金等条件已经成立。它比追涨更早，但仍属于启动后的确认。

### 3. 板块前瞻先按当下资金排名，再检索新闻

`api/_sector_forecast_data.js` 先根据板块涨幅、资金、扩散和成分股表现选出板块；`api/_sector_forecast_llm.js` 只对前列板块搜索和解释，而且 LLM 不得改变排序。因此搜索只能解释已经入选的方向，不能从全市场新事件反向发现尚未启动的股票。

### 4. 个股联网检索需要先知道股票

`api/_ai_search.js` 的个股检索输入是股票代码、名称和行业。它适合补充既有候选的证据，不具备“从事件发现未知候选”的能力。

## 证据综述

### 机构调研：可做中周期潜伏信号

2025 年发表于 JFQA 的中国深交所样本研究发现，异常频繁的公司实地调研与后续收益存在预测关系；高调研组相对低调研组约有每月 70–100 个基点差异，效果集中于低关注、低成交量公司，并伴随来访机构之后增持。[S1]

另一项中国研究发现，调研记录中具体内容比一般性内容具有更强的样本外市场收益预测力。[S2]

可落地的不是“有机构调研就买”，而是构建异常度：

```text
visitAbnormal = 最近20日调研次数 / 过去一年同期基线
newInstitutionRatio = 首次出现机构数 / 本次机构数
contentNovelty = 本次问答相对过去四次记录的新信息比例
specificAnswerRatio = 含订单、产能、交付、价格、客户进度等可核验回答占比
attentionGap = 调研异常度 - 新闻热度/成交额/涨幅拥挤度
```

限制：论文主要支持月度或较长窗口，不能直接证明 1–5 日有效；披露通常发生在调研之后，必须使用实际披露时间而非活动时间回填历史。

### 供应链和经济关系：最接近“提前压中”的结构

客户—供应商研究发现，投资者注意力有限会导致关联公司的信息不能立即进入目标公司价格，从而产生跨股票收益可预测性。[S3] 中国上市公司样本也发现供应链事件存在价格溢出，且关系更紧密、市场关注变化更明显时传导更强。[S4]

这意味着事件扫描不应只匹配公告主体，还应扩展到：

- 上游材料、设备、核心零部件；
- 下游客户、渠道和应用方；
- 同一产品链中的替代与互补公司；
- 行业外但共享客户、劳动力或技术路线的关联公司。

关系必须有来源和有效期。仅因两家公司新闻文本相似不能认定有经济联系；2026 年的 LLM 语义网络研究也明确指出，文本相似会产生大量伪关系，必须再做经济关系分类和过滤。[S5]

### 订单失衡：存在短期信息，但方向高度依赖窗口

中国市场研究发现：

- 日频滞后订单失衡对未来收益呈显著负向预测，更接近库存压力或短期反转。[S6]
- 高频订单失衡在未来 5–30 分钟呈正向预测，但 60–120 分钟转为负向，且流动性会改变该关系。[S7]
- 开盘前半小时订单失衡比全天订单失衡有更好的样本内外预测能力，贡献主要来自大额成交。[S8]

因此不能把“主力净流入”写成固定看多信号。应按窗口拆开：

```text
flowImpulse5m
flowPersistence30m
flowReversal60m
largeTradeShare
priceImpactPerAmount
closeLocationAfterFlow
```

项目目前只有公开 Level-1 成交规模代理。东方财富“大单/小单”是按成交规模分类的行为代理，不是机构账户身份。界面和模型都应称为“资金结构”或“疑似大额资金”，不能声称识别了主力。

### 可转债价格发现：适用于有转债的股票

中国市场研究发现，可转债订单失衡对对应股票的日频和 30 分钟收益具有预测信息，并且股票自身订单失衡的预测力更弱。[S9] 对有活跃转债的公司，可以新增跨市场领先特征：

```text
cbReturnResidual
cbOrderImbalance
conversionPremiumChange
cbStockLeadLag
```

它只适用于可转债覆盖股票，且需要可靠的逐笔或至少高频成交数据，不能用日线涨跌代替订单失衡。

### 新闻和关注度：适合作为“拥挤度”，不是单独方向信号

近期中国市场研究支持投资者关注度与动量表现存在交互，但关注也可能代表价格压力和后续反转。[S10] 因此新闻数量、搜索热度和讨论量应同时承担两个相反角色：

- 新信息首次出现、关注仍低：可能存在扩散空间；
- 转发和讨论暴增、涨幅与换手同步升高：更可能已拥挤。

真正有用的是“事件质量减去市场定价程度”，不是情绪分本身：

```text
latentCatalyst = eventMateriality
  × relationExposure
  × sourceReliability
  × informationNovelty
  × underReaction
  × earlyFlowConfirmation
  - crowding
  - executionRisk
```

## 推荐架构：事件优先，而不是股票优先

### 1. 事件采集层

按时间增量采集，不对 5000 多只股票逐只搜索：

- 巨潮资讯、上交所、深交所正式公告；
- 上证 e 互动、互动易和投资者关系活动记录；
- 发改委、工信部等正式政策原文；
- 招投标、中标、产销、价格、排产和行业高频数据；
- 已确认来源的公司官网信息。

豆包搜索保留为发现线索和补全来源，不作为权威事实源。每条记录必须保存：

```text
eventId
firstSeenAt
publishedAt
sourceUrl
sourceAuthority
eventType
entities
numbers
effectiveDate
uncertainty
correctionOf
```

### 2. 事件结构化层

LLM 只做受约束的信息抽取：

- 事件类别：订单、产能、涨价、回购、调研、政策、产品验证、客户进展、风险；
- 方向保持 `positive / negative / uncertain`，不允许强行判利好；
- 抽取金额、产能、交付期、客户和产品；
- 每个字段必须引用原文证据片段；
- 缺失时返回空，不允许补写。

### 3. 经济关系图

为每条事件生成直接和间接受影响股票：

```text
事件主体
├── 直接公司
├── 已披露客户/供应商
├── 同产品替代者
├── 下游应用
└── 同板块对照组
```

边需要 `relationType`、`evidenceUrl`、`validFrom`、`validTo`、`confidence`。LLM 可以分类候选边，但不能凭语义相似直接创建高置信关系。

### 4. “尚未定价”检测

只保留事件强、但目标股票尚未明显启动的候选：

- 事件后个股相对板块收益仍低；
- 成交额和搜索关注未进入高分位；
- 不接近涨停、不处于连续加速；
- 资金结构开始改善，但价格冲击较小；
- 供应链领先公司或可转债已经出现变化；
- 当前存在可达的回踩/突破观察价。

这一步是系统从“热点跟随”升级为“潜伏发现”的核心。

### 5. 两段式输出

新增候选不直接进入“可立即买入”，而进入现有“今日提前布局”：

```text
潜伏预判
→ 等待资金/量价确认
→ 形成合法价格合同
→ 到价观察
→ review/Judge
→ 可执行或放弃
```

页面需要明确展示：

- 为什么提前发现；
- 信息首次出现时间；
- 尚未被价格反映的证据；
- 等待什么确认；
- 什么变化说明判断错误。

## 模型与标签

建议新增独立的 `pre-catalyst.v1` 影子模型，不修改现有 36 维 OHLCV `/predict`。

### 预测头

```text
pActivation1d = 1日内出现价格与成交扩张的概率
pActivation3d = 3日内出现价格与成交扩张的概率
pOutperform5d = 5日内跑赢板块的概率
expectedNetR = 按真实成交和费用计算的条件期望
adverseExcursion = 启动前最大不利波动
```

“启动”必须同时包含相对收益和成交扩张，避免把无量随机上涨标成成功。阈值应由训练数据选择，并保存版本，不能在报告中预设为永远有效。

### 特征组

| 特征组 | 示例 |
| --- | --- |
| 事件 | 类型、权威度、新颖度、金额/市值比、距首次披露时间 |
| 调研 | 20日异常频次、新机构比例、问题具体度、回答新增事实 |
| 关系 | 客户/供应商暴露、关系强度、领先节点收益、传导距离 |
| 未定价 | 个股相对板块残差、新闻热度分位、换手/成交额分位 |
| 资金 | 5/15/30分钟资金持续性、价格冲击、大额成交占比代理 |
| 拥挤 | 涨幅、量比、讨论量、涨停距离、板块扩散过热 |
| 执行 | ATR、流动性、涨跌停、T+1、可达价格合同 |

## P0 / P1 / P2

### P0：建立预催化账本，不改变线上排序

1. 新建 `pre-catalyst` 事件账本和来源白名单。
2. 接入正式公告、投资者关系记录和政策原文。
3. 建立事件去重、首次发现时间和更正链。
4. 用规则抽取直接主体，保存全量候选和未入选对照组。
5. 每日结算未来 1/3/5 日相对收益、成交扩张、MFE、MAE。

验收：至少积累 60 个交易日；时间戳泄漏为 0；每条事件可回到原文。

### P1：关系扩散与低拥挤排序

1. 建立版本化供应链/产品/客户关系图。
2. 增加机构调研异常度、可转债领先和未定价特征。
3. 训练 `pActivation1d/3d`，只做影子排序。
4. 与现有公式、随机同流动性、成交额排序做同期对照。

发布门槛：

- `Precision@5` 和 `NetR@5` 同时优于现有提前布局基线；
- 交易日 block bootstrap 下界为正；
- 结果不能主要由已涨停、已大涨或高关注股票贡献；
- 去除任一数据源后仍不过度崩塌。

### P2：进入“今日提前布局”

1. 只把已校准且仍未拥挤的候选放入提前布局。
2. 事件概率不能直接生成买入动作。
3. 继续执行价格合同、到价观察和 review/Judge 两段确认。
4. 组合层按产业链和相关性去重，避免同时押注同一事件。
5. 监控事件类型、来源、行业和市场状态的概率漂移。

## 明确不做

- 不按新闻正负情绪直接买入。
- 不把“大单/小单”字段称为真实机构或散户账户。
- 不逐股调用搜索或 LLM 扫全市场。
- 不用今天的供应链关系、公告更正或板块成分回填历史。
- 不把机构调研、龙虎榜或涨停当作单一充分条件。
- 不先挑出成功案例再补事件解释。
- 不在样本不足时展示“高胜率潜伏股”。

## 数据与成本判断

事件优先架构比逐股搜索更适合当前 FC：

1. 定时读取新增公告索引；
2. 只解析新增或发生更正的文档；
3. 对少量事件做一次结构化抽取；
4. 通过本地关系图扩散到候选；
5. 只对最终几十只补行情和资金。

这样模型与搜索调用量由“股票数”变为“新事件数”，也能继续复用 OSS 增量对象和现有机会雷达账本。

## 最终判断

可以建设，而且比继续增加追涨公式更有价值。最值得先做的不是更复杂的新闻情绪模型，而是：

1. 官方事件全量增量账本；
2. 机构调研异常度；
3. 供应链/客户关系扩散；
4. 事件强度与价格关注度之间的差值；
5. 未来 1/3/5 日启动概率的影子评估。

只有这五项建立后，“提前压中”才是可验证的概率能力，而不是事后讲故事。

## 研究方法与来源质量

本次执行两轮检索：

- 第一轮：`China A-share order imbalance informed trading predict stock returns`、`customer supplier economic links predictable returns`、交易所信息披露规则。
- 第二轮：机构调研、投资者关注、可转债价格发现、供应链传导和当前可获取数据源的交叉核验。

| 来源 | 类型 | 可信度 | 新鲜度 | 相关性 | 综合 |
| --- | --- | ---: | ---: | ---: | ---: |
| S1 | 同行评议，中国调研与收益 | 10 | 9 | 10 | 9.8 |
| S2 | 同行评议，中国调研文本 | 9 | 5 | 9 | 8.2 |
| S3 | 顶级期刊，经济关系扩散 | 10 | 3 | 9 | 8.3 |
| S4 | 同行评议，中国供应链 | 9 | 7 | 9 | 8.6 |
| S5 | 2026 年预印本，LLM 关系图 | 6 | 10 | 8 | 7.4 |
| S6–S8 | 同行评议，中国订单失衡 | 9 | 5–10 | 10 | 8.5–9.5 |
| S9 | 同行评议，中国跨市场价格发现 | 9 | 7 | 8 | 8.3 |
| S10 | 同行评议，中国关注度与动量 | 9 | 9 | 8 | 8.7 |
| S11–S12 | 交易所/法定披露平台 | 10 | 10 | 9 | 9.7 |

完整性约 92%。主要缺口是公开免费数据通常没有真实机构账户级订单方向，也缺少完整、历史时点化的供应链关系；这两项必须使用代理变量并通过影子评估验证。

## 来源

[S1] Zhang, So, Wang, “Investor Corporate Visits and Predictable Returns,” *Journal of Financial and Quantitative Analysis*, 2025.
https://doi.org/10.1017/S0022109024000528

[S2] Dong, Yue, Cao, “Site visit information content and return predictability: Evidence from China,” *North American Journal of Economics and Finance*, 2020.
https://doi.org/10.1016/j.najef.2019.101104

[S3] Cohen, Frazzini, “Economic Links and Predictable Returns,” *Journal of Finance*, 2008.
https://doi.org/10.1111/j.1540-6261.2008.01379.x

[S4] Wang, Bian, Wu, “Spillover effects within supply chains: Evidence from Chinese-listed firms,” *Journal of International Financial Management & Accounting*, 2023.
https://doi.org/10.1111/jifm.12186

[S5] Huang et al., “Cross-Stock Predictability via LLM-Augmented Semantic Networks,” arXiv, 2026. Exploratory evidence, not production proof.
https://arxiv.org/abs/2604.19476

[S6] Zhang, Jiang, Zhou, “Order imbalance and stock returns: New evidence from the Chinese stock market,” *Accounting & Finance*, 2021.
https://doi.org/10.1111/acfi.12684

[S7] Zhang, Xie, Wang, “Do order imbalances predict intraday returns? New evidence from the Chinese stock market,” *Asia-Pacific Journal of Accounting & Economics*, 2025.
https://doi.org/10.1080/16081625.2025.2604824

[S8] Chu, Qiu, “Forecasting stock returns using first half an hour order imbalance,” *International Journal of Finance & Economics*, 2020.
https://doi.org/10.1002/ijfe.1960

[S9] Chen, Xu, Wang, “Can convertible bond trading predict stock returns? Evidence from China,” *Pacific-Basin Finance Journal*, 2023.
https://doi.org/10.1016/j.pacfin.2023.102026

[S10] Zhang et al., “From noise to signals: Investor attention as a catalyst for the momentum effect in the Chinese stock market,” *Global Finance Journal*, 2025.
https://doi.org/10.1016/j.gfj.2025.101175

[S11] 上海证券交易所，《上市公司自律监管指引第1号——规范运作（2026年4月修订）》，2026。上证 e 互动发布必须真实、准确、完整、公平，并提示重大不确定性。
https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/mainipo/c/c_20260424_10816605.shtml

[S12] 巨潮资讯网，上市公司公告与投资者关系活动记录公开查询入口。
https://www.cninfo.com.cn/new/index.jsp
