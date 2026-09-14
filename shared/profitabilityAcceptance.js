// 盈利能力验收门槛（统一口径，纯函数，无 IO）。
//
// 为什么单独一层：账户回放 summary 只给单次运行的收益/回撤/胜率；而“是否达标”
// 需要跨滚动 12 个月盈利概率、年度收益中位数、双滑点档、费后净 R 下界的组合判定。
// 把门槛集中在这里，账户回放、年度验证、报告共用同一口径，避免各处口径漂移。
//
// 关键纪律：
//   - 样本不足（如本地仅约 260 交易日、年度窗口 < 1）时，明确返回 dataSufficient=false
//     与 provable=false，绝不用不足样本伪造“年度稳定/70% 概率”结论。
//   - 所有阈值集中为常量，便于审查与后续按数据调参。

export const PROFITABILITY_ACCEPTANCE_VERSION =
  'profitability-acceptance.v1'

// 一年按约 244 个 A 股交易日近似。
export const TRADING_DAYS_PER_YEAR = 244
// 滚动窗口按 12 个自然月近似为 252 个交易日之内的滑窗；这里用交易日窗口。
export const ROLLING_WINDOW_TRADING_DAYS = TRADING_DAYS_PER_YEAR

export const ACCEPTANCE_THRESHOLDS = Object.freeze({
  // 滚动 12 个月账户盈利概率下限。
  rollingProfitProbability: 0.7,
  // 年度收益中位数区间（百分比）。
  annualReturnMedianMinPct: 10,
  annualReturnMedianMaxPct: 20,
  // 最大回撤上限（百分比）。
  maxDrawdownPct: 10,
  // 费后净 R 的 95% 下界下限。
  netRLowerBound95: 0.02,
  // 压力滑点档（基点）——两档都必须为正收益。
  stressSlippageBps: 10,
})

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') {
    return null
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function median(values) {
  const nums = values.map(finite).filter((v) => v != null)
  if (!nums.length) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

// 分块自助法估计费后净 R 序列的 95% 下界（与量化侧同名门槛口径一致：
// 对日/交易净 R 序列按块重采样，取重采样均值分布的 5% 分位）。
export function netRLowerBound95(
  perTradeNetR,
  { samples = 2000, blockSize = 5, seed = 42 } = {},
) {
  const series = (Array.isArray(perTradeNetR) ? perTradeNetR : [])
    .map(finite)
    .filter((v) => v != null)
  if (series.length < 2) return null
  // 确定性 LCG，保证可复现。
  let state = seed >>> 0
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
  const block = Math.max(1, Math.min(blockSize, series.length))
  const blockCount = Math.ceil(series.length / block)
  const means = []
  for (let s = 0; s < samples; s += 1) {
    let sum = 0
    let count = 0
    for (let b = 0; b < blockCount; b += 1) {
      const start = Math.floor(rand() * series.length)
      for (let i = 0; i < block; i += 1) {
        sum += series[(start + i) % series.length]
        count += 1
      }
    }
    means.push(sum / count)
  }
  means.sort((a, b) => a - b)
  return means[Math.floor(0.05 * (means.length - 1))]
}

// 从权益曲线按交易日窗口滚动，统计每个满窗窗口的窗口收益是否为正。
// 返回滚动盈利概率与窗口数；窗口不足一年时 windows=0。
export function rollingProfitProbability(
  equitySeries,
  { windowDays = ROLLING_WINDOW_TRADING_DAYS } = {},
) {
  const series = (Array.isArray(equitySeries) ? equitySeries : [])
    .map(finite)
    .filter((v) => v != null && v > 0)
  if (series.length <= windowDays) {
    return { windows: 0, positiveWindows: 0, probability: null }
  }
  let positive = 0
  let total = 0
  for (let i = windowDays; i < series.length; i += 1) {
    total += 1
    if (series[i] > series[i - windowDays]) positive += 1
  }
  return {
    windows: total,
    positiveWindows: positive,
    probability: total ? positive / total : null,
  }
}

// 年度收益：按交易日切成不重叠的年度块，返回每块收益百分比与中位数。
export function annualReturnsPct(
  equitySeries,
  { yearDays = TRADING_DAYS_PER_YEAR } = {},
) {
  const series = (Array.isArray(equitySeries) ? equitySeries : [])
    .map(finite)
    .filter((v) => v != null && v > 0)
  const blocks = []
  for (let start = 0; start + yearDays < series.length; start += yearDays) {
    const begin = series[start]
    const end = series[start + yearDays]
    if (begin > 0) blocks.push((end / begin - 1) * 100)
  }
  return { yearlyReturnsPct: blocks, medianPct: median(blocks) }
}

// 综合验收：输入基准档(5bps)与压力档(10bps)运行结果。
// 每个 run 需含 { equitySeries, returnPct, maximumDrawdownPct, perTradeNetR }。
// 数据不足以覆盖满一年窗口时，provable=false，不给年度/概率达标结论。
export function evaluateAcceptance(
  { baseRun, stressRun } = {},
  thresholds = ACCEPTANCE_THRESHOLDS,
) {
  const base = baseRun || {}
  const stress = stressRun || {}
  const equity = Array.isArray(base.equitySeries) ? base.equitySeries : []

  const rolling = rollingProfitProbability(equity)
  const annual = annualReturnsPct(equity)
  const lowerBound = netRLowerBound95(base.perTradeNetR)

  const dataSufficient = rolling.windows > 0 && annual.yearlyReturnsPct.length > 0
  const baseReturn = finite(base.returnPct)
  const stressReturn = finite(stress.returnPct)
  const drawdown = finite(base.maximumDrawdownPct)

  // 与数据充分性无关、当前样本即可判定的“硬安全项”。
  const safety = {
    stressPositive: stressReturn != null && stressReturn > 0,
    drawdownWithinLimit:
      drawdown != null && drawdown <= thresholds.maxDrawdownPct,
    netRLowerBoundPass:
      lowerBound != null && lowerBound >= thresholds.netRLowerBound95,
  }
  // 需要满一年窗口才能可信判定的“年度项”。
  const annualChecks = dataSufficient
    ? {
        rollingProbabilityPass:
          rolling.probability != null
          && rolling.probability >= thresholds.rollingProfitProbability,
        annualMedianInRange:
          annual.medianPct != null
          && annual.medianPct >= thresholds.annualReturnMedianMinPct
          && annual.medianPct <= thresholds.annualReturnMedianMaxPct,
      }
    : { rollingProbabilityPass: null, annualMedianInRange: null }

  const provable = dataSufficient
  const passed = provable
    && Object.values(safety).every(Boolean)
    && Object.values(annualChecks).every(Boolean)

  return {
    schemaVersion: PROFITABILITY_ACCEPTANCE_VERSION,
    thresholds,
    dataSufficient,
    provable,
    passed: provable ? passed : null,
    metrics: {
      baseReturnPct: baseReturn,
      stressReturnPct: stressReturn,
      maxDrawdownPct: drawdown,
      netRLowerBound95: lowerBound == null ? null : Number(lowerBound.toFixed(6)),
      rollingWindows: rolling.windows,
      rollingProfitProbability:
        rolling.probability == null
          ? null
          : Number(rolling.probability.toFixed(6)),
      annualReturnMedianPct:
        annual.medianPct == null ? null : Number(annual.medianPct.toFixed(4)),
      yearlyReturnsPct: annual.yearlyReturnsPct.map(
        (v) => Number(v.toFixed(4)),
      ),
    },
    safety,
    annualChecks,
    // 供报告展示：数据不足时明确说明，不伪造年度结论。
    note: provable
      ? undefined
      : '样本不足以覆盖满一年滚动窗口，年度收益与滚动盈利概率不可证明；'
        + '仅硬安全项(压力档正收益/回撤/净R下界)基于现有样本给出。',
  }
}
