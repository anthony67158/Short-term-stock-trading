import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readdirSync,
  readFileSync,
} from 'node:fs'

const componentNames = readdirSync(
  new URL('../src/components', import.meta.url),
).filter((name) => name.endsWith('.jsx'))

const sources = [
  ['src/App.jsx', readFileSync(
    new URL('../src/App.jsx', import.meta.url),
    'utf8',
  )],
  ...[
    'shared/adviceUiState.js',
    'shared/stockDetailActions.js',
    'shared/stockRanking.js',
  ].map((path) => [
    path,
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  ]),
  ...componentNames.map((name) => [
    `src/components/${name}`,
    readFileSync(
      new URL(`../src/components/${name}`, import.meta.url),
      'utf8',
    ),
  ]),
]

function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

test('用户界面使用业务语言而不是重复展示AI字样', () => {
  const findings = []

  for (const [path, source] of sources) {
    withoutComments(source)
      .split('\n')
      .forEach((line, index) => {
        if (/\bAI\b/.test(line)) {
          findings.push(`${path}:${index + 1} ${line.trim()}`)
        }
      })
  }

  assert.deepEqual(findings, [])
})

test('核心入口保留明确业务语义', () => {
  const source = Object.fromEntries(sources)

  assert.match(source['src/components/StockDetail.jsx'], /军师 · 操作建议/)
  assert.match(source['src/components/AlertPanel.jsx'], />自动预警</)
  assert.match(source['src/components/LLMConfig.jsx'], /模型角色与端点/)
  assert.match(source['src/components/SectorConceptExplanation.jsx'], /'解释'/)
  assert.match(source['src/components/ReviewTab.jsx'], />军师建议</)
  assert.match(
    source['src/components/HoldingPlanDialog.jsx'],
    /恢复自动跟随/,
  )
})
