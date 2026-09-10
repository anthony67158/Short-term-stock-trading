import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMarketFundsSnapshot } from '../shared/marketFunds.js'

test('行业资金汇总输出净额、扩散度、强度和集中度', () => {
  const result = buildMarketFundsSnapshot({
    sectors: {
      list: [
        { code: 'BK01', name: '电子', mainInflow: 1_000_000_000 },
        { code: 'BK02', name: '银行', mainInflow: -400_000_000 },
        { code: 'BK03', name: '医药', mainInflow: 200_000_000 },
        { code: 'BK04', name: '煤炭', mainInflow: 0 },
        { code: 'BK01', name: '电子', mainInflow: 9_000_000_000 },
      ],
    },
    market: {
      breadth: {
        amountYi: 10_000,
        volVsAvg5: 11.1,
        volumeComparable: true,
      },
    },
    updatedAt: 123,
  })

  assert.equal(result.schemaVersion, 'market-funds.v1')
  assert.equal(result.source, 'eastmoney-industry-aggregate')
  assert.equal(result.status, 'READY')
  assert.equal(result.mainNetYi, 8)
  assert.equal(result.inflowTotalYi, 12)
  assert.equal(result.outflowTotalYi, 4)
  assert.equal(result.direction, 'INFLOW')
  assert.equal(result.netStrengthPct, 50)
  assert.equal(result.inflowSectorCount, 2)
  assert.equal(result.outflowSectorCount, 1)
  assert.equal(result.flatSectorCount, 1)
  assert.equal(result.sectorCount, 4)
  assert.equal(result.inflowBreadthPct, 50)
  assert.equal(result.top3InflowSharePct, 100)
  assert.equal(result.turnover.amountYi, 10_000)
  assert.equal(result.turnover.average5Yi, 9_000.9)
  assert.equal(result.turnover.deltaYi, 999.1)
  assert.equal(result.turnover.deltaPct, 11.1)
  assert.equal(result.turnover.direction, 'EXPANDING')
  assert.equal(result.asOf, 123)
})

test('盘中成交额不可比时不伪造增量资金', () => {
  const result = buildMarketFundsSnapshot({
    sectors: {
      list: [
        { code: 'BK01', mainInflow: -600_000_000 },
        { code: 'BK02', mainInflow: 100_000_000 },
      ],
    },
    market: {
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
    sectors: [{ code: 'BK01', mainInflow: 100_000_000 }],
    market: {
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
    sectors: null,
    market: null,
  })

  assert.equal(result.status, 'MISSING')
  assert.equal(result.mainNetYi, null)
  assert.equal(result.direction, 'UNKNOWN')
  assert.equal(result.inflowSectorCount, null)
  assert.equal(result.turnover.amountYi, null)
})
