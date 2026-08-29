import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ADVISOR_FAST_SYSTEM,
  ADVISOR_SYSTEM,
  buildUserPrompt,
} from '../api/_ai_prompts.js'
import { mapRealtimeStockFund } from '../api/ai.js'
import {
  buildStockFundNote,
  buildRetailFlowEvidence,
  mergeRetailFundFlow,
  normalizeFundNoteHistory,
} from '../shared/retailFundFlow.js'

const aiSource = readFileSync(
  new URL('../api/ai.js', import.meta.url),
  'utf8',
)
const confirmSource = readFileSync(
  new URL('../api/_confirm.js', import.meta.url),
  'utf8',
)

test('资金说明由服务端写入完整五日序列和合计', () => {
  const note = buildStockFundNote({
    mainNetYi: -14.03,
    retailNetYi: 12.59,
    mainTrend5: [-8, 18.41, -4.22, 13.17, -14.03],
    retailTrend5: [7.5, -9.82, 3.77, -7.68, 12.59],
    main5dYi: 5.33,
    retail5dYi: 6.36,
    historyDayCount: 5,
    historyComplete: true,
  })

  assert.match(note, /主力当日净流出14\.03亿元/)
  assert.match(note, /最近5日主力\[-8,18\.41,-4\.22,13\.17,-14\.03\]/)
  assert.match(note, /小单资金代理\[7\.5,-9\.82,3\.77,-7\.68,12\.59\]/)
  assert.match(note, /5日合计主力净流入5\.33亿元/)
  assert.match(note, /小单资金代理净流入6\.36亿元/)
  assert.match(note, /不等于真实账户身份/)
})

test('实时资金快照同时映射主力与小单净流入', () => {
  const snapshot = mapRealtimeStockFund({
    f62: 120_000_000,
    f84: -80_000_000,
    f184: 6.2,
    f66: 70_000_000,
    f72: 50_000_000,
    f164: 550_000_000,
    f172: -310_000_000,
    f124: Date.parse('2026-08-28T07:00:00.000Z') / 1000,
  })

  assert.equal(snapshot.mainNetYi, 1.2)
  assert.equal(snapshot.smallNetYi, -0.8)
  assert.equal(snapshot.retailNetYi, -0.8)
  assert.equal(snapshot.main5dYi, 5.5)
  assert.equal(snapshot.retail5dYi, -3.1)
  assert.equal(snapshot.asOfDate, '2026-08-28')
})

test('主力流出且小单流入识别为散户承接风险而非买入信号', () => {
  const evidence = buildRetailFlowEvidence({
    mainNetYi: -1.2,
    retailNetYi: 0.8,
    pct: 4.5,
    turnover: 12,
    volRatio: 2.2,
    asOfDate: '2026-08-24',
    isHistorical: false,
  })

  assert.equal(evidence.relation, 'main_out_retail_in')
  assert.equal(evidence.bias, 'risk')
  assert.match(evidence.interpretation, /小单承接大单抛压/)
  assert.match(evidence.confirmation, /高位|放量|冲高/)
  assert.match(evidence.caveat, /不等于真实账户身份/)
})

test('主力流入且小单流出识别为可能承接但要求量价确认', () => {
  const evidence = buildRetailFlowEvidence({
    mainNetYi: 1.5,
    smallNetYi: -0.6,
    pct: 1.8,
  })

  assert.equal(evidence.relation, 'main_in_retail_out')
  assert.equal(evidence.bias, 'constructive')
  assert.match(evidence.interpretation, /大单承接小单抛压/)
  assert.match(evidence.confirmation, /价格|量能/)
})

test('盘中行情资金可兜底历史接口且非实时快照不能覆盖历史值', () => {
  const live = mergeRetailFundFlow(null, {
    live: true,
    asOfLabel: '2026-08-24',
    pct: 3.2,
    turnover: 9,
    volRatio: 1.8,
    mainNetYi: -1.1,
    retailNetYi: 0.7,
  })
  assert.equal(live.isHistorical, false)
  assert.equal(live.retailFlow.relation, 'main_out_retail_in')

  const historical = mergeRetailFundFlow({
    asOfDate: '2026-08-21',
    isHistorical: true,
    mainNetYi: 1.3,
    smallNetYi: -0.5,
  }, {
    live: false,
    mainNetYi: -9,
    retailNetYi: 9,
  })
  assert.equal(historical.mainNetYi, 1.3)
  assert.equal(historical.retailNetYi, -0.5)
  assert.equal(historical.retailFlow.relation, 'main_in_retail_out')
})

test('缺失的主力或散户资金保持null而不是伪装成0', () => {
  const evidence = buildRetailFlowEvidence({
    mainNetYi: null,
    retailNetYi: 0.4,
  })

  assert.equal(evidence.mainNetYi, null)
  assert.equal(evidence.retailNetYi, 0.4)
  assert.equal(evidence.relation, 'partial')
})

test('军师快速、深度与复核提示都强制合参散户资金', () => {
  const payload = {
    code: '600000',
    generationProfile: 'FAST',
    stockFund: {
      mainNetYi: -1.2,
      retailNetYi: 0.8,
      smallNetYi: 0.8,
      mainTrend5: [0.4, 0.2, -0.1, -0.5, -1.2],
      retailTrend5: [-0.3, -0.1, 0.1, 0.4, 0.8],
      retailFlow: {
        relation: 'main_out_retail_in',
        interpretation: '大单主动卖出、小单主动买入，可能是小单承接大单抛压。',
      },
    },
  }
  const fast = buildUserPrompt('hold_advice', payload)
  const review = buildUserPrompt('review', {
    ...payload,
    generationProfile: 'DEEP',
  })

  assert.match(ADVISOR_SYSTEM, /小单净流入/)
  assert.match(ADVISOR_SYSTEM, /不等于真实账户身份/)
  assert.match(ADVISOR_FAST_SYSTEM, /散户资金/)
  assert.match(fast, /fundNote.*mainNetYi.*retailNetYi/)
  assert.match(fast, /mainTrend5/)
  assert.match(fast, /retailTrend5/)
  assert.match(review, /fundNote.*主力.*散户/)
  assert.match(review, /DISTRIBUTION/)

  const limitUp = buildUserPrompt('hold_advice', {
    ...payload,
    generationProfile: 'DEEP',
    todayQuote: {
      live: true,
      price: 11,
      pct: 10,
      isLimitUp: true,
    },
  })
  assert.doesNotMatch(ADVISOR_SYSTEM, /涨停→今日主力大幅流入/)
  assert.doesNotMatch(limitUp, /说明今日主力大幅流入/)
  assert.match(limitUp, /资金净额.*被动成交|被动排队.*资金/)
})

test('资金历史不足五日时提示词禁止冒充五日序列', () => {
  const prompt = buildUserPrompt('buy_advice', {
    code: '600487',
    stockFund: {
      mainNetYi: -14.03,
      retailNetYi: 12.59,
      mainTrend5: [-14.03],
      retailTrend5: [12.59],
      historyDayCount: 1,
      historyComplete: false,
    },
  })

  assert.match(prompt, /仅取得1个交易日/)
  assert.match(prompt, /不能称为最近5日/)
  assert.doesNotMatch(prompt, /判断最近5日持续/)
  assert.equal(
    normalizeFundNoteHistory(
      '最近5日序列分别为[-14.03]和[12.59]，形成背离。',
      {
        mainTrend5: [-14.03],
        retailTrend5: [12.59],
        historyDayCount: 1,
      },
    ),
    '当前1个交易日序列分别为[-14.03]和[12.59]，形成背离；'
      + '历史资金仅取得1个交易日，不能据此判断5日持续性。',
  )
})

test('逐日历史不足时军师仍使用同日五日累计但不判断连续性', () => {
  const stockFund = mergeRetailFundFlow({
    source: 'historical',
    asOfDate: '2026-08-28',
    mainNetYi: 1.81,
    retailNetYi: -2.11,
    mainTrend5: [1.81],
    retailTrend5: [-2.11],
    historyDayCount: 1,
    historyComplete: false,
  }, {
    live: false,
    tradeDate: '2026-08-28',
    asOfLabel: '2026-08-28(周五)',
    mainNetYi: 1.81,
    retailNetYi: -2.11,
    main5dYi: 2.87,
    retail5dYi: -4.17,
  })

  assert.equal(stockFund.main5dYi, 2.87)
  assert.equal(stockFund.retail5dYi, -4.17)
  assert.equal(stockFund.fiveDaySource, 'quote-aggregate')

  for (const [mode, generationProfile] of [
    ['buy_advice', 'FAST'],
    ['hold_advice', 'DEEP'],
    ['review', 'FAST'],
  ]) {
    const prompt = buildUserPrompt(mode, {
      code: '300390',
      generationProfile,
      stockFund,
    })
    assert.match(prompt, /5日聚合主力=2\.87/)
    assert.match(prompt, /5日聚合小单=-4\.17/)
    assert.match(prompt, /必须用于判断五日总体方向/)
    assert.match(prompt, /不能判断逐日连续性/)
  }

  const note = buildStockFundNote(stockFund)
  assert.match(note, /5日累计主力净流入2\.87亿元/)
  assert.match(note, /5日累计小单资金代理净流出4\.17亿元/)
  assert.match(note, /不能判断逐日连续性/)
  assert.equal(
    normalizeFundNoteHistory(
      '近5日累计主力净流入2.87亿元。',
      stockFund,
    ),
    '近5日累计主力净流入2.87亿元；'
      + '已取得5日累计，但逐日资金仅取得1个交易日，'
      + '不能据此判断逐日连续性。',
  )
})

test('快速深度军师与Judge统一使用可靠资金入口', () => {
  assert.match(
    aiSource,
    /fetchResilientStockFund\(payload\.code,\s*\{/,
  )
  assert.match(
    confirmSource,
    /providers\.fetchStockFund\s*\|\|\s*fetchResilientStockFund/,
  )
})
