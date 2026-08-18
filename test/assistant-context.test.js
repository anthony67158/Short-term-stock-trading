import test from 'node:test'
import assert from 'node:assert/strict'

import {
  accountEvidence,
  amountInYi,
  authoritativeListCount,
  evidenceFromTool,
  formatEvidenceTime,
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
  assert.equal(context.watchlist.length, 25)
  assert.equal(context.recentTrades.length, 10)
  assert.deepEqual(context.counts, {
    positions: 15,
    watchlist: 25,
    recentTrades: 15,
  })
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

test('AI Search新闻单独标记为检索参考维度', () => {
  const evidence = evidenceFromTool('web_news', { query: '半导体' }, {
    news: [{
      title: '半导体行业订单回升',
      summary: '产业链订单改善',
      src: 'AI Search·example.com',
      kind: 'ai_search',
      date: '2026-08-14',
      url: 'https://example.com/chip',
    }],
  })

  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].dimension, 'search')
  assert.equal(evidence[0].summary, '产业链订单改善')
})

test('行情工具生成带来源和时间的摘要证据', () => {
  const evidence = evidenceFromTool('get_quote', { codes: '600519' }, {
    asOf: NOW,
    list: [{
      code: '600519',
      name: '贵州茅台',
      price: 1400,
      pct: 1.2,
      tradeDate: '2026-08-10',
      source: '腾讯财经',
    }],
  }, { startIndex: 1, now: NOW })

  assert.equal(evidence[0].title, '行情快照')
  assert.equal(evidence[0].source, '腾讯财经行情')
  assert.match(evidence[0].summary, /贵州茅台.*1400.*1.2%.*交易日2026-08-10/)
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

test('账户证据使用真实总数而不是上下文样本数', () => {
  const context = sanitizeAccountContext({
    capturedAt: NOW,
    counts: { positions: 15, watchlist: 29, recentTrades: 37 },
    positions: Array.from({ length: 12 }, (_, index) => ({
      code: `600${String(index).padStart(3, '0')}`,
      name: `持仓${index}`,
    })),
    watchlist: Array.from({ length: 20 }, (_, index) => ({
      code: `000${String(index).padStart(3, '0')}`,
      name: `自选${index}`,
    })),
    recentTrades: Array.from({ length: 10 }, () => ({
      type: 'BUY',
      code: '600000',
      at: NOW,
    })),
  })
  const serverContext = sanitizeAccountContext(context)
  const item = accountEvidence(serverContext, 1, Date.now())

  assert.deepEqual(serverContext.counts, {
    positions: 15,
    watchlist: 29,
    recentTrades: 37,
  })
  assert.match(item.summary, /15 只持仓.*29 只自选.*账本 37 条交易/)
  assert.match(item.summary, /提供 12 只明细.*提供 20 只明细.*最近 10 条/)
  assert.equal(item.asOf, new Date(NOW).toISOString())
  assert.equal(item.timeKind, 'snapshot')
})

test('新闻证据不把日期伪装成08点且缺失时间保持未知', () => {
  const items = evidenceFromTool('web_news', {}, {
    news: [
      { title: '只有日期', date: '2026-08-10' },
      { title: '没有日期' },
    ],
  }, { now: NOW })

  assert.equal(items[0].asOf, '2026-08-10')
  assert.equal(items[0].timeKind, 'published')
  assert.equal(items[1].asOf, '')
  assert.equal(formatEvidenceTime(items[0].asOf, items[0].timeKind), '发布 08/10')
  assert.equal(formatEvidenceTime(items[1].asOf, items[1].timeKind), '时间未知')
})

test('列表工具优先使用上游权威总数', () => {
  assert.equal(authoritativeListCount({
    total: 57,
    list: Array.from({ length: 24 }),
  }), 57)
  assert.equal(authoritativeListCount({
    list: Array.from({ length: 8 }),
  }), 8)
})

test('缺失数值保持缺失且资金金额不伪装为零', () => {
  const context = sanitizeAccountContext({
    account: { cash: null },
    positions: [{
      code: '600519',
      currentPrice: null,
      pnlPct: undefined,
      tp: '',
    }],
  })

  assert.equal('cash' in context.account, false)
  assert.equal('currentPrice' in context.positions[0], false)
  assert.equal('pnlPct' in context.positions[0], false)
  assert.equal('tp' in context.positions[0], false)
  assert.equal(amountInYi(null), null)
  assert.equal(amountInYi(undefined), null)
  assert.equal(amountInYi(125000000), 1.25)
})

test('量化证据遇到异常 reads 类型时安全降级', () => {
  assert.doesNotThrow(() => evidenceFromTool('get_quant_score', { code: '600519' }, {
    name: '贵州茅台',
    quant: { score: 65, bias: '偏多', reads: '量价改善' },
  }, { now: NOW }))
})
