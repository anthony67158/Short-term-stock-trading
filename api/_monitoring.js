import { readAccount, writeAccount } from './account.js'
import { fetchQuotes } from './quote.js'
import { sendPush } from './_push_send.js'
import { t1StatusOf } from './_portfolio.js'
import { trackedRuleHit } from '../shared/monitoringPlan.js'
import { buildAlertNotification } from '../shared/alertNotification.js'
import { isContinuousTrading } from '../shared/tradingCalendar.js'
import { isAdviceReviewEnabled } from '../shared/adviceReviewPolicy.js'

export async function evaluateAccountMonitoring(account, {
  now = Date.now(),
  quoteReader = fetchQuotes,
  read = readAccount,
  save = writeAccount,
  push = sendPush,
} = {}) {
  if (!isContinuousTrading(now)) return { ok: true, alerts: [], triggered: 0 }
  const enabled = (data) => (data.alerts || []).filter((alert) =>
    alert.type === 'plan-condition' && alert.enabled
    && data.settings?.aiAutoAlert !== false
    && isAdviceReviewEnabled(data.settings, alert.code),
  )
  const codes = [...new Set(enabled(account.data || {}).map((alert) => alert.code))]
  if (!codes.length) return { ok: true, alerts: [], triggered: 0 }
  const quotes = await quoteReader(codes)
  const quoteMap = Object.fromEntries(quotes.map((quote) => [quote.code, quote]))
  let current = account
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = current.data || {}
    const notifications = []
    let changed = false
    for (const alert of enabled(data).sort((a, b) => a.planRule.priority - b.planRule.priority)) {
      if (!alert.enabled) continue
      const currentPlan = data.advice?.[alert.code]?.advice?.monitoringPlan
      if (currentPlan?.planId !== alert.monitoringPlanId || Date.parse(alert.validUntil) <= now) {
        Object.assign(alert, { phase: 'superseded', enabled: false, supersededAt: now })
        changed = true
        continue
      }
      const position = t1StatusOf(data.holding || [], data.closed || [], alert.code, now)
      if (!(position.liveQty > 0)) {
        Object.assign(alert, { phase: 'superseded', enabled: false, supersededAt: now })
        changed = true
        continue
      }
      const hit = trackedRuleHit(alert, quoteMap[alert.code], now)
      alert.updatedAt = now
      changed = true
      if (!hit) continue
      const lots = Math.min(alert.planRule.lots, position.sellableToday)
      if (!(lots > 0)) {
        alert.ruleState.state = 'T1_LOCKED'
        continue
      }
      const full = lots >= position.liveQty
      Object.assign(alert, {
        opQty: `${full ? '清仓' : '减仓'}${lots}手`,
        phase: 'triggered', enabled: false, triggeredAt: now, triggeredMsg: hit,
        decisionPrice: quoteMap[alert.code].price, decisionLots: lots,
      })
      for (const sibling of data.alerts) {
        if (sibling.id !== alert.id && sibling.monitoringPlanId === alert.monitoringPlanId) {
          Object.assign(sibling, { enabled: false, phase: 'superseded', supersededAt: now })
        }
      }
      notifications.push(buildAlertNotification({ alert, quote: quoteMap[alert.code], stage: 'trigger', reason: hit }))
    }
    if (!changed) return { ok: true, alerts: [], triggered: 0 }
    try {
      await save(current, undefined, { history: false, verify: true })
    } catch (error) {
      if (attempt === 0 && (error.status === 409 || error.statusCode === 409)) {
        current = await read(account.nick)
        continue
      }
      throw error
    }
    for (const notification of notifications) {
      await push(data.pushSubs || [], notification).catch(() => {})
    }
    return {
      ok: true, triggered: notifications.length,
      alerts: (data.alerts || []).filter((alert) => alert.type === 'plan-condition'),
    }
  }
  return { ok: false, alerts: [], triggered: 0 }
}
