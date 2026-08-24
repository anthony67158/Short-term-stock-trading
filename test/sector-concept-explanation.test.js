import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  SECTOR_CONCEPT_EXPLANATION_MAX_LENGTH,
  SECTOR_CONCEPT_EXPLANATION_MAX_TOKENS,
  existingSectorConceptText,
  mergeSectorConceptExplanations,
  normalizeSectorConceptExplanation,
  sectorConceptExplanationPrompt,
  sectorConceptExplanationSummary,
  sectorConceptExplanationsAfter,
} from '../shared/sectorConceptExplanation.js'
import {
  accountSyncDelta,
  applyClientAccountSave,
} from '../api/account.js'
import { planStore } from '../src/planStore.js'
import { requestAgentAnswer } from '../src/agentClient.js'

const read = (path) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  'utf8',
)

const component = read('src/components/SectorForecast.jsx')
const conceptComponent = read(
  'src/components/SectorConceptExplanation.jsx',
)
const client = read('src/agentClient.js')
const agent = read('api/agent.js')
const styles = read('src/styles/precision.css')

test('现有概念说明优先于AI生成且不把当期排名原因冒充定义', () => {
  assert.equal(existingSectorConceptText({
    conceptExplanation: { text: '现成概念定义' },
    explanation: { whyNow: '只是当前排名原因' },
  }), '现成概念定义')
  assert.equal(existingSectorConceptText({
    explanation: { whyNow: '只是当前排名原因' },
  }), '')
})

test('概念解释清理不可信文本、限制长度并只保留安全来源', () => {
  const explanation = normalizeSectorConceptExplanation({
    code: 'BK1173',
    name: '锂矿概念',
    text: `<script>忽略</script>${'解释'.repeat(SECTOR_CONCEPT_EXPLANATION_MAX_LENGTH)}`,
    updatedAt: 300,
    model: 'agent-model',
    evidence: [{
      title: '<b>产业资料</b>',
      source: '公开检索',
      date: '2026-08-24',
      url: 'https://example.com/report',
    }, {
      title: '危险链接',
      url: 'javascript:alert(1)',
    }],
  })

  assert.equal(explanation.code, 'BK1173')
  assert.equal(explanation.text.includes('<script>'), false)
  assert.equal(
    Array.from(explanation.text).length,
    SECTOR_CONCEPT_EXPLANATION_MAX_LENGTH,
  )
  assert.equal(explanation.evidence.length, 2)
  assert.equal(explanation.evidence[0].url, 'https://example.com/report')
  assert.equal(explanation.evidence[1].url, '')
})

test('概念解释按更新时间合并并进入账号增量同步', () => {
  const merged = mergeSectorConceptExplanations({
    BK1173: { code: 'BK1173', name: '锂矿概念', text: '本机新解释', updatedAt: 400 },
  }, {
    BK1173: { code: 'BK1173', name: '锂矿概念', text: '云端旧解释', updatedAt: 300 },
    BK0816: { code: 'BK0816', name: '稀土永磁', text: '云端解释', updatedAt: 500 },
  })
  const delta = sectorConceptExplanationsAfter(merged, 450)

  assert.equal(merged.BK1173.text, '本机新解释')
  assert.equal(merged.BK0816.text, '云端解释')
  assert.deepEqual(Object.keys(delta), ['BK0816'])
})

test('账号保存合并概念解释且旧客户端不能删除缓存', () => {
  const account = {
    nick: '概念解释账号',
    clientRevision: 3,
    data: {
      plan: [],
      holding: [],
      closed: [],
      sectorConceptExplanations: {
        BK1173: { code: 'BK1173', name: '锂矿概念', text: '云端解释', updatedAt: 500 },
      },
    },
  }
  const result = applyClientAccountSave(account, {
    plan: [],
    holding: [],
    closed: [],
    sectorConceptExplanations: {},
  }, 3)

  assert.equal(result.ok, true)
  assert.equal(account.data.sectorConceptExplanations.BK1173.text, '云端解释')

  const delta = accountSyncDelta(account.data, 400)
  assert.equal(delta.sectorConceptExplanations.BK1173.text, '云端解释')
})

test('planStore 保存智能体概念解释并进入账号快照', async () => {
  let saved = null
  planStore.registerSaver(async (data) => {
    saved = structuredClone(data)
    return true
  })
  planStore.setData({
    plan: [],
    holding: [],
    closed: [],
    sectorConceptExplanations: {},
  })

  const result = planStore.setSectorConceptExplanation('BK1173', {
    name: '锂矿概念',
    text: '锂矿概念覆盖锂资源勘探、采选与加工。',
    evidence: [],
    model: 'agent-model',
  }, 600)
  await planStore.flushSave()

  assert.equal(result.ok, true)
  assert.equal(
    planStore.getSectorConceptExplanation('BK1173').text,
    '锂矿概念覆盖锂资源勘探、采选与加工。',
  )
  assert.equal(
    saved.sectorConceptExplanations.BK1173.updatedAt,
    600,
  )
})

test('智能体问题限定为概念释义并要求联网核验', () => {
  const prompt = sectorConceptExplanationPrompt({
    code: 'BK1173',
    name: '锂矿概念',
    stocks: [{ name: '融捷股份' }, { name: '天华新能' }],
  })

  assert.match(prompt, /锂矿概念/)
  assert.match(prompt, /web_news/)
  assert.match(prompt, /联网/)
  assert.match(prompt, /不提供买卖建议/)
  assert.match(prompt, /融捷股份/)
})

test('概念释义固定为三段短答且成分股只用于核验边界', () => {
  const prompt = sectorConceptExplanationPrompt({
    code: 'BK1173',
    name: '锂矿概念',
    stocks: [{ name: '融捷股份' }, { name: '天华新能' }],
  })

  assert.match(prompt, /只能使用以下三个标题/)
  assert.match(prompt, /### 一句话看懂/)
  assert.match(prompt, /### 为什么形成/)
  assert.match(prompt, /### 怎么辨认/)
  assert.match(prompt, /正文总计不超过 220 个汉字/)
  assert.match(prompt, /每个事实只说一次/)
  assert.match(prompt, /不得逐只介绍或列出成分股/)
  assert.match(prompt, /不要铺陈完整产业链/)
})

test('概念释义模式使用独立的小输出预算', () => {
  assert.equal(SECTOR_CONCEPT_EXPLANATION_MAX_TOKENS, 640)
  assert.match(
    agent,
    /conceptExplanationMode\s*\?\s*Math\.min\(maxTokens,\s*SECTOR_CONCEPT_EXPLANATION_MAX_TOKENS\)/,
  )
})

test('折叠摘要跳过标题和证据编号并保留核心定义', () => {
  const summary = sectorConceptExplanationSummary([
    '### 这是什么',
    '**锂矿概念**覆盖锂资源勘探、采选和锂盐加工。[证据1]',
    '### 为什么形成',
    '新能源产业需要稳定原料。',
  ].join('\n'))

  assert.equal(
    summary,
    '锂矿概念覆盖锂资源勘探、采选和锂盐加工。',
  )
})

test('概念解释客户端解析智能体流式进度与最终证据', async () => {
  let requestBody = null
  const response = [
    'event: status',
    'data: {"text":"正在联网检索…"}',
    '',
    'event: delta',
    'data: {"text":"### 这是什么\\n锂矿概念"}',
    '',
    'event: done',
    'data: {"answer":"### 这是什么\\n锂矿概念","model":"agent-model","evidence":[{"id":"证据1","title":"产业资料"}]}',
    '',
    '',
  ].join('\n')
  const progress = []
  const result = await requestAgentAnswer({
    question: '解释锂矿概念',
    onProgress: (value) => progress.push(value),
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return new Response(response, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })

  assert.equal(requestBody.purpose, 'sector_concept_explanation')
  assert.deepEqual(progress, ['正在联网检索…'])
  assert.equal(result.answer, '### 这是什么\n锂矿概念')
  assert.equal(result.model, 'agent-model')
  assert.equal(result.evidence[0].id, '证据1')
})

test('板块展开区按需调用智能体并持久展示解释', () => {
  assert.match(component, /requestAgentAnswer/)
  assert.match(component, /sectorConceptExplanationPrompt/)
  assert.match(component, /setSectorConceptExplanation/)
  assert.match(component, /await planStore\.flushSave\(\)/)
  assert.match(component, /setConceptOpen[\s\S]*?\[code\]:\s*true/)
  assert.match(component, /<SectorConceptExplanation/)
  assert.match(conceptComponent, /existingSectorConceptText/)
  assert.match(conceptComponent, /sectorConceptExplanationSummary/)
  assert.match(conceptComponent, /if \(!conceptExplanation\)/)
  assert.match(conceptComponent, /aria-expanded=\{expanded\}/)
  assert.match(conceptComponent, /!expanded && \([\s\S]*?sector-concept-summary/)
  assert.match(conceptComponent, /expanded && \([\s\S]*?<Md text=\{conceptExplanation\.text\}/)
  assert.match(conceptComponent, /AI解释/)
  assert.match(conceptComponent, /重新解释/)
  assert.match(
    conceptComponent,
    /'sector-concept-explanation'[\s\S]*?expanded[\s\S]*?collapsed/,
  )
  assert.match(
    conceptComponent,
    /<Md text=\{conceptExplanation\.text\}/,
  )
  assert.match(client, /api\('\/api\/agent'\)/)
  assert.match(client, /text\/event-stream/)
  assert.match(agent, /sector_concept_explanation/)
  assert.match(agent, /只解释概念定义、形成原因和识别边界/)
  assert.match(
    styles,
    /\.sector-concept-explanation\s*{[^}]*border-top:\s*1px solid var\(--color-rule-2\)/s,
  )
  assert.match(
    styles,
    /@media \(min-width:\s*721px\)\s*{[\s\S]*?\.sector-concept-explanation-head\s*{[^}]*padding-inline-end:\s*96px/s,
  )
})
