import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  accountCredentialHeaders,
} from '../shared/accountCredentials.js'
import { accountTradeStateFingerprint } from '../shared/accountSync.js'
import { buildAlertNotification } from '../shared/alertNotification.js'
import { monitoringAlerts } from '../shared/monitoringPlan.js'

assert.ok(
  process.argv.includes('--online'),
  'Pass --online to allow test-account writes',
)

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
)
const historyOnly = process.argv.includes('--history-only')
const site = process.env.PRODUCTION_MONITORING_ORIGIN
  || 'https://stock-dashboard-one-plum.vercel.app'
const apiBase = process.env.PRODUCTION_MONITORING_API
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

const fixture = JSON.parse(
  await fs.readFile(
    new URL(
      '../test/fixtures/comprehensive-test-account.json',
      import.meta.url,
    ),
    'utf8',
  ),
)
const report = {
  schemaVersion: 'production-monitoring-check.v1',
  startedAt: Date.now(),
  account: nick,
}
let token = ''
let seeded = false
let browser
await fs.mkdir(
  'harness-artifacts/production-monitoring',
  { recursive: true },
)

async function post(path, payload) {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token
        ? accountCredentialHeaders({ nick, token })
        : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true, body.error || 'production request failed')
  return body
}

async function currentAccount() {
  return post('/api/account', {
    action: 'get',
    nick,
    token,
  })
}

async function saveAccount(current, data) {
  return post('/api/account', {
    action: 'save',
    nick,
    token,
    baseRevision: current.revision,
    baseTradeFingerprint:
      accountTradeStateFingerprint(current.data),
    data,
  })
}

function assertNoActiveJobs(data = {}) {
  const active = [
    ...Object.values(data.jobs || {}),
    ...Object.values(data.reviewJobs || {}),
  ].filter((job) =>
    ['queued', 'running'].includes(job?.status)
  )
  assert.equal(
    active.length,
    0,
    '测试账号仍有在途任务，禁止覆盖账本',
  )
}

async function restoreFixture() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await currentAccount()
    assertNoActiveJobs(current.data)
    const restored = structuredClone(fixture)
    restored.account.simulation = true
    restored.tradeStateResetAt = Date.now()
    restored.jobs = {}
    restored.reviewJobs = {}
    restored.batchProgress = null
    try {
      await saveAccount(current, restored)
      return
    } catch (error) {
      if (attempt === 3) throw error
      await delay(1000)
    }
  }
}

try {
  const login = await post('/api/account', {
    action: 'login',
    nick,
    pw: password,
  })
  token = login.token
  assert.ok(token)
  const current = await currentAccount()
  assertNoActiveJobs(current.data)

  const quoteResponse = await fetch(
    `${apiBase}/api/quote?code=000001`,
    { signal: AbortSignal.timeout(30_000) },
  )
  const quoteBody = await quoteResponse.json()
  const quote = quoteBody.list?.[0]
  assert.equal(quote?.code, '000001')
  if (!historyOnly) {
    assert.equal(quote?.isLivePrice, true)
  }
  const price = Number(quote.price)
  assert.ok(price > 0)

  const now = Date.now()
  const validUntil = new Date(
    now + 60 * 60 * 1000,
  ).toISOString()
  const threshold = Math.max(
    0.001,
    Number((price * 0.95).toFixed(3)),
  )
  const advice = {
    name: '平安银行',
    action: '持有',
    title: '测试账号盘中条件跟踪',
    actionPlan:
      `真实报价达到${threshold}元时提醒减仓1手`,
    invalidation: '本轮验收结束后恢复固定测试夹具',
    quantNote: '本轮仅验证真实报价触发，不用于投资决策',
    fundNote: '本轮不依据资金生成交易结论',
    nextOpenPlan: '测试结束后不保留本计划',
    futurePlan: '测试结束后不保留本计划',
    decisionPlan: {
      schemaVersion: 'decision-plan.v2',
      decisionId: `decision.monitoring-test.${now}`,
      mode: 'hold_advice',
      action: 'HOLD',
      actionability: 'HOLD',
      quantity: { lots: 0 },
      validUntil,
    },
    monitoringPlan: {
      schemaVersion: 'monitoring-plan.v1',
      planId: `decision.monitoring-test.${now}`,
      code: '000001',
      createdAt: now,
      validUntil,
      state: 'READY',
      errors: [],
      rules: [{
        id: 'real-quote-trigger',
        action: 'REDUCE',
        kind: 'PROFIT_EXIT',
        priority: 1,
        lots: 1,
        logic: 'ANY',
        session: 'CONTINUOUS',
        sustainSeconds: 0,
        conditions: [{
          metric: 'price',
          op: 'gte',
          value: threshold,
        }],
      }],
    },
  }
  const seededData = structuredClone(fixture)
  seededData.account.simulation = true
  seededData.tradeStateResetAt = now
  seededData.jobs = {}
  seededData.reviewJobs = {}
  seededData.batchProgress = null
  seededData.advice = {
    ...(seededData.advice || {}),
    '000001': {
      mode: 'hold_advice',
      at: now,
      cachedAt: now,
      advice,
    },
  }
  seededData.settings = {
    ...(seededData.settings || {}),
    aiAutoAlert: true,
    'advAuto.enabled': false,
    'advAuto.holdEnabled': false,
    'advAuto.watchEnabled': false,
    'advAuto.configUpdatedAt': now,
    'advReview.disabledCodes': (
      seededData.settings?.['advReview.disabledCodes'] || []
    ).filter((code) => code !== '000001'),
  }
  seededData.alerts = monitoringAlerts(
    seededData,
    '000001',
    advice,
    now,
  )
  assert.equal(seededData.alerts.length, 1)
  if (historyOnly) {
    Object.assign(seededData.alerts[0], {
      enabled: false,
      phase: 'triggered',
      triggeredAt: now,
      triggeredMsg:
        `股价≥${threshold}元（当前${price}元）`,
      decisionPrice: price,
      decisionLots: 1,
      ruleState: {
        state: 'MATCHED',
        matched: true,
        matchedSince: now,
        checkedAt: now,
      },
    })
  }
  await saveAccount(current, seededData)
  seeded = true
  const seededAccount = await currentAccount()
  const armed = seededAccount.data.alerts.find(
    (item) => item.monitoringPlanId
      === advice.monitoringPlan.planId,
  )
  assert.equal(
    armed?.enabled,
    historyOnly ? false : true,
  )
  assert.equal(
    seededAccount.data.advice?.['000001']
      ?.advice?.monitoringPlan?.planId,
    advice.monitoringPlan.planId,
  )
  assert.equal(
    seededAccount.data.settings?.aiAutoAlert,
    true,
  )
  assert.equal(
    (
      seededAccount.data.settings?.[
        'advReview.disabledCodes'
      ] || []
    ).includes('000001'),
    false,
  )

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    storageState: {
      cookies: [],
      origins: [{
        origin: site,
        localStorage: [{
          name: 'cloud_session_v1',
          value: JSON.stringify({ nick, token }),
        }],
      }],
    },
  })
  const pageErrors = []
  const trackingResponses = []
  const page = await context.newPage()
  page.on('pageerror', (error) =>
    pageErrors.push(error.message)
  )
  page.on('response', async (response) => {
    if (
      !response.url().endsWith('/api/cron_advice')
      || response.request().method() !== 'POST'
    ) return
    try {
      const request = response.request().postDataJSON()
      if (request?.op !== 'trackConditions') return
      trackingResponses.push(await response.json())
    } catch { /* Ignore detached response bodies. */ }
  })
  await page.goto(site, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  })
  const banner = page.locator('.alert-banner')
  await page.getByRole('heading', {
    level: 1,
    name: '今日作战',
  }).waitFor()
  assert.match(
    await page.locator('.acct-btn').innerText(),
    /测试账号/,
  )
  if (historyOnly) {
    await page.waitForTimeout(6000)
    assert.equal(
      await banner.count(),
      0,
      '历史云端事件不应重新弹横幅',
    )
    await page.screenshot({
      path:
        'harness-artifacts/production-monitoring/'
        + 'history-without-banner.png',
      fullPage: true,
    })
    await page.locator('.nav-tabs:visible')
      .getByRole('button', { name: /持仓/ })
      .click()
    const monitoring = page.locator(
      '.hold-item[data-code="000001"] '
        + '.monitoring-rules',
    )
    await monitoring.waitFor()
    const cardStyle = await monitoring.evaluate(
      (element) => {
        const style = getComputedStyle(element)
        const rule = element.querySelector(
          '.monitoring-rule',
        )
        const ruleStyle = rule
          ? getComputedStyle(rule)
          : null
        return {
          borderTop: style.borderTopWidth,
          borderRadius: style.borderRadius,
          background: style.backgroundColor,
          ruleBorderTop: ruleStyle?.borderTopWidth,
          ruleCount: element.querySelectorAll(
            '.monitoring-rule',
          ).length,
        }
      },
    )
    assert.deepEqual(cardStyle, {
      borderTop: '0px',
      borderRadius: '0px',
      background: 'rgba(0, 0, 0, 0)',
      ruleBorderTop: '0px',
      ruleCount: 1,
    })
    await page.locator(
      '.hold-item[data-code="000001"]',
    ).screenshot({
      path:
        'harness-artifacts/production-monitoring/'
        + 'production-monitoring-card.png',
    })
    report.monitoringCard = cardStyle
  } else {
    await banner.getByText(
      '平安银行｜减仓1手',
      { exact: true },
    ).waitFor({ timeout: 45_000 })
    assert.match(
      await banner.innerText(),
      /人工确认后执行/,
    )
    await page.screenshot({
      path:
        'harness-artifacts/production-monitoring/'
        + 'triggered-banner.png',
      fullPage: true,
    })
    await banner.waitFor({
      state: 'hidden',
      timeout: 10_000,
    })
    for (
      let attempt = 0;
      attempt < 10 && !trackingResponses.length;
      attempt++
    ) {
      await delay(250)
    }
    assert.equal(trackingResponses[0]?.triggered, 1)
  }

  const persisted = await currentAccount()
  const alert = persisted.data.alerts.find(
    (item) =>
      item.monitoringPlanId
        === advice.monitoringPlan.planId,
  )
  assert.equal(alert?.phase, 'triggered')
  assert.equal(alert?.enabled, false)
  assert.equal(alert?.opQty, '减仓1手')
  assert.ok(Number(alert.triggeredAt) >= now)
  assert.ok(
    Math.abs(Number(alert.decisionPrice) - price) < 0.2,
  )
  assert.equal(
    persisted.data.holding.find(
      (item) => item.code === '000001',
    )?.qty,
    fixture.holding.find(
      (item) => item.code === '000001',
    )?.qty,
  )
  assert.equal(
    persisted.data.account.cash,
    fixture.account.cash,
  )

  const notification = buildAlertNotification({
    alert,
    quote,
    stage: 'trigger',
    reason: alert.triggeredMsg,
  })
  assert.match(notification.title, /平安银行｜减仓1手/)
  assert.match(notification.body, /000001/)
  assert.match(notification.body, /人工确认后执行/)

  report.trackingResponse = historyOnly
    ? {
        triggered: 1,
        source: 'seeded-history',
        alerts: [{
          id: alert.id,
          phase: alert.phase,
          enabled: alert.enabled,
          state: alert.ruleState?.state,
          decisionPrice: alert.decisionPrice,
        }],
      }
    : {
        triggered: trackingResponses[0].triggered,
        source: 'active-browser',
        alerts: (trackingResponses[0].alerts || [])
          .map((item) => ({
            id: item.id,
            phase: item.phase,
            enabled: item.enabled,
            state: item.ruleState?.state,
            decisionPrice: item.decisionPrice,
          })),
      }
  assert.deepEqual(pageErrors, [])
  report.inAppBanner = historyOnly
    ? {
        historyReplaySuppressed: true,
        observedForMs: 6000,
      }
    : {
        title: '平安银行｜减仓1手',
        containsManualConfirmation: true,
        autoDismissed: true,
      }
  await context.close()

  report.passed = true
  report.quote = {
    code: quote.code,
    price,
    tradeDate: quote.tradeDate,
    isLivePrice: quote.isLivePrice,
  }
  report.trigger = {
    threshold,
    alertId: alert.id,
    phase: alert.phase,
    opQty: alert.opQty,
    decisionPrice: alert.decisionPrice,
    notification,
  }
  report.accountUnchanged = {
    holdingQty: persisted.data.holding.find(
      (item) => item.code === '000001',
    )?.qty,
    cash: persisted.data.account.cash,
  }
} catch (error) {
  report.passed = false
  report.error = String(error?.message || error)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  if (seeded) {
    try {
      await restoreFixture()
      report.cleanup = 'restored-simulation-fixture'
    } catch (error) {
      report.cleanup = 'failed'
      report.cleanupError = String(error?.message || error)
      report.passed = false
      process.exitCode = 1
    }
  }
  report.completedAt = Date.now()
  await fs.writeFile(
    'harness-artifacts/production-monitoring/report.json',
    JSON.stringify(report, null, 2),
  )
}

console.log(JSON.stringify(report, null, 2))
