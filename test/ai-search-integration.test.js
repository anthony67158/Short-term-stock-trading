import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('个人菜单提供AI检索开关和API Key更换入口', () => {
  const menu = read('src/components/AuthGate.jsx')
  const app = read('src/App.jsx')

  assert.match(menu, /role="menuitemcheckbox"/)
  assert.match(menu, /AI消息检索/)
  assert.match(menu, /更换 Search API Key/)
  assert.match(app, /AISearchConfig/)
})

test('军师助手日报选股统一接入AI检索配置', () => {
  const ai = read('api/ai.js')
  const agent = read('api/agent.js')
  const daily = read('api/daily_report.js')

  assert.match(ai, /fetchAdvisorSearch/)
  assert.match(ai, /fetchAiSearchReference/)
  assert.match(ai, /searchReference/)
  assert.match(agent, /fetchAiSearchReference/)
  assert.match(agent, /检索参考·必须引用/)
  assert.match(daily, /fetchAiSearchReference/)
  assert.match(daily, /searchConfigUpdatedAt/)
})

test('关闭开关时各展示区域动态移除检索参考', () => {
  const component = read('src/components/SearchReference.jsx')
  const assistant = read('src/components/AIAssistant.jsx')
  const daily = read('src/components/DailyReport.jsx')
  const picker = read('src/components/TodayTab.jsx')
  const advice = read('src/components/AdvicePresentation.jsx')

  assert.match(component, /visibleSearchReference/)
  assert.match(assistant, /item\?\.dimension !== 'search'/)
  assert.match(assistant, /searchConfig\.enabled \|\| !m\.searchReference/)
  assert.match(daily, /item\?\.kind !== 'ai_search'/)
  assert.match(daily, /<SearchReference/)
  assert.match(picker, /<SearchReference/)
  assert.match(advice, /<SearchReference/)
})

test('前端配置状态不持久化或回显明文Key', () => {
  const store = read('src/aiSearchConfigStore.js')
  const dialog = read('src/components/AISearchConfig.jsx')

  assert.doesNotMatch(store, /localStorage|sessionStorage/)
  assert.doesNotMatch(store, /apiKey:\s*state/)
  assert.match(dialog, /type="password"/)
  assert.match(dialog, /Key 仅保存在服务端 OSS/)
})
