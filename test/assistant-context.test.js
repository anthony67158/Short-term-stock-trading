import test from 'node:test'
import assert from 'node:assert/strict'

import {
  accountEvidence,
  evidenceFromTool,
  sanitizeAccountContext,
} from '../shared/assistantContext.js'

const NOW = Date.parse('2026-08-10T02:00:00.000Z')

test('账户上下文只保留白名单字段并限制数据量', () => {
  const context = sanitizeAccountContext({
    nick: '不应上传',
    password: 'secret',
    account: { totalAssets: 100000, cash: 30000, positionPct: 70, password: 'secret' },
    positions: Array.from({ length: 15 }, (_, index) => ({
      code: `600${String(index).padStart(3, '0')}`,
      name: `股票${index}`,
      qty: index + 1,
      cost: 10,
      currentPrice: 11,
      pnlPct: 10,
      sellableToday: index,
      t1Locked: index === 0,
      privateNote: '不应上传',
    })),
    watchlist: Array.from({ length: 25 }, (_, index) => ({
      code: `000${String(index).padStart(3, '0')}`,
      name: `自选${index}`,
      qScore: 60,
      note: '自由文本不上传',
    })),
    recentTrades: Array.from({ length: 15 }, (_, index) => ({
      type: 'BUY',
      code: '600000',
      name: '浦发银行',
      qty: 1,
      price: 10,
      at: NOW - index,
      password: 'secret',
    })),
  })

  assert.equal(context.positions.length, 12)
  assert.equal(context.watchlist.length, 20)
  assert.equal(context.recentTrades.length, 10)
  assert.deepEqual(Object.keys(context.account).sort(), ['cash', 'positionPct', 'totalAssets'])
  assert.equal('nick' in context, false)
  assert.equal('password' in context, false)
  assert.equal('privateNote' in context.positions[0], false)
  assert.equal('note' in context.watchlist[0], false)
})

test('联网新闻生成逐条可点击证据并拒绝非 HTTP 链接', () => {
  const evidence = evidenceFromTool('web_news', { query: '半导体' }, {
    news: [
      { title: '行业政策更新', date: '2026-08-10', url: 'https://example.com/news' },
      { title: '危险链接', date: '2026-08-10', url: 'javascript:alert(1)' },
    ],
  }, { startIndex: 2, now: NOW })

  assert.equal(evidence.length, 2)
  assert.equal(evidence[0].id, '证据2')
  assert.equal(evidence[0].url, 'https://example.com/news')
  assert.equal(evidence[1].url, '')
})

test('行情工具生成带来源和时间的摘要证据', () => {
  const evidence = evidenceFromTool('get_quote', { codes: '600519' }, {
    asOf: NOW,
    list: [{ code: '600519', name: '贵州茅台', price: 1400, pct: 1.2 }],
  }, { startIndex: 1, now: NOW })

  assert.equal(evidence[0].source, '东方财富实时行情')
  assert.match(evidence[0].summary, /贵州茅台.*1400.*1.2%/)
  assert.equal(evidence[0].asOf, new Date(NOW).toISOString())
})

test('账户证据只说明数据范围，不回显资产金额', () => {
  const context = sanitizeAccountContext({
    account: { totalAssets: 100000, cash: 30000 },
    positions: [{ code: '600519', name: '贵州茅台', qty: 1, cost: 1400 }],
    watchlist: [{ code: '000001', name: '平安银行' }],
  })
  const evidence = accountEvidence(context, 1, NOW)

  assert.equal(evidence.id, '证据1')
  assert.equal(evidence.source, '用户本地交易账本')
  assert.match(evidence.summary, /1 只持仓.*1 只自选/)
  assert.doesNotMatch(evidence.summary, /100000|30000/)
})

test('量化证据遇到异常 reads 类型时安全降级', () => {
  assert.doesNotThrow(() => evidenceFromTool('get_quant_score', { code: '600519' }, {
    name: '贵州茅台',
    quant: { score: 65, bias: '偏多', reads: '量价改善' },
  }, { now: NOW }))
})
