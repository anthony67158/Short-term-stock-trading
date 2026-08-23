import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeNorthboundData,
} from '../api/_northbound.js'

test('北向数据只使用成交额且不把已停止披露的净买额转成零', () => {
  const result = normalizeNorthboundData({
    history: [
      {
        MUTUAL_TYPE: '005',
        TRADE_DATE: '2026-08-21 00:00:00',
        DEAL_AMT: 268087.54,
        DEAL_NUM: 13529157,
        NET_DEAL_AMT: null,
      },
      {
        MUTUAL_TYPE: '001',
        TRADE_DATE: '2026-08-21 00:00:00',
        DEAL_AMT: 125846.52,
        DEAL_NUM: 6347299,
      },
      {
        MUTUAL_TYPE: '003',
        TRADE_DATE: '2026-08-21 00:00:00',
        DEAL_AMT: 142241.02,
        DEAL_NUM: 7181858,
      },
    ],
    topDeals: [
      {
        MUTUAL_TYPE: '001',
        TRADE_DATE: '2026-08-21 00:00:00',
        SECURITY_CODE: '688256',
        SECURITY_NAME: '寒武纪',
        RANK: 1,
        DEAL_AMT: 2869486661,
        NET_BUY_AMT: null,
      },
      {
        MUTUAL_TYPE: '002',
        TRADE_DATE: '2026-08-21 00:00:00',
        SECURITY_CODE: '09988',
        SECURITY_NAME: '阿里巴巴-W',
        RANK: 1,
        DEAL_AMT: 5498626420,
      },
    ],
  })

  assert.equal(result.date, '2026-08-21')
  assert.equal(result.totalTurnoverYi, 2680.88)
  assert.equal(result.shTurnoverYi, 1258.47)
  assert.equal(result.szTurnoverYi, 1422.41)
  assert.equal(result.dealCount, 13529157)
  assert.equal(result.netBuyYi, null)
  assert.equal(result.topStocks.length, 1)
  assert.equal(result.topStocks[0].market, '沪股通')
  assert.equal(result.topStocks[0].turnoverYi, 28.69)
})

test('北向汇总与成交榜日期不一致时不混合数据', () => {
  const result = normalizeNorthboundData({
    history: [{
      MUTUAL_TYPE: '005',
      TRADE_DATE: '2026-08-21',
      DEAL_AMT: 200000,
    }],
    topDeals: [{
      MUTUAL_TYPE: '003',
      TRADE_DATE: '2026-08-20',
      SECURITY_CODE: '300750',
      SECURITY_NAME: '宁德时代',
      RANK: 1,
      DEAL_AMT: 1800000000,
    }],
  })

  assert.deepEqual(result.topStocks, [])
})
