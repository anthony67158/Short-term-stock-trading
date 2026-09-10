import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMarketFundsSnapshot } from '../shared/marketFunds.js'

test('沪深北主市场汇总输出净额、强度和最大资金方向', () => {
  const result = buildMarketFundsSnapshot({
    market: {
      indices: [
        {
          code: '000001',
          name: '上证指数',
          mainInflow: 1_000_000_000,
          amount: 10_000_000_000,
          pct: 1,
        },
        {
          code: '399001',
          name: '深证成指',
          mainInflow: -400_000_000,
          amount: 8_000_000_000,
          pct: -0.5,
        },
        {
          code: '899050',
          name: '北证50',
          mainInflow: 200_000_000,
          amount: 2_000_000_000,
          pct: 0.2,
        },
        {
          code: '399006',
          name: '创业板指',
          mainInflow: -9_000_000_000,
          amount: 4_000_000_000,
          pct: -2,
        },
      ],
      breadth: {
        amountYi: 10_000,
        volVsAvg5: 11.1,
        volumeComparable: true,
      },
    },
    updatedAt: 123,
  })

  assert.equal(result.schemaVersion, 'market-funds.v1')
  assert.equal(result.source, 'eastmoney-primary-index-aggregate')
  assert.equal(result.status, 'READY')
  assert.equal(result.mainNetYi, 8)
  assert.equal(result.inflowTotalYi, 12)
  assert.equal(result.outflowTotalYi, 4)
  assert.equal(result.direction, 'INFLOW')
  assert.equal(result.netStrengthPct, 4)
  assert.equal(result.inflowMarketCount, 2)
  assert.equal(result.outflowMarketCount, 1)
  assert.equal(result.flatMarketCount, 0)
  assert.equal(result.marketCount, 3)
  assert.equal(result.averageIndexPct, 0.23)
  assert.equal(result.resonance, 'POSITIVE')
  assert.deepEqual(result.dominantMarket, {
    code: '000001',
    name: '上证指数',
    label: '沪市',
    mainNetYi: 10,
    direction: 'INFLOW',
  })
  assert.equal(result.turnover.amountYi, 10_000)
  assert.equal(result.turnover.average5Yi, 9_000.9)
  assert.equal(result.turnover.deltaYi, 999.1)
  assert.equal(result.turnover.deltaPct, 11.1)
  assert.equal(result.turnover.direction, 'EXPANDING')
  assert.equal(result.asOf, 123)
})

test('盘中成交额不可比时不伪造增量资金', () => {
  const result = buildMarketFundsSnapshot({
    market: {
      indices: [
        {
          code: '000001',
          mainInflow: -600_000_000,
          amount: 6_000_000_000,
          pct: -0.8,
        },
        {
          code: '399001',
          mainInflow: 100_000_000,
          amount: 4_000_000_000,
          pct: 0.2,
        },
      ],
      breadth: {
        amountYi: 4_800,
        volVsAvg5: -40,
        volumeComparable: false,
      },
    },
  })

  assert.equal(result.direction, 'OUTFLOW')
  assert.equal(result.mainNetYi, -5)
  assert.equal(result.turnover.amountYi, 4_800)
  assert.equal(result.turnover.average5Yi, null)
  assert.equal(result.turnover.deltaYi, null)
  assert.equal(result.turnover.deltaPct, null)
  assert.equal(result.turnover.direction, 'UNAVAILABLE')
})

test('成交额增减优先使用服务端原始金额计算结果', () => {
  const result = buildMarketFundsSnapshot({
    market: {
      indices: [{
        code: '000001',
        mainInflow: 100_000_000,
        amount: 1_000_000_000,
        pct: 0.3,
      }],
      breadth: {
        amountYi: 10_000,
        avg5AmountYi: 9_012.3,
        amountDeltaVsAvg5Yi: 987.7,
        volVsAvg5: 11.1,
        volumeComparable: true,
      },
    },
  })

  assert.equal(result.turnover.average5Yi, 9_012.3)
  assert.equal(result.turnover.deltaYi, 987.7)
  assert.equal(result.turnover.deltaPct, 11.1)
})

test('资金源缺失时返回明确缺失态而不是零净流入', () => {
  const result = buildMarketFundsSnapshot({
    market: null,
  })

  assert.equal(result.status, 'MISSING')
  assert.equal(result.mainNetYi, null)
  assert.equal(result.direction, 'UNKNOWN')
  assert.equal(result.inflowMarketCount, null)
  assert.equal(result.turnover.amountYi, null)
})
