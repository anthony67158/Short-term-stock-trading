import test from 'node:test'
import assert from 'node:assert/strict'

import { techSummaryForAI } from '../api/_ta.js'
import { buildUserPrompt } from '../api/_ai_prompts.js'
import {
  buildShortHorizonTactical,
  deriveShortHorizonActionPolicy,
} from '../shared/shortHorizonTactical.js'
import { adviceEvidenceDigest } from '../shared/adviceIntelligence.js'

function technicalSource() {
  return {
    verdict: '偏多：多项指标共振向上，逢低吸纳为主',
    bull: 5,
    bear: 1,
    ma: {
      ma5: 33.802,
      ma10: 34.808,
      ma20: 32.803,
      ma60: 38.52,
    },
    maCross: 'gold',
    maTrend: 'bull',
    atr: { atr: 1.18, atrPct: 3.49 },
    boll: {
      lower: 31.2,
      mid: 33.1,
      upper: 35,
      pctB: 62,
      width: 11.5,
    },
    rsi: 58.4,
    kdj: { k: 62.1, d: 55.2, j: 75.9 },
    macd: {
      dif: 0.31,
      dea: 0.22,
      macd: 0.18,
      cross: 'gold',
    },
    volRatio: 1.4,
    sr: { support: 32.31, resistance: 35 },
    priceHints: {
      buyZone: { low: 32.31, high: 32.803 },
      sellZone: { low: 35, high: 35 },
      stopLoss: 31.6,
      takeProfit: 36.1,
    },
  }
}

test('军师技术摘要保留均线、MACD、KDJ、BOLL与ATR结构值', () => {
  const summary = techSummaryForAI(technicalSource())

  assert.equal(summary.ma.ma5, 33.802)
  assert.equal(summary.maTrend, '均线多头排列(5>10>20>60)')
  assert.deepEqual(summary.kdjDetail, {
    k: 62.1,
    d: 55.2,
    j: 75.9,
  })
  assert.deepEqual(summary.macdDetail, {
    dif: 0.31,
    dea: 0.22,
    hist: 0.18,
    cross: 'gold',
  })
  assert.equal(summary.boll.pctB, 62)
  assert.equal(summary.atrPct, 3.49)
  assert.equal(adviceEvidenceDigest({
    evidence: {
      technical: { indicators: summary },
    },
  }).technical.macdHistSign, 1)
})

test('快速和深度军师事实合同显式携带完整技术面', () => {
  const tech = techSummaryForAI(technicalSource())
  const payload = {
    code: '000001',
    todayQuote: {
      price: 33.9,
      pct: 1.2,
      amount: 2e8,
      turnover: 4.2,
      volRatio: 1.4,
      live: true,
      phase: '上午盘中',
    },
    marketEnv: {
      score: 65,
      allowRiskIncrease: true,
    },
    stockFund: {
      mainNetYi: 0.8,
      retailNetYi: -0.3,
    },
    quant: {
      forecast: {
        direction: '震荡偏多',
        upProb: 56,
        expRet: 0.8,
      },
    },
    tech,
  }
  const tactical = buildShortHorizonTactical(payload)
  const policy = deriveShortHorizonActionPolicy({
    mode: 'buy_advice',
    tactical,
    requestedAction: 'BUY',
  })
  const prompt = buildUserPrompt('buy_advice', {
    ...payload,
    shortHorizonTactical: {
      ...tactical,
      actionPolicy: policy,
    },
  })
  const deepPrompt = buildUserPrompt('buy_advice', {
    ...payload,
    generationProfile: 'DEEP',
    shortHorizonTactical: {
      ...tactical,
      actionPolicy: policy,
    },
  })

  assert.equal(tactical.technical.bias, 'BULLISH')
  assert.equal(tactical.technical.ma.ma20, 32.803)
  assert.equal(tactical.technical.macd.hist, 0.18)
  assert.equal(tactical.technical.kdj.j, 75.9)
  assert.equal(tactical.timing.state, 'READY')
  assert.match(prompt, /\"ma5\":33\.802/)
  assert.match(prompt, /\"hist\":0\.18/)
  assert.match(prompt, /techNote必须引用至少两类/)
  assert.match(prompt, /不得机械等待回踩或突破/)
  assert.match(deepPrompt, /\"ma20\":32\.803/)
  assert.match(deepPrompt, /\"j\":75\.9/)
  assert.match(deepPrompt, /techNote必须引用至少两类/)
  assert.equal(policy.riskTier, 'PROBE')
  assert.match(policy.confirmations.join('；'), /技术面多头共振/)
})
