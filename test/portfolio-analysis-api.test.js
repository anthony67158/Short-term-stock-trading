import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import portfolioAnalysisHandler, {
  portfolioRequestOrigin,
} from '../api/portfolio_analysis.js'

const source = readFileSync(
  new URL('../api/portfolio_analysis.js', import.meta.url),
  'utf8',
)
const accountSource = readFileSync(
  new URL('../api/account.js', import.meta.url),
  'utf8',
)
const serverSource = readFileSync(
  new URL('../server.js', import.meta.url),
  'utf8',
)

function responseStub() {
  let resolve
  const ended = new Promise((done) => { resolve = done })
  return {
    statusCode: 200,
    headers: {},
    body: '',
    ended,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    send(body) {
      this.body = String(body)
      resolve()
      return this
    },
    end(body = '') {
      this.body = String(body)
      resolve()
      return this
    },
    write(chunk) {
      this.body += String(chunk)
      return true
    },
  }
}

test('匿名调用持仓诊断必须在采集行情与调用模型前返回401', async () => {
  const req = {
    method: 'POST',
    headers: {},
    body: {
      deepMode: true,
      holding: [{ code: '600519', qty: 999 }],
    },
    query: {},
  }
  const res = responseStub()

  await portfolioAnalysisHandler(req, res)
  await res.ended

  assert.equal(res.statusCode, 401)
  assert.deepEqual(JSON.parse(res.body), {
    ok: false,
    error: '请先登录',
  })
})

test('持仓诊断只使用鉴权账号快照并集成检索、量化与Function Calling', () => {
  assert.match(source, /authorizePaidRequest\(req\)/)
  assert.match(source, /accountAuth\.account\?\.data/)
  assert.doesNotMatch(source, /body\.(?:holding|account|cash)/)
  assert.match(source, /fetchAiSearchReference\(/)
  assert.match(source, /stock_detail\?/)
  assert.match(source, /type:\s*'function'/)
  assert.match(source, /tools:/)
  assert.match(source, /role:\s*'portfolio'/)
})

test('持仓诊断采集T+1约束并对缺失概念候选执行量化筛选', () => {
  assert.match(source, /t1StatusOf\(/)
  assert.match(source, /selectPortfolioCandidates\(/)
  assert.match(source, /candidateRows/)
  assert.match(source, /get_candidate_quant/)
  assert.match(source, /recommendationCatalog/)
})

test('模型契约强制输出执行单、概念增减、场景方案和失效条件', () => {
  assert.match(source, /executionSummary/)
  assert.match(source, /conceptActions/)
  assert.match(source, /scenarioPlan/)
  assert.match(source, /targetWeightPct/)
  assert.match(source, /triggerPrice/)
  assert.match(source, /invalidation/)
  assert.match(source, /repairLowQualityAnalysis/)
  assert.match(source, /quality\.score\s*<\s*60/)
})

test('深度分析通过阶段、证据与决策节点展示过程，不输出隐藏推理原文', () => {
  assert.match(source, /emit\('phase'/)
  assert.match(source, /emit\('evidence'/)
  assert.match(source, /emit\('decision'/)
  assert.doesNotMatch(source, /emit\('reasoning'/)
  assert.doesNotMatch(source, /send\('reasoning'/)
})

test('服务内采集在本地开发使用HTTP，线上默认保持HTTPS', () => {
  assert.equal(
    portfolioRequestOrigin({
      headers: { host: '127.0.0.1:3000' },
    }),
    'http://127.0.0.1:3000',
  )
  assert.equal(
    portfolioRequestOrigin({
      headers: { host: 'stock.example.com' },
    }),
    'https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run',
  )
  assert.equal(
    portfolioRequestOrigin({
      headers: {
        host: 'attacker.example',
        'x-forwarded-host': 'attacker.example',
      },
    }),
    'https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run',
  )
  assert.equal(
    portfolioRequestOrigin({
      headers: { host: 'stock.example.com' },
    }, {
      FC_SERVER_PORT: '9000',
    }),
    'http://127.0.0.1:9000',
  )
})

test('持仓诊断支持服务端排队、状态恢复和FC异步Worker', () => {
  assert.match(source, /op === 'start'/)
  assert.match(source, /op === 'status'/)
  assert.match(source, /op === 'worker'/)
  assert.match(source, /op === 'resume'/)
  assert.match(source, /dispatchPortfolioAnalysisWorker\(/)
  assert.match(source, /writeAccount\(/)
  assert.match(source, /portfolioAnalysisJob/)
  assert.match(accountSource, /prev\.portfolioAnalysisJob/)
  assert.match(serverSource, /portfolioAnalysisWorkerBody\(/)
  assert.match(serverSource, /portfolioAnalysisTimerBody\(/)
})

test('持仓诊断状态返回最新保留结果、历史摘要与复核配置', () => {
  assert.match(source, /op === 'setReview'/)
  assert.match(source, /op === 'history'/)
  assert.match(source, /latestPortfolioAnalysis\(/)
  assert.match(source, /listPortfolioAnalysisHistory\(/)
  assert.match(source, /portfolioAnalysisReviewConfig\(/)
  assert.match(source, /portfolioAnalysisReviewDeepMode\(/)
  assert.match(source, /portfolioAnalysisReviewDue\(/)
  assert.match(source, /accountTradeStateFingerprint\(/)
  assert.match(
    source,
    /cacheOnly:[\s\S]*portfolioAnalysisJob\?\.source === 'review'/,
  )
})
