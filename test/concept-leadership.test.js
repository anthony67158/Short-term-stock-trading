import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildConceptLeaderCandidates,
  identifyConceptLeaders,
  rankActiveConcepts,
  selectConceptAwareCandidatePool,
} from '../shared/conceptLeadership.js'
import {
  normalizePickDecision,
  rankCandidateShortlist,
} from '../shared/stockRanking.js'

const sector = (patch = {}) => ({
  code: 'BK1000',
  name: '机器人',
  pct: 3.2,
  mainInflow: 1_200_000_000,
  mainRatio: 8,
  amount: 35_000_000_000,
  leadCode: '600001',
  leadName: '龙头股份',
  leadPct: 7.5,
  ...patch,
})

const member = (patch = {}) => ({
  code: '600001',
  name: '龙头股份',
  price: 20,
  pct: 7.5,
  mainInflow: 450_000_000,
  mainRatio: 12,
  amount: 5_000_000_000,
  turnover: 8,
  volRatio: 2.4,
  amplitude: 9,
  ...patch,
})

test('活跃概念按资金、涨幅、成交与领涨强度确定性排序并排除逆风概念', () => {
  const result = rankActiveConcepts([
    sector(),
    sector({
      code: 'BK1001',
      name: 'CPO',
      pct: 1.5,
      mainInflow: 500_000_000,
      mainRatio: 4,
      amount: 18_000_000_000,
      leadCode: '600010',
      leadName: '光模块',
      leadPct: 4,
    }),
    sector({
      code: 'BK1002',
      name: '退潮概念',
      pct: -2,
      mainInflow: -300_000_000,
      mainRatio: -5,
      leadCode: '600020',
      leadName: '弱势股份',
      leadPct: -1,
    }),
  ])

  assert.deepEqual(result.map((item) => item.code), ['BK1000', 'BK1001'])
  assert.ok(result[0].conceptStrength > result[1].conceptStrength)
  assert.equal(result[0].schemaVersion, 'concept-leadership.v1')
  assert.ok(result[0].evidence.mainInflowRank > result[1].evidence.mainInflowRank)
})

test('总龙头、趋势中军与弹性先锋只从真实成分股产生', () => {
  const concept = rankActiveConcepts([sector()])[0]
  const leaders = identifyConceptLeaders(concept, [
    member(),
    member({
      code: '600002',
      name: '趋势中军',
      pct: 3,
      mainInflow: 700_000_000,
      mainRatio: 9,
      amount: 12_000_000_000,
      turnover: 4,
      volRatio: 1.5,
      amplitude: 5,
    }),
    member({
      code: '600003',
      name: '弹性先锋',
      pct: 9.2,
      mainInflow: 180_000_000,
      mainRatio: 5,
      amount: 2_000_000_000,
      turnover: 18,
      volRatio: 4.2,
      amplitude: 14,
    }),
  ], {
    limitPool: [{ code: '600003', lbc: 2 }],
  })

  assert.equal(
    leaders.find((item) => item.code === '600001').conceptLeadership.role,
    'leader',
  )
  assert.equal(
    leaders.find((item) => item.code === '600002').conceptLeadership.role,
    'core',
  )
  assert.equal(
    leaders.find((item) => item.code === '600003').conceptLeadership.role,
    'elastic',
  )
  assert.ok(leaders.every(
    (item) => item.conceptLeadership.memberVerified === true,
  ))
  assert.ok(leaders.every(
    (item) => Number.isFinite(item.conceptLeadership.leaderScore),
  ))

  const fakeLeadConcept = {
    ...concept,
    leadCode: '699999',
    leadName: '不存在的领涨股',
  }
  const verified = identifyConceptLeaders(fakeLeadConcept, [
    member({ code: '600011', name: '真实成分股' }),
  ])
  assert.equal(verified.some((item) => item.code === '699999'), false)
})

test('量化前候选池按配额保留强概念龙头且完成代码去重', () => {
  const concepts = rankActiveConcepts([
    sector(),
    sector({
      code: 'BK1001',
      name: 'CPO',
      leadCode: '600011',
      leadName: '光模块龙头',
    }),
  ])
  const conceptCandidates = buildConceptLeaderCandidates(
    concepts,
    new Map([
      ['BK1000', [member()]],
      ['BK1001', [member({ code: '600011', name: '光模块龙头' })]],
    ]),
  )
  const marketCandidates = Array.from({ length: 6 }, (_, index) => ({
    code: `60100${index}`,
    name: `市场${index}`,
    marketScore: 90 - index,
  }))
  const eventCandidates = [
    { code: '602001', name: '事件一', tags: ['涨停'] },
    { code: '602002', name: '事件二', tags: ['抢筹'] },
  ]

  const selected = selectConceptAwareCandidatePool({
    marketCandidates,
    conceptCandidates,
    eventCandidates,
    limit: 6,
    marketQuota: 2,
    conceptQuota: 2,
    eventQuota: 2,
  })

  assert.equal(selected.length, 6)
  assert.equal(new Set(selected.map((item) => item.code)).size, 6)
  assert.deepEqual(
    selected.filter((item) => item.conceptLeadership).map((item) => item.code),
    ['600001', '600011'],
  )
})

test('量化后保留位让龙头进入模型短名单但不能绕过入场确认', () => {
  const candidates = [
    ...Array.from({ length: 4 }, (_, index) => ({
      code: `60300${index}`,
      name: `普通候选${index}`,
      marketScore: 85 - index,
      pct: 2,
      volRatio: 1.5,
      quant: { score: 75 - index, upProb: 62, expRet: 2.5 },
    })),
    {
      code: '600001',
      name: '机器人总龙头',
      marketScore: 58,
      pct: 8,
      volRatio: 1.5,
      quant: { score: 40, upProb: 55, expRet: 1 },
      conceptLeadership: {
        schemaVersion: 'concept-leadership.v1',
        conceptCode: 'BK1000',
        conceptName: '机器人',
        conceptStrength: 82,
        role: 'leader',
        roleLabel: '总龙头',
        leaderScore: 86,
        memberVerified: true,
      },
    },
  ]

  const shortlist = rankCandidateShortlist(candidates, {
    limit: 3,
    leadershipReserve: 1,
  })

  assert.equal(shortlist.list.some((item) => item.code === '600001'), true)
  const leader = shortlist.list.find((item) => item.code === '600001')
  assert.equal(leader.entrySignal.passed, false)
  assert.equal(shortlist.executable.some((item) => item.code === '600001'), false)
  assert.equal(shortlist.watchlist.some((item) => item.code === '600001'), true)

  const decision = normalizePickDecision({
    noTrade: false,
    picks: [{
      code: '600001',
      name: '机器人总龙头',
      actionability: '可执行',
    }],
  }, shortlist.list.map((item) => item.code), shortlist.list)
  assert.equal(decision.picks[0].actionability, '等待触发')
  assert.equal(decision.picks[0].conceptLeadership.role, 'leader')
})
