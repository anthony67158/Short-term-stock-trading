import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildDailyReportSearchPlans,
} from '../api/_daily_report_content.js'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('个人菜单提供豆包联网搜索开关和API Key更换入口', () => {
  const menu = read('src/components/AuthGate.jsx')
  const app = read('src/App.jsx')

  assert.match(menu, /role="menuitemcheckbox"/)
  assert.match(menu, /豆包联网搜索/)
  assert.match(menu, /更换豆包 API Key/)
  assert.match(app, /AISearchConfig/)
})

test('军师助手日报选股统一接入AI检索配置', () => {
  const ai = read('api/ai.js')
  const agent = read('api/agent.js')
  const daily = read('api/daily_report.js')

  assert.match(ai, /fetchAdvisorSearch/)
  assert.match(ai, /fetchIndustrySearchSupplement/)
  assert.doesNotMatch(ai, /行业新闻主源/)
  assert.match(ai, /豆包行业资讯/)
  assert.match(ai, /includeIndustry/)
  assert.match(ai, /industryNewsSource/)
  assert.match(ai, /fetchAiSearchReference/)
  assert.match(ai, /fetchAdvisorSearchBundle/)
  assert.match(ai, /'stockSearch'/)
  assert.match(ai, /豆包个股信息/)
  assert.match(ai, /stockStatus/)
  assert.match(ai, /industryStatus/)
  assert.match(ai, /searchReference/)
  assert.match(agent, /fetchAiSearchReference/)
  assert.match(agent, /检索参考·必须引用/)
  assert.match(daily, /fetchAiSearchReference/)
  assert.match(daily, /searchConfigUpdatedAt/)
  for (const source of [ai, agent, daily]) {
    assert.doesNotMatch(source, /anspire|ANSPIRE/)
  }
})

test('策略日报用三类豆包检索分别补齐公司行业与全球信息', () => {
  const plans = buildDailyReportSearchPlans({
    day: '2026-08-20',
    session: 'noon',
    focusStocks: [{ code: '000001', name: '平安银行' }],
    industries: ['银行'],
  })

  assert.deepEqual(plans.map((item) => item.key), [
    'company',
    'industry',
    'global',
  ])
  assert.match(plans[0].query, /公告/)
  assert.match(plans[1].query, /行业政策/)
  assert.match(plans[2].query, /全球市场/)
  assert.ok(plans.every((plan) => Array.from(plan.query).length <= 64))
  assert.ok(plans.every((plan) => plan.cacheScope.startsWith('daily-')))
  assert.ok(plans.every((plan) => plan.cacheKey.includes('-v3:')))
  assert.ok(plans.every((plan) => plan.cacheMinutes === 60))
  assert.ok(plans.every((plan) => plan.topK === 8))
  assert.ok(plans.every((plan) => plan.version === 3))
})

test('关闭开关时军师助手与日报动态移除检索参考', () => {
  const component = read('src/components/SearchReference.jsx')
  const assistant = read('src/components/AIAssistant.jsx')
  const daily = read('src/components/DailyReport.jsx')
  const advice = read('src/components/AdvicePresentation.jsx')

  assert.match(component, /visibleSearchReference/)
  assert.match(assistant, /item\?\.dimension !== 'search'/)
  assert.match(assistant, /searchConfig\.enabled \|\| !m\.searchReference/)
  assert.match(daily, /\.filter\(\s*\(item\) => item\?\.kind !== 'doubao_search'/)
  assert.match(daily, /<SearchReference/)
  assert.match(advice, /<SearchReference/)
})

test('前端配置状态不持久化或回显明文Key', () => {
  const store = read('src/aiSearchConfigStore.js')
  const dialog = read('src/components/AISearchConfig.jsx')

  assert.doesNotMatch(store, /localStorage|sessionStorage/)
  assert.doesNotMatch(store, /apiKey:\s*state/)
  assert.match(dialog, /type="password"/)
  assert.match(dialog, /Key 仅保存在服务端 OSS/)
  assert.match(dialog, /豆包搜索 Global版/)
  assert.match(dialog, /API Key 名称/)
  assert.match(dialog, /freeCallsPerMonth/)
  assert.match(dialog, /失败冷却/)
  assert.match(dialog, /industryFailureCooldownMinutes/)
})

test('交易冲突必须提供明确的本机账本覆盖动作而不是无效重试', () => {
  const auth = read('src/authStore.js')
  const menu = read('src/components/AuthGate.jsx')

  assert.match(auth, /resolveTradeConflict/)
  assert.match(auth, /forceTradeState:\s*true/)
  assert.match(menu, /以本机交易账本覆盖云端/)
  assert.match(menu, /本机账本为准/)
})
