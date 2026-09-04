import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PRE_CATALYST_SCHEMA_VERSION,
  buildPreCatalystCandidate,
  classifyPreCatalystEvent,
  normalizePreCatalystAnnouncement,
  rankPreCatalystCandidates,
} from '../shared/preCatalyst.js'

const now = Date.parse('2026-09-04T19:00:00+08:00')

test('巨潮公告标准化后保留首次披露时间与官方来源', () => {
  const event = normalizePreCatalystAnnouncement({
    announcementId: '1225000001',
    secCode: '300001',
    secName: '测试科技',
    announcementTitle: '<em>测试科技</em>：关于签订重大合同的公告',
    announcementTime: now - 60_000,
    adjunctUrl: 'finalpage/2026-09-04/1225000001.PDF',
  }, { now })

  assert.equal(event.eventId, 'CNINFO:1225000001')
  assert.equal(event.code, '300001')
  assert.equal(event.title, '测试科技：关于签订重大合同的公告')
  assert.equal(event.sourceAuthority, 'OFFICIAL')
  assert.equal(
    event.sourceUrl,
    'https://static.cninfo.com.cn/finalpage/2026-09-04/1225000001.PDF',
  )
})

test('公告分类区分订单、机构调研、风险与日常噪声', () => {
  assert.equal(
    classifyPreCatalystEvent('关于签订重大销售合同的公告').eventType,
    'ORDER',
  )
  assert.equal(
    classifyPreCatalystEvent('投资者关系活动记录表').eventType,
    'INSTITUTION_VISIT',
  )
  assert.equal(
    classifyPreCatalystEvent('关于收到行政处罚事先告知书的公告').direction,
    'NEGATIVE',
  )
  assert.equal(
    classifyPreCatalystEvent('第六届董事会第十次会议决议公告').eligible,
    false,
  )
})

test('事件强但价格未启动的股票进入潜伏观察而不是立即买入', () => {
  const event = {
    schemaVersion: PRE_CATALYST_SCHEMA_VERSION,
    eventId: 'CNINFO:1225000001',
    code: '300001',
    name: '测试科技',
    title: '关于签订重大销售合同的公告',
    eventType: 'ORDER',
    eventLabel: '重大订单',
    direction: 'POSITIVE',
    materialityScore: 86,
    publishedAt: now - 60_000,
    sourceUrl:
      'https://static.cninfo.com.cn/finalpage/2026-09-04/1225000001.PDF',
    sourceAuthority: 'OFFICIAL',
  }
  const candidate = buildPreCatalystCandidate({
    event,
    relation: {
      type: 'DIRECT',
      score: 100,
      evidence: '公告主体',
    },
    quote: {
      code: '300001',
      name: '测试科技',
      price: 10,
      pct: 0.6,
      amount: 180_000_000,
      turnover: 2.1,
      volumeRatio: 1.15,
      mainInflow: 12_000_000,
      mainRatio: 3.2,
      amountPercentile: 0.48,
      turnoverPercentile: 0.42,
    },
    candles: Array.from({ length: 22 }, (_, index) => ({
      date: `2026-08-${String(index + 10).padStart(2, '0')}`,
      open: 9.7 + index * 0.01,
      high: 10.05 + index * 0.01,
      low: 9.55 + index * 0.01,
      close: 9.75 + index * 0.01,
    })),
    tags: {
      industry: '专用设备',
      concepts: ['工业自动化'],
    },
    now,
  })

  assert.equal(candidate.state, 'WAIT_TRIGGER')
  assert.equal(candidate.stateLabel, '潜伏预判')
  assert.equal(candidate.forecast.state, 'CALIBRATING')
  assert.ok(candidate.activationScore >= 60)
  assert.ok(candidate.entryPlan.price > 0)
  assert.ok(candidate.exitPlan.hardStopPrice < candidate.entryPlan.price)
  assert.ok(candidate.riskReward >= 1.8)
  assert.match(candidate.evidence.join('；'), /官方公告/)
  assert.doesNotMatch(candidate.stateLabel, /立即买入/)
})

test('已经明显上涨或风险公告不能进入潜伏候选', () => {
  const riskEvent = classifyPreCatalystEvent(
    '关于公司股票可能被实施退市风险警示的公告',
  )
  assert.equal(riskEvent.eligible, false)

  const candidate = buildPreCatalystCandidate({
    event: {
      eventId: 'CNINFO:1225000002',
      code: '300002',
      name: '过热股份',
      title: '关于签订重大合同的公告',
      eventType: 'ORDER',
      eventLabel: '重大订单',
      direction: 'POSITIVE',
      materialityScore: 86,
      publishedAt: now,
      sourceAuthority: 'OFFICIAL',
    },
    relation: { type: 'DIRECT', score: 100 },
    quote: {
      code: '300002',
      name: '过热股份',
      price: 20,
      pct: 9.8,
      amount: 900_000_000,
      turnover: 18,
      volumeRatio: 4.2,
      mainInflow: 50_000_000,
      mainRatio: 9,
      amountPercentile: 0.98,
      turnoverPercentile: 0.98,
    },
    candles: [],
    now,
  })

  assert.equal(candidate, null)
})

test('预催化排序按分数并限制同一概念集中度', () => {
  const rows = [
    {
      code: '000001',
      activationScore: 81,
      tags: { concepts: ['机器人'] },
    },
    {
      code: '000002',
      activationScore: 78,
      tags: { concepts: ['机器人'] },
    },
    {
      code: '000003',
      activationScore: 75,
      tags: { concepts: ['机器人'] },
    },
    {
      code: '000004',
      activationScore: 74,
      tags: { concepts: ['商业航天'] },
    },
  ]

  assert.deepEqual(
    rankPreCatalystCandidates(rows, {
      limit: 5,
      maxPerConcept: 2,
    }).map((item) => item.code),
    ['000001', '000002', '000004'],
  )
})
