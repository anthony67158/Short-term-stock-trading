import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCEPTANCE_THRESHOLDS,
  annualReturnsPct,
  evaluateAcceptance,
  netRLowerBound95,
  rollingProfitProbability,
} from '../shared/profitabilityAcceptance.js'

// 生成一条按固定日收益增长的权益曲线。
function equityCurve(days, dailyPct, start = 100000) {
  const out = [start]
  for (let i = 0; i < days; i += 1) {
    out.push(out[out.length - 1] * (1 + dailyPct / 100))
  }
  return out
}

test('样本不足一年时明确不可证明，不给年度/概率结论', () => {
  const result = evaluateAcceptance({
    baseRun: {
      equitySeries: equityCurve(200, 0.02),
      returnPct: 4,
      maximumDrawdownPct: 2,
      perTradeNetR: [0.1, 0.2, -0.1, 0.15, 0.05],
    },
    stressRun: { returnPct: 3 },
  })
  assert.equal(result.dataSufficient, false)
  assert.equal(result.provable, false)
  assert.equal(result.passed, null)
  assert.equal(result.annualChecks.rollingProbabilityPass, null)
  assert.match(result.note, /不可证明/)
})

test('滚动盈利概率按满一年窗口统计正收益比例', () => {
  const rising = rollingProfitProbability(equityCurve(400, 0.05))
  assert.ok(rising.windows > 0)
  assert.equal(rising.probability, 1)
  const falling = rollingProfitProbability(equityCurve(400, -0.05))
  assert.equal(falling.probability, 0)
})

test('年度收益切成不重叠年块并取中位数', () => {
  const { yearlyReturnsPct, medianPct } = annualReturnsPct(
    equityCurve(500, 0.05),
  )
  assert.ok(yearlyReturnsPct.length >= 2)
  assert.ok(medianPct > 0)
})

test('净R下界为确定性且对稳定正序列为正', () => {
  const series = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.3 : 0.1))
  const a = netRLowerBound95(series)
  const b = netRLowerBound95(series)
  assert.equal(a, b)
  assert.ok(a > 0)
  assert.equal(netRLowerBound95([0.1]), null)
})

test('硬安全项：压力档为负或回撤超限直接不通过', () => {
  const twoYears = equityCurve(600, 0.06)
  const negStress = evaluateAcceptance({
    baseRun: {
      equitySeries: twoYears,
      returnPct: 15,
      maximumDrawdownPct: 6,
      perTradeNetR: Array.from({ length: 40 }, () => 0.12),
    },
    stressRun: { returnPct: -0.5 },
  })
  assert.equal(negStress.dataSufficient, true)
  assert.equal(negStress.safety.stressPositive, false)
  assert.equal(negStress.passed, false)

  const bigDrawdown = evaluateAcceptance({
    baseRun: {
      equitySeries: twoYears,
      returnPct: 15,
      maximumDrawdownPct: 12,
      perTradeNetR: Array.from({ length: 40 }, () => 0.12),
    },
    stressRun: { returnPct: 8 },
  })
  assert.equal(bigDrawdown.safety.drawdownWithinLimit, false)
  assert.equal(bigDrawdown.passed, false)
})

test('阈值常量固定为方案口径', () => {
  assert.equal(ACCEPTANCE_THRESHOLDS.rollingProfitProbability, 0.7)
  assert.equal(ACCEPTANCE_THRESHOLDS.annualReturnMedianMinPct, 10)
  assert.equal(ACCEPTANCE_THRESHOLDS.annualReturnMedianMaxPct, 20)
  assert.equal(ACCEPTANCE_THRESHOLDS.maxDrawdownPct, 10)
  assert.equal(ACCEPTANCE_THRESHOLDS.netRLowerBound95, 0.02)
  assert.equal(ACCEPTANCE_THRESHOLDS.stressSlippageBps, 10)
})
