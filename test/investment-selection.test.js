import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildInvestmentCandidates,
  rankInvestmentConcepts,
  scoreCompanyInvestmentQuality,
} from '../shared/investmentSelection.js'
import { mapStockRow } from '../api/stocks.js'
import { rankCandidateShortlist } from '../shared/stockRanking.js'

const concept = (patch = {}) => ({
  code: 'BK1000',
  name: '高端制造',
  pct: 0.4,
  mainInflow: 120_000_000,
  mainRatio: 1.8,
  amount: 18_000_000_000,
  leadCode: '600001',
  leadName: '制造龙头',
  leadPct: 2.1,
  ...patch,
})

const member = (patch = {}) => ({
  code: '600001',
  name: '制造龙头',
  price: 20,
  pct: 1.2,
  mainInflow: 160_000_000,
  mainRatio: 5,
  amount: 2_000_000_000,
  turnover: 3,
  volRatio: 1.3,
  pe: 24,
  pb: 2.8,
  totalMarketCap: 42_000_000_000,
  ...patch,
})

test('战略产业概念无需涨停或大涨也能进入产业观察方向', () => {
  const ranked = rankInvestmentConcepts([
    concept({
      code: 'BK1001',
      name: '工业母机',
      pct: 0.2,
      mainInflow: 80_000_000,
    }),
    concept({
      code: 'BK1002',
      name: '昨日涨停',
      pct: 6.5,
      mainInflow: 900_000_000,
      mainRatio: 12,
    }),
  ])

  assert.deepEqual(ranked.map((item) => item.code), ['BK1001'])
  assert.ok(ranked[0].investmentTheme.strategicScore >= 70)
  assert.match(ranked[0].investmentTheme.thesis, /制造|自主/)
  assert.equal(ranked[0].investmentTheme.fundConfirmed, true)
})

test('公司质量代理分综合估值规模资金并惩罚纯高热度投机', () => {
  const quality = scoreCompanyInvestmentQuality(member())
  const speculative = scoreCompanyInvestmentQuality(member({
    code: '600002',
    name: '高热度小票',
    pct: 8.5,
    turnover: 24,
    mainInflow: -80_000_000,
    mainRatio: -4,
    pe: 180,
    pb: 18,
    totalMarketCap: 3_000_000_000,
  }))

  assert.equal(quality.verified, true)
  assert.ok(quality.score > speculative.score)
  assert.ok(quality.evidence.some((item) => /PE/.test(item)))
  assert.ok(quality.evidence.some((item) => /总市值/.test(item)))
})

test('概念成分股接口保留估值与总市值真实字段', () => {
  const stock = mapStockRow({
    f12: '600001',
    f14: '制造龙头',
    f2: 20,
    f3: 1.2,
    f9: 24.5,
    f20: 42_000_000_000,
    f23: 2.8,
  })

  assert.equal(stock.pe, 24.5)
  assert.equal(stock.pb, 2.8)
  assert.equal(stock.totalMarketCap, 42_000_000_000)
})

test('产业方向先行且个股必须来自该概念真实成分股', () => {
  const concepts = rankInvestmentConcepts([concept()])
  const candidates = buildInvestmentCandidates(
    concepts,
    new Map([['BK1000', [
      member(),
      member({
        code: '600002',
        name: '投机跟风',
        pe: 150,
        pb: 15,
        totalMarketCap: 4_000_000_000,
        turnover: 22,
      }),
    ]]]),
  )

  assert.equal(candidates[0].code, '600001')
  assert.equal(candidates[0].investmentProfile.memberVerified, true)
  assert.equal(candidates[0].investmentProfile.conceptName, '高端制造')
  assert.ok(candidates[0].investmentProfile.investmentScore >= 65)
})

test('缺少估值或市值证据的股票不能占用公司价值保留位', () => {
  assert.equal(scoreCompanyInvestmentQuality(member({
    pe: null,
    pb: null,
    totalMarketCap: null,
  })).verified, false)
  const concepts = rankInvestmentConcepts([concept()])
  const candidates = buildInvestmentCandidates(
    concepts,
    new Map([['BK1000', [member({
      pe: null,
      pb: null,
      totalMarketCap: null,
    })]]]),
  )

  assert.deepEqual(candidates, [])
})

test('高产业价值公司在交易条件相近时排在纯热度票之前', () => {
  const strategic = {
    code: '600001',
    name: '战略制造',
    marketScore: 62,
    pct: 1.5,
    volRatio: 1.2,
    quant: { score: 60, upProb: 60, expRet: 2 },
    investmentProfile: {
      schemaVersion: 'investment-selection.v1',
      memberVerified: true,
      companyQualityVerified: true,
      investmentScore: 88,
      conceptName: '工业母机',
    },
  }
  const hot = {
    code: '600002',
    name: '纯热度票',
    marketScore: 88,
    pct: 8,
    volRatio: 4,
    quant: { score: 58, upProb: 58, expRet: 1.5 },
  }

  const result = rankCandidateShortlist([hot, strategic], {
    limit: 2,
    investmentReserve: 1,
  })

  assert.equal(result.list[0].code, '600001')
  assert.ok(result.list[0].attentionScore > result.list[1].attentionScore)
  assert.ok(strategic.investmentProfile.investmentScore > 80)
})

test('产业价值保留位不能绕过量价与量化确认', () => {
  const result = rankCandidateShortlist([{
    code: '600001',
    name: '战略制造',
    marketScore: 62,
    pct: 1.5,
    volRatio: 1.2,
    quant: { score: 54, upProb: 60, expRet: 2 },
    investmentProfile: {
      schemaVersion: 'investment-selection.v1',
      memberVerified: true,
      companyQualityVerified: true,
      investmentScore: 88,
      conceptName: '工业母机',
    },
  }], {
    limit: 1,
    investmentReserve: 1,
  })

  assert.equal(result.list[0].entrySignal.passed, false)
  assert.equal(result.executable.length, 0)
  assert.equal(result.watchlist[0].code, '600001')
})
