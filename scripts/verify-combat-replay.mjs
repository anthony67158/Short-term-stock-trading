import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { activatePriceReviewTrigger } from '../api/_advice_wakeup.js'
import { completeJob, leaseJob } from '../api/_jobs.js'
import { terminalReviewNotification, waitForTriggeredReviewMonitoring } from '../api/cron_advice.js'
import { projectAdviceAlerts } from '../shared/adviceAlerts.js'
import { applyCompiledDecisionPlan, compileDecisionPlan } from '../shared/decisionPlan.js'
import { compileExecutionPlan, refreshExecutionPlan, transitionExecutionPlan } from '../shared/executionPlan.js'
import { normalizeTriggeredReviewDecision, enforceTriggeredReviewDecisionPlan } from '../shared/triggeredReviewDecision.js'
import { buildShortHorizonTactical, deriveShortHorizonActionPolicy } from '../shared/shortHorizonTactical.js'
import { t1StatusOf } from '../shared/portfolioAccounting.js'
import { buildRealOutcomeLearning } from '../shared/realOutcomeLearning.js'
import { adviceCompleteness } from '../shared/adviceBatchPolicy.js'

const base = process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.equal(new URL(base).hostname, '127.0.0.1')
const output = 'harness-artifacts/combat-replay'
await fs.mkdir(output, { recursive: true })
const snapshot = JSON.parse(await fs.readFile('harness-artifacts/production-combat/quote-snapshot.json', 'utf8'))
const stock = snapshot.list.find((quote) => quote.code === '002594')
assert.ok(stock?.price > 0)
const p = Number(stock.price)
const price = (factor) => +(p * factor).toFixed(2)
const start = Date.parse('2026-09-08T02:10:00Z')
const stop = price(0.974)
const target = price(1.07)
const code = stock.code
const name = stock.name || '比亚迪'
let now = start
const quote = (value) => ({
  ...stock, code, name, price: value, open: price(0.99),
  low: price(0.992), high: price(1.05), pct: 0.4,
  amount: 200000000, volRatio: 1.3, turnover: 3,
  tradeDate: '2026-09-08', asOf: new Date(now).toISOString(),
  live: true, isLivePrice: true, priceStatus: 'LIVE',
  limitDownPrice: price(0.9), limitUpPrice: price(1.1),
})
const payload = {
  code, name,
  todayQuote: quote(price(1.033)),
  tech: { support: price(0.998), resistance: target, atr: price(0.026), ma: { ma5: price(1.007) } },
  marketEnv: { schemaVersion: 'market-regime.v1', regime: 'TREND_STRONG', dataQuality: 'COMPLETE', allowRiskIncrease: true, score: 72, riskMultiplier: 1, targetPositionPct: { min: 30, max: 60 } },
  sectorOpportunity: { matched: true, sector: { name: '模拟汽车场景', actionability: '可买' }, stock: { roleLabel: '前排', score: 66 } },
  stockFund: { source: 'local-simulation', mainNetYi: 0.35, retailNetYi: -0.2 },
  account: { cash: 250000, totalAssets: 250000, position: 0, stockWeight: 0 },
  quant: { score: 62, forecast: { direction: '看涨', upProb: 58, expRet: 1.8 }, highConfSignal: {
    fired: true, credibility: 65, buyPrice: p, stopLoss: stop, takeProfit: target,
    probabilityKind: 'TP_BEFORE_SL', simulation: true,
  } },
}
const evidence = () => ({
  schemaVersion: 'canonical-evidence.v1', snapshotId: 'local-replay-evidence',
  asOf: new Date(now).toISOString(),
  marketTime: { isLive: true, phase: '上午盘中', evidenceState: 'LIVE', dataDayLabel: '2026-09-08' },
  freshness: { status: 'LIVE', missingSources: [], missingRequiredSources: [] },
})
function finalize(advice, triggered = false) {
  const tactical = buildShortHorizonTactical(payload, { now })
  payload.shortHorizonTactical = { ...tactical, actionPolicy: deriveShortHorizonActionPolicy({ mode: 'buy_advice', tactical, reviewEvent: payload.reviewEvent }) }
  let result = triggered ? normalizeTriggeredReviewDecision({ mode: 'buy_advice', result: advice, payload, now }) : advice
  result = {
    ...result,
    title: result.title || '本地复核场景',
    quantNote: '本地模型替身，概率不代表真实预测',
    fundNote: '本地资金场景：主力0.35亿元，小单-0.2亿元',
    invalidation: result.invalidation || `跌破${stop}元退出本计划`,
  }
  result.decisionPlan = compileDecisionPlan({ mode: 'buy_advice', advice: result, payload, evidenceSnapshot: evidence(), now })
  if (triggered) {
    const enforced = enforceTriggeredReviewDecisionPlan({ mode: 'buy_advice', result })
    result = enforced.result
    if (enforced.changed) result.decisionPlan = compileDecisionPlan({ mode: 'buy_advice', advice: result, payload, evidenceSnapshot: evidence(), now })
  }
  result = applyCompiledDecisionPlan(result)
  result.priceContract = result.decisionPlan.priceContract
  result.continuity = { planId: 'local-replay-plan', revision: triggered ? 2 : 1 }
  assert.equal(adviceCompleteness(result, 'buy_advice').complete, true)
  return result
}
const initial = finalize({
  action: '观望', title: '本地路径模拟', actionPlan: `回踩${price(0.998)}元后核验`,
  pullbackWatchPrice: price(0.998), stopPrice: stop, targetPrice: target,
  nextOpenPlan: `次日跌破${stop}元退出`, futurePlan: '第五个交易日退出',
  invalidation: `跌破${stop}元取消`, positionNote: '仓位不超过5%，人工确认',
})
let book = {
  account: { ...payload.account, simulation: true },
  plan: [{ id: 'local-candidate', code, name }],
  holding: [], closed: [], decisionLog: [], executionPlans: [],
  advice: { [code]: { mode: 'buy_advice', at: now, cachedAt: now, advice: initial } },
  settings: { 'advAuto.enabled': false, aiAutoAlert: true, 'advReview.disabledCodes': [] },
  alerts: [],
}
projectAdviceAlerts(book, code, initial, { now, requirePriceContract: true })
assert.ok(book.alerts.some((alert) => alert.reviewOnly), '真实价格合同未产生观察预警')
let quotes = { [code]: quote(price(1.033)) }
let modelCalls = 0
let triggerRequests = 0
let observedMs = 0
let notification
let final
const state = () => ({ book, quotes, now, modelCalls, observedMs, notification })

async function settle() {
  assert.equal(modelCalls, 0, '同计划不得二次模型调用')
  const job = book.reviewJobs?.[code]
  assert.ok(job?.trigger, '前台触价没有进入后端队列')
  leaseJob(book, code, now, 'review')
  await waitForTriggeredReviewMonitoring(job.trigger, {
    now: () => now,
    sleep: async (ms) => { observedMs += ms; now += ms },
  })
  assert.equal(observedMs, 60000)
  modelCalls++
  payload.todayQuote = quote(p)
  payload.previousAdvice = initial
  payload.reviewEvent = job.trigger
  final = finalize({
    reviewDecision: { outcome: '立即买入', operation: '买入', quantity: 1, priceLow: p, priceHigh: p,
      basis: [{ type: '本地场景', summary: '模拟回踩恢复与资金承接，仅验证决策链' }] },
    stopPrice: stop, targetPrice: target,
    nextOpenPlan: `次日跌破${stop}元退出`, futurePlan: '第五个交易日退出',
    reason: '模拟承接确认，核验服务端数量与费后风险',
  }, true)
  assert.equal(final.decisionPlan.actionability, 'READY', JSON.stringify(final.decisionPlan.blockedReasons))
  book.advice[code] = { mode: 'buy_advice', at: now, cachedAt: now, advice: final }
  projectAdviceAlerts(book, code, final, { now, requirePriceContract: true })
  const execution = compileExecutionPlan({ decisionPlan: final.decisionPlan, code, name, now })
  book.executionPlans = [refreshExecutionPlan(transitionExecutionPlan(execution, 'ARM', { now }), { price: p, now })]
  completeJob(book, code, now, { role: 'review' })
  await fs.writeFile(`${output}/persisted-terminal.json`, JSON.stringify(book, null, 2))
  notification = terminalReviewNotification({ code, name, advice: final, jobId: job.id })
  notification.alertId = notification.eventId
  return state()
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const report = {
  kind: 'local-synthetic-price-path', realSnapshot: { code, name, price: p, tradeDate: stock.tradeDate },
  model: 'deterministic-test-double', checks: [],
}
let page
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(30000)
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base) return route.abort()
    if (!url.pathname.startsWith('/__test/')) return route.continue()
    const action = url.pathname.split('/').at(-1)
    const body = route.request().postDataJSON()
    let result
    try {
    if (action === 'save') {
      book = { ...book, ...body.book }
      result = { ok: true }
    } else if (action === 'trigger') {
      triggerRequests++
      result = activatePriceReviewTrigger(book, body, now)
      assert.equal(result.ok, true, result.reason)
    } else if (action === 'touch') {
      quotes = { [code]: quote(price(0.995)) }
      result = state()
    } else if (action === 'settle') result = await settle()
    else result = state()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
    } catch (error) {
      errors.push(String(error?.message || error))
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Replay invariant failed' }) })
    }
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.install({ time: new Date(start) })
  await page.goto(`${base}/test/ui/combat-replay-preview.html`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '回放价格命中', exact: true }).click()
  await page.locator('.alert-banner').waitFor()
  assert.equal(triggerRequests, 1, '同轮重复报价不能重复提交')
  assert.equal(modelCalls, 0, '观察期间不能调用模型')
  report.checks.push('浏览器触价、在途去重、观察期间零模型调用')
  await page.screenshot({ path: `${output}/watching.png`, fullPage: true })
  await page.getByRole('button', { name: '关闭当前预警横幅', exact: true }).click()
  await page.getByRole('button', { name: '完成观察与复核', exact: true }).click()
  await page.locator('.alert-banner').getByText(/立即买入1手/).waitFor()
  assert.equal(modelCalls, 1)
  assert.equal(book.alerts.filter((alert) => alert.enabled).length, 0)
  await page.getByRole('button', { name: '重放终态通知', exact: true }).click()
  const notifications = JSON.parse(await page.getByTestId('replay-state').innerText())
  assert.equal(notifications.notifications, 2)
  assert.equal(notifications.banners, 1)
  report.checks.push('60秒观察、唯一终局、保存后通知与重复通知去重')
  await page.screenshot({ path: `${output}/terminal.png`, fullPage: true })
  await page.getByRole('button', { name: '关闭当前预警横幅', exact: true }).click()
  await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
  const queue = page.locator('.execution-queue-row')
  await queue.getByRole('button', { name: /确认准备/ }).click()
  await queue.getByRole('button', { name: /记录成交/ }).click()
  await queue.getByText('已完成', { exact: true }).waitFor()
  await page.getByRole('button', { name: '重放终态通知', exact: true }).click()
  assert.equal(book.closed.length, 1)
  assert.equal(book.closed[0].code, code)
  assert.equal(t1StatusOf(book.holding, book.closed, code, start).sellableToday, 0)
  assert.ok(Math.abs(book.account.cash - (250000 + book.closed[0].cashFlow)) < 0.02)
  assert.equal(buildRealOutcomeLearning(book).overall.samples, 0)
  report.checks.push('人工确认、真实成交记录函数、费后现金与T+1、模拟学习隔离')
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
  await page.locator(`.hold-item[data-code="${code}"]`).waitFor()
  await page.locator('.execution-queue-row').getByText('已完成', { exact: true }).waitFor()
  await page.getByRole('button', { name: `移除${name}手动操作计划`, exact: true }).click()
  await page.getByRole('button', { name: '重放终态通知', exact: true }).click()
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
  assert.equal(await page.locator('.execution-queue-row').count(), 0)
  assert.equal(book.closed.length, 1)
  report.checks.push('完成计划移除后刷新不重现，成交记录不删除')
  await page.locator('.nav-tabs:visible').getByRole('button', { name: /复盘/ }).click()
  await page.getByText(name, { exact: true }).first().waitFor()
  report.checks.push('刷新恢复、完成计划不重启、成交进入复盘')
  assert.deepEqual(errors, [])
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = String(error?.message || error)
  report.pageErrors = errors
  report.visibleText = (await page?.locator('body').innerText().catch(() => '') || '').slice(0, 1500)
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
  await fs.writeFile(`${output}/report.json`, JSON.stringify({ ...report, modelCalls, observedMs, triggerRequests }, null, 2))
}
console.log(JSON.stringify(report, null, 2))
