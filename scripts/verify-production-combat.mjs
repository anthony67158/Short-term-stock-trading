import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { buildRealOutcomeLearning } from '../shared/realOutcomeLearning.js'
import { t1StatusOf } from '../shared/portfolioAccounting.js'
import { buildHoldPayload, computePortfolio } from '../api/_portfolio.js'
import { accountCredentialHeaders } from '../shared/accountCredentials.js'
import { readAIResultStream } from '../src/aiStream.js'
import { accountTradeStateFingerprint } from '../shared/accountSync.js'
import { gunzipSync } from 'node:zlib'
import { dismissExecutionPlanInList } from '../shared/executionPlanStore.js'

assert.ok(
  process.argv.includes('--online'),
  'Pass --online to explicitly allow paid model calls and test-account writes',
)

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
)

const site = process.env.PRODUCTION_COMBAT_ORIGIN
  || 'https://stock-dashboard-one-plum.vercel.app'
const apiBase = process.env.PRODUCTION_COMBAT_API
  || 'https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run'
assert.ok(new Set([
  'stock-dashboard-one-plum.vercel.app',
  'stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run',
  '127.0.0.1',
]).has(new URL(site).hostname))
assert.equal(
  new URL(apiBase).hostname,
  'stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run',
)

const credentialsText = await fs.readFile('CREDENTIALS.md', 'utf8')
const accountSection = credentialsText
  .split('## 7. 自动化测试账号')[1]
  ?.split('\n## ')[0] || ''
const nick = accountSection.match(/账号[：:]\s*([^\n]+)/)?.[1]?.trim()
const password = accountSection.match(/密码[：:]\s*([^\n]+)/)?.[1]?.trim()
assert.equal(nick, '测试账号')
assert.ok(password)
const resumeAfter = Number(process.argv.find((arg) => arg.startsWith('--resume-after='))?.split('=')[1]) || 0
const interactionsOnly = process.argv.includes('--interactions-only')

const fixture = JSON.parse(
  await fs.readFile(
    new URL('../test/fixtures/comprehensive-test-account.json', import.meta.url),
    'utf8',
  ),
)

async function accountRequest(payload, path = '/api/account') {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true, body.error || '账号请求失败')
  return body
}

async function seedAccount(token, current) {
  const now = Date.now()
  const data = structuredClone(fixture)
  data.tradeStateResetAt = now
  data.alerts = []
  data.advice = {}
  data.adviceLog = []
  data.jobs = {}
  data.reviewJobs = {}
  data.batchProgress = null
  data.account.simulation = true
  data.realOutcomeLearning = null
  data.settings = {
    ...(data.settings || {}),
    'advAuto.enabled': false,
    'advAuto.holdEnabled': true,
    'advAuto.watchEnabled': false,
    'advAuto.holdCodes': ['000001'],
    'advAuto.watchCodes': [],
    'advAuto.configUpdatedAt': now,
    aiAutoAlert: true,
    'advReview.disabledCodes': (
      data.settings?.['advReview.disabledCodes'] || []
    ).filter((code) => code !== '000001'),
  }
  data.executionPlans = [{
    schemaVersion: 'execution-plan.v1',
    planId: `execution.production-test.${now}`,
    decisionId: `decision.production-test.${now}`,
    code: '600036',
    name: '演示标准仓',
    action: 'REDUCE',
    actionLabel: '减仓',
    side: 'SELL',
    status: 'USER_CONFIRMED',
    canArm: true,
    createdAt: now,
    updatedAt: now,
    validUntil: new Date(now + 60 * 60 * 1000).toISOString(),
    targetLots: 1,
    filledLots: 0,
    remainingLots: 1,
    referencePrice: 44,
    triggerPrice: 44,
    triggerDirection: 'GTE',
    stopPrice: 41,
    targetPrice: 46,
    trigger: '模拟成交验收计划；不代表真实触价或系统建议',
    riskAmount: 300,
    reservedCash: 0,
    expectedNetProceeds: 4390,
    executionMethod: { type: 'SINGLE_LIMIT' },
    fills: [],
    transitions: [],
  }]
  const saved = await accountRequest({
    action: 'save',
    nick,
    token,
    baseRevision: current.revision,
    baseTradeFingerprint: accountTradeStateFingerprint(current.data),
    data,
  })
  return { data, revision: saved.revision }
}

async function currentAccount(token) {
  const account = await accountRequest({ action: 'get', nick, token })
  const runtime = await accountRequest({ op: 'status', nick, token }, '/api/cron_advice')
  return { ...account, data: { ...account.data, jobs: runtime.jobs, reviewJobs: runtime.reviewJobs } }
}

async function restoreFixture(token) {
  let current
  for (let attempt = 0; attempt < 80; attempt++) {
    current = await currentAccount(token)
    try { assertNoActiveJobs(current.data); break } catch {
      await delay(5000)
    }
  }
  assertNoActiveJobs(current.data)
  const restored = structuredClone(fixture)
  restored.account.simulation = true
  restored.tradeStateResetAt = Date.now()
  restored.jobs = {}
  restored.reviewJobs = {}
  restored.batchProgress = null
  restored.settings = {
    ...(restored.settings || {}),
    'advAuto.enabled': false,
    'advAuto.holdEnabled': false,
    'advAuto.watchEnabled': false,
    'advAuto.configUpdatedAt': Date.now(),
    aiAutoAlert: false,
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await currentAccount(token)
    assertNoActiveJobs(latest.data)
    restored.executionPlans = (latest.data.executionPlans || []).reduce((plans, plan) =>
      String(plan.planId).startsWith('execution.production-test.')
        ? dismissExecutionPlanInList(plans, plan.planId) : plans,
    latest.data.executionPlans || [])
    try {
      await accountRequest({
        action: 'save', nick, token,
        baseRevision: latest.revision,
        baseTradeFingerprint: accountTradeStateFingerprint(latest.data),
        data: restored,
      })
      return
    } catch (error) {
      if (attempt === 2) throw error
      await delay(1000)
    }
  }
}

function assertNoActiveJobs(data = {}) {
  const active = [...Object.values(data.jobs || {}), ...Object.values(data.reviewJobs || {})]
    .filter((job) => ['queued', 'running'].includes(job.status))
  assert.equal(active.length, 0, '测试账号仍有在途任务，禁止覆盖账本或重复提交')
}

const output = interactionsOnly
  ? 'harness-artifacts/production-combat-interactions'
  : 'harness-artifacts/production-combat'
await fs.mkdir(output, { recursive: true })
const report = {
  schemaVersion: 'production-combat-check.v1',
  startedAt: Date.now(),
  account: '测试账号',
  fixtureProfile: fixture.fixtureProfile,
  checks: [],
  generations: [],
  limitations: ['非交易时段不伪造线上触价；模拟成交不计入真实收益学习'],
}
let browser
let login
let seeded = false
let page

try {
  login = await accountRequest({ action: 'login', nick, pw: password })
  assert.ok(login.token)
  const current = await currentAccount(login.token)
  assertNoActiveJobs(current.data)
  if (resumeAfter) assert.equal(current.data.account?.simulation, true, '只能续接已有模拟账本')
  else await seedAccount(login.token, current)
  seeded = true
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    storageState: {
      cookies: [],
      origins: [{
        origin: site,
        localStorage: [{
          name: 'cloud_session_v1',
          value: JSON.stringify({ nick, token: login.token }),
        }],
      }],
    },
  }
  const context = await browser.newContext(contextOptions)
  context.setDefaultTimeout(30_000)
  page = await context.newPage()
  const pageErrors = []
  report.accountWrites = []
  report.accountRequests = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/api/account' || request.method() !== 'POST') return
    try {
      const raw = request.postDataBuffer()
      const body = JSON.parse(request.headers()['content-encoding'] === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'))
      if (body.action === 'save') report.accountRequests.push({
        at: Date.now(), bytes: raw.length,
        hasAddedStock: body.data?.plan?.some((item) => item.code === '601318'),
        hasAddedAlert: body.data?.alerts?.some((item) => item.code === '601318'),
      })
    } catch { /* Response trace covers parseable writes */ }
  })
  page.on('response', async (response) => {
    if (!response.url().endsWith('/api/account')
      || response.request().method() !== 'POST') return
    try {
      const raw = response.request().postDataBuffer()
      const request = JSON.parse(
        response.request().headers()['content-encoding'] === 'gzip'
          ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'),
      )
      if (request.action !== 'save') return
      const result = await response.json()
      report.accountWrites.push({
        at: Date.now(), ok: result.ok, status: response.status(),
        code: result.code, error: result.error,
        hasAddedStock: request.data?.plan?.some((item) => item.code === '601318'),
        hasAddedAlert: request.data?.alerts?.some((item) => item.code === '601318'),
      })
    } catch { /* Detached page */ }
  })
  await page.goto(site, { waitUntil: 'networkidle', timeout: 90_000 })
  await page.getByRole('heading', { level: 1, name: '今日作战' }).waitFor()
  assert.match(await page.locator('.acct-btn').innerText(), /测试账号/)
  assert.equal(await page.locator('.adaptive-workbench').count(), 1)
  assert.equal(await page.locator('.aw-actions').count(), 1)
  report.checks.push('登录与作战首页')
  console.log('测试账号首页与独立浏览器会话通过')

  await page.locator('.nav-tabs:visible')
    .getByRole('button', { name: /持仓/ }).click()
  await page.locator('.plan-cand[data-code="002594"]').waitFor()
  await page.locator('.execution-queue').waitFor()
  report.checks.push('持仓、自选与执行队列')

  if (interactionsOnly) {
    const search = page.getByPlaceholder('搜索股票名称、代码或拼音…')
    await search.fill('601318')
    const match = page.locator('.ss-item').filter({ hasText: '中国平安' })
    await match.getByRole('button', { name: '加入', exact: true }).click()
    const added = page.locator('.plan-cand[data-code="601318"]')
    await added.waitFor()
    await added.locator('.pc-pin').click()
    assert.equal(await added.locator('.pc-pin').getAttribute('aria-pressed'), 'true')
    await added.locator('.card-more-actions > summary').click()
    await added.getByRole('button', {
      name: '设置手动预警',
      exact: true,
    }).click()
    await added.getByPlaceholder('价格', { exact: true }).fill('60.01')
    await added.getByRole('button', { name: '设预警', exact: true }).click()
    let saved
    for (let attempt = 0; attempt < 40; attempt++) {
      saved = (await currentAccount(login.token)).data
      if (saved.plan.some((item) => item.code === '601318' && item.star)
        && saved.alerts.some((alert) => alert.code === '601318' && alert.value === 60.01)) break
      await delay(2000)
    }
    assert.ok(saved.plan.some((item) => item.code === '601318' && item.star))
    assert.ok(saved.alerts.some((alert) => alert.code === '601318' && alert.value === 60.01))
    assert.equal(saved.account.cash, fixture.account.cash)
    report.checks.push('真实搜索中国平安、加入自选、置顶、设置到价规则及OSS回读')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
    await page.locator('.plan-cand[data-code="601318"]').waitFor()
    assert.equal(await page.locator('.plan-cand[data-code="601318"] .pc-pin').getAttribute('aria-pressed'), 'true')
    await page.getByRole('button', { name: '盯盘预警', exact: true }).click()
    const rule = page.locator('.alert-body-inline .alert-rule').filter({ hasText: '中国平安' })
    await rule.getByTitle('点击停用', { exact: true }).click()
    await rule.getByText('已停用', { exact: true }).waitFor()
    await rule.getByTitle('点击启用', { exact: true }).click()
    await rule.getByTitle('删除规则', { exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await rule.waitFor({ state: 'detached' })
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
    const addedAfterRefresh = page.locator(
      '.plan-cand[data-code="601318"]',
    )
    await addedAfterRefresh.locator(
      '.card-more-actions > summary',
    ).click()
    await addedAfterRefresh.getByRole('button', {
      name: '删除自选',
      exact: true,
    }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
    await page.locator('.plan-cand[data-code="601318"]').waitFor({ state: 'detached' })
    for (let attempt = 0; attempt < 40; attempt++) {
      saved = (await currentAccount(login.token)).data
      if (!saved.plan.some((item) => item.code === '601318')
        && !saved.alerts.some((item) => item.code === '601318')) break
      await delay(2000)
    }
    report.remainingTestAlerts = saved.alerts.filter((item) => item.code === '601318')
      .map(({ id, code, enabled, phase, createdAt, triggeredAt }) => ({ id, code, enabled, phase, createdAt, triggeredAt }))
    assert.equal(saved.plan.some((item) => item.code === '601318'), false, '删除自选尚未保存')
    assert.equal(saved.alerts.some((item) => item.code === '601318'), false, '删除预警尚未保存')
    assert.equal(saved.account.cash, fixture.account.cash)
    report.checks.push('刷新恢复置顶与预警、停用启用、删除规则与自选确认')
    await page.screenshot({ path: `${output}/interactions-complete.png`, fullPage: true })
  } else {
  for (const [code, profile, label, cardSelector] of [
    ['000001', 'quick', '持仓V3评估', '.hold-item'],
    ['688981', 'quick', '自选V3评估', '.plan-cand'],
  ]) {
    const before = await currentAccount(login.token)
    assertNoActiveJobs(before.data)
    const previousJob = before.data.jobs?.[code]
    const reusable = resumeAfter > 0 && previousJob?.status === 'done'
      && previousJob.at >= resumeAfter
      && Boolean(previousJob.deepMode) === (profile === 'deep')
      && before.data.advice?.[code]?.at >= previousJob.at
    const startedAt = reusable ? previousJob.at : Date.now()
    const card = page.locator(
      `${cardSelector}[data-code="${code}"]`,
    )
    if (code === '688981' && !reusable) {
      await card.getByRole('button', {
        name: '纳入作战',
        exact: true,
      }).click()
      await page.getByRole('dialog', {
        name: '纳入作战并持续跟踪？',
      }).getByRole('button', {
        name: '纳入作战',
        exact: true,
      }).click()
      await card.locator('.stock-name-link').first().click()
    } else {
      await card.locator('.stock-name-link').first().click()
      if (!reusable) {
        await page.locator(
          `.detail-footbar .footbar-${profile}`,
        ).click()
      }
    }
    await page.locator(
      `.detail-footbar .footbar-${profile}`,
    ).waitFor()
    console.log(`${code} ${label} ${reusable ? '续验已完成任务' : '已点击，等待任务终态'}`)
    const phases = []
    let saved = reusable ? before.data.advice[code] : null
    let jobId = reusable ? previousJob.id : null
    let finalJob = reusable ? previousJob : null
    let finalData = reusable ? before.data : null
    while (!saved && Date.now() - startedAt < 420_000) {
      const cloud = await currentAccount(login.token)
      const job = cloud.data?.jobs?.[code]
      const flow = page.locator('.advice-generation-flow')
      if (await flow.count()) {
        const phase = (await flow.innerText()).replace(/\s+/g, ' ').trim().slice(0, 500)
        if (phase && phases.at(-1) !== phase) phases.push(phase)
      }
      if (job && job.id !== before.data?.jobs?.[code]?.id) {
        if (jobId) assert.equal(job.id, jobId, '同一次点击不能更换任务重跑')
        jobId = job.id
        if (['failed', 'canceled'].includes(job.status)) {
          throw new Error(`${code} ${label}: ${job.error || job.phase || job.status}`)
        }
        if (job.status === 'done' && cloud.data.advice?.[code]?.at > startedAt) {
          saved = cloud.data.advice[code]
          finalJob = job
          finalData = cloud.data
          break
        }
      }
      await delay(4000)
    }
    assert.ok(saved, `${code} 未出现新版本已持久化结果`)
    assert.equal(finalJob?.attempts, 1, '单次生成只能领取一次任务租约')
    assert.equal(saved.advice.decisionPlan?.schemaVersion, 'decision-plan.v2')
    assert.equal(saved.advice.priceContract?.schemaVersion, 'advice-price-contract.v1')
    assert.equal(saved.advice.decisionSource.engine, 'V3')
    assert.equal(saved.meta.llmCalls, 0)
    assert.equal(saved.generationMetrics.mainLlmCalls, 0)
    const monitoring = saved.advice.monitoringPlan
    if (code === '000001' && saved.advice.decisionPlan.action === 'HOLD') {
      assert.equal(monitoring?.schemaVersion, 'monitoring-plan.v2')
      assert.equal(monitoring.state, 'READY')
      assert.ok(monitoring.rules.length > 0 && monitoring.rules.length <= 3)
      assert.ok(
        monitoring.rules.some((rule) =>
          ['EXIT', 'REDUCE'].includes(rule.action)
        ),
        '持有计划必须至少包含一条可执行退出规则',
      )
      const expectedTracked = monitoring.rules.filter(
        (rule) => rule.action !== 'HOLD',
      ).length
      let tracked = []
      for (let attempt = 0; attempt < 30; attempt++) {
        finalData = (await currentAccount(login.token)).data
        tracked = (finalData.alerts || []).filter((alert) =>
          alert.type === 'plan-condition'
          && alert.monitoringPlanId === monitoring.planId
        )
        if (tracked.length === expectedTracked) break
        await delay(2000)
      }
      assert.equal(
        tracked.length,
        expectedTracked,
        '可执行监控规则必须全部投影为云端条件提醒',
      )
    }
    const complete = /V3 决策已保存/
    await page.locator('.detail-panel').getByText(complete).first().waitFor({ timeout: 45_000 })
    await page.screenshot({ path: `${output}/${code}-v3-complete.png`, fullPage: true })
    report.generations.push({
      code, profile, jobId,
      attempts: finalJob?.attempts,
      durationMs: (finalJob?.finishedAt || saved.at) - (finalJob?.startedAt || startedAt),
      resumedVerification: reusable, phases,
      savedAt: saved.at, decisionId: saved.advice.decisionPlan.decisionId,
      action: saved.advice.decisionPlan.action,
      actionability: saved.advice.decisionPlan.actionability,
      quantity: saved.advice.decisionPlan.quantity,
      blockedReasons: saved.advice.decisionPlan.blockedReasons,
      decisionSource: saved.advice.decisionSource,
      llmCalls: saved.meta.llmCalls,
      monitoringPlan: monitoring
        ? {
            schemaVersion: monitoring.schemaVersion,
            planId: monitoring.planId,
            state: monitoring.state,
            ruleCount: monitoring.rules.length,
          }
        : null,
      complete: true,
    })
    await fs.writeFile(`${output}/${code}-v3-result.json`, JSON.stringify(saved, null, 2))
    console.log(`${code} ${label}及OSS保存通过`)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
    if (monitoring) {
      const holdingCard = page.locator(
        `.hold-item[data-code="${code}"]`,
      )
      await holdingCard.locator('.v3-decision-summary').waitFor()
      assert.doesNotMatch(
        await holdingCard.innerText(),
        /51\.88|59\.5/,
      )
    }
    await page.locator(
      `${cardSelector}[data-code="${code}"] .stock-name-link`,
    ).first().click()
    await page.locator('.detail-panel').getByText(complete).first().waitFor({ timeout: 45_000 })
    const reloaded = (await currentAccount(login.token)).data.advice[code]
    assert.equal(reloaded.advice.decisionPlan.decisionId, saved.advice.decisionPlan.decisionId)
    await page.getByRole('button', { name: '关闭个股详情', exact: true }).click()
    report.checks.push(`${code}${label}、同任务终态、OSS保存及刷新恢复`)
  }

  const quoteResponse = await fetch(`${apiBase}/api/quote?codes=000001,600036,002594,688981,300750`, {
    signal: AbortSignal.timeout(30_000),
  })
  const quoteBody = await quoteResponse.json()
  assert.ok(quoteBody.list?.length >= 4, '真实股票报价缺失')
  const quoteMap = Object.fromEntries(quoteBody.list.map((quote) => [quote.code, quote]))
  await fs.writeFile(`${output}/quote-snapshot.json`, JSON.stringify(quoteBody, null, 2))
  const beforeTrades = (await currentAccount(login.token)).data
  const portfolio = computePortfolio(beforeTrades.holding, quoteMap, beforeTrades.account)
  const reviewStartedAt = Date.now()
  let review = null
  if (resumeAfter) {
    const previous = JSON.parse(await fs.readFile(`${output}/review-result.json`, 'utf8').catch(() => 'null'))
    if (previous?.ok && previous.updatedAt >= resumeAfter) review = previous
  }
  const reusedReview = Boolean(review)
  if (!review) {
  const reviewSignal = AbortSignal.timeout(90_000)
  const reviewResponse = await fetch(`${apiBase}/api/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...accountCredentialHeaders({ nick, token: login.token }) },
    body: JSON.stringify({
      mode: 'review', stream: true, fastMode: true, budgetMs: 55_000,
      payload: buildHoldPayload(
        beforeTrades.holding, '000001', '平安银行',
        portfolio, beforeTrades.account, beforeTrades.closed, null, quoteMap['000001'],
      ),
    }),
    signal: reviewSignal,
  })
  assert.equal(reviewResponse.status, 200)
  review = await readAIResultStream(reviewResponse.body, { signal: reviewSignal })
  }
  const previousReport = JSON.parse(await fs.readFile(`${output}/report.json`, 'utf8').catch(() => 'null'))
  report.review = {
    ok: review.ok, mode: review.mode, model: review.model, resumedVerification: reusedReview,
    durationMs: reusedReview ? previousReport?.review?.durationMs : Date.now() - reviewStartedAt,
  }
  await fs.writeFile(`${output}/review-result.json`, JSON.stringify(review, null, 2))
  assert.equal(review.ok, true, review.error)
  assert.equal(review.result.decisionPlan?.schemaVersion, 'decision-plan.v2')
  assert.equal(review.result.decisionSource.engine, 'V3')
  assert.equal(review.meta.llmCalls, 0)
  report.checks.push('平安银行真实行情与V3复核，零LLM调用')
  console.log('000001 V3复核与决策合同通过')

  const alreadySold = beforeTrades.closed.some((fill) => fill.code === '600036' && fill.at >= (resumeAfter || report.startedAt))
  if (!alreadySold) {
  const queue = page.locator('.execution-queue-row.confirmed')
    .filter({ hasText: '演示标准仓' })
  await queue.getByLabel('演示标准仓成交价').fill(String(quoteMap['600036'].price))
  await queue.getByLabel('演示标准仓成交手数').fill('1')
  await queue.getByRole('button', { name: /记录成交/ }).click()
  await page.waitForTimeout(1_500)
  await page.locator('.execution-queue-row.completed').filter({ hasText: '演示标准仓' }).first().waitFor()
  }
  const holdingText = await page.locator(
    '.hold-item[data-code="600036"]',
  ).innerText()
  assert.match(holdingText, /持仓\s*4\s*手/)
  report.checks.push('已确认模拟计划记录减仓')

  const candidate = page.locator('.plan-cand[data-code="002594"]')
  await candidate.locator('.card-more-actions > summary').click()
  await candidate.getByRole('button', {
    name: '记录自主成交',
    exact: true,
  }).click()
  const trackingOption = candidate.getByRole('checkbox', {
    name: '将这笔持仓加入系统持续管理',
  })
  assert.equal(await trackingOption.isChecked(), true)
  await trackingOption.uncheck()
  await candidate.getByPlaceholder('买入价').fill(String(quoteMap['002594'].price))
  await candidate.getByPlaceholder('手').fill('1')
  await candidate.locator('.buy-inline .act-buy.solid').click()
  await page.locator('.hold-item[data-code="002594"]').waitFor()
  report.checks.push('模拟买入、持续管理显式选择与持仓接续')

  await page.locator('.nav-tabs:visible')
    .getByRole('button', { name: /复盘/ }).click()
  await page.getByText('演示标准仓', { exact: false }).first().waitFor()
  report.checks.push('成交进入复盘')

  let settled
  for (let attempt = 0; attempt < 15; attempt++) {
    const data = (await currentAccount(login.token)).data
    if (data.holding?.some((item) => item.code === '002594')
      && data.executionPlans?.some((plan) => plan.status === 'COMPLETED')) {
      settled = data
      break
    }
    await delay(3000)
  }
  assert.ok(settled, '模拟成交未完整保存到OSS')
  const fills = settled.closed.filter((item) => item.at >= (resumeAfter || report.startedAt))
  assert.equal(fills.length, 2, '应恰好一买一卖，不得漏记或重复')
  const expectedCash = fixture.account.cash + fills.reduce((sum, fill) => sum + fill.cashFlow, 0)
  assert.ok(Math.abs(settled.account.cash - expectedCash) < 0.02, '现金变化必须等于真实费用后的成交现金流')
  const t1 = t1StatusOf(settled.holding, settled.closed, '002594')
  assert.equal(t1.boughtToday, 1)
  assert.equal(t1.sellableToday, 0)
  const learning = buildRealOutcomeLearning(settled)
  assert.equal(learning.overall.samples, 0)
  assert.ok(learning.excluded.simulatedExecutions >= 2)
  report.tradeFlow = {
    fills: fills.map(({ id, code, type, qty, price, fee, cashFlow }) => ({ id, code, type, qty, price, fee, cashFlow })),
    cashBefore: fixture.account.cash, cashAfter: settled.account.cash,
    boughtToday: t1.boughtToday, sellableToday: t1.sellableToday,
    simulatedExcluded: learning.excluded.simulatedExecutions,
  }
  report.checks.push('成交ID、费后现金、T+1与模拟收益隔离回读')

  const secondContext = await browser.newContext(contextOptions)
  const second = await secondContext.newPage()
  second.on('pageerror', (error) => pageErrors.push(error.message))
  await second.goto(site, { waitUntil: 'networkidle', timeout: 90_000 })
  await second.locator('.nav-tabs:visible')
    .getByRole('button', { name: /持仓/ }).click()
  await second.locator('.hold-item[data-code="002594"]').waitFor()
  assert.match(
    await second.locator('.hold-item[data-code="600036"]').innerText(),
    /持仓\s*4\s*手/,
  )
  report.checks.push('独立浏览器存储上下文读取相同成交状态')
  await secondContext.close()
  }
  assert.deepEqual(pageErrors, [])
  await context.close()
  report.completedAt = Date.now()
  report.passed = true
} catch (error) {
  report.completedAt = Date.now()
  report.passed = false
  report.error = String(error?.message || error).slice(0, 1000)
  report.visibleFailure = (await page?.locator('body').innerText().catch(() => '') || '').slice(-2500)
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  if (seeded) {
    try {
      await restoreFixture(login.token)
      report.cleanup = 'restored-simulation-fixture'
    } catch (error) {
      report.cleanup = 'failed'
      report.cleanupError = String(error?.message || error).slice(0, 300)
      report.passed = false
      process.exitCode = 1
    }
  }
  await fs.writeFile(
    `${output}/report.json`,
    JSON.stringify(report, null, 2),
  )
}

console.log(JSON.stringify(report, null, 2))
