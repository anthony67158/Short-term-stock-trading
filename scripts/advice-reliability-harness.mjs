import { readAccount } from '../api/account.js'
import { reconcileAdviceNumbers } from '../shared/adviceValidation.js'

const apiBase = String(process.env.HARNESS_API_URL || 'http://localhost:3001').replace(/\/+$/, '')
const nick = String(process.env.HARNESS_NICK || '').trim()
const password = String(process.env.HARNESS_PASSWORD || '')
const runs = Math.max(1, Math.min(12, Number(process.env.HARNESS_RUNS) || 4))
const concurrency = Math.max(1, Math.min(runs, Number(process.env.HARNESS_CONCURRENCY) || 2))
const budgetMs = Math.max(30000, Math.min(560000, Number(process.env.HARNESS_BUDGET_MS) || 210000))

if (!nick) throw new Error('请通过 HARNESS_NICK 指定用于只读取样的账号')
if (!password) throw new Error('请通过 HARNESS_PASSWORD 提供Harness账号密码')
const account = await readAccount(nick)
if (!account?.data) throw new Error('Harness 账号不存在或无法读取')
const holding = (account.data.holding || [])[0]
const watch = (account.data.plan || []).find((item) => item.code !== holding?.code) || (account.data.plan || [])[0]
if (!holding || !watch) throw new Error('Harness 至少需要一只持仓和一只自选')

function parseSSE(text) {
  let result = null
  const reasoning = []
  for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
    let event = ''
    let raw = ''
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) raw += line.slice(5).trim()
    }
    if (!raw) continue
    let data = null
    try { data = JSON.parse(raw) } catch { continue }
    if (event === 'result') result = data
    if (event === 'reasoning' && data?.text) reasoning.push(String(data.text))
  }
  return { result, visibleReasoning: reasoning.join('') }
}

const allowedLatin = /\b(?:ATR|BOLL|JSON|KDJ|MACD|RSI|VWAP)\b/gi
function hasUnexpectedEnglish(text) {
  return /[A-Za-z]{3,}/.test(String(text || '').replace(allowedLatin, ''))
}

function caseAt(index) {
  if (index % 2 === 0) {
    return {
      id: `hold-${index / 2 + 1}`,
      mode: 'hold_advice',
      payload: {
        code: holding.code,
        name: holding.name,
        holdCost: holding.buyPrice,
        holdQty: holding.qty,
        sellableTodayQty: holding.qty,
        account: account.data.account || null,
      },
    }
  }
  return {
    id: `buy-${Math.floor(index / 2) + 1}`,
    mode: 'buy_advice',
    payload: { code: watch.code, name: watch.name, account: account.data.account || null },
  }
}

async function execute(testCase) {
  const startedAt = Date.now()
  try {
    const response = await fetch(`${apiBase}/api/ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-account-nick': encodeURIComponent(nick),
        'x-account-password': encodeURIComponent(password),
      },
      body: JSON.stringify({
        mode: testCase.mode,
        payload: testCase.payload,
        stream: true,
        runtimeBudgetMs: budgetMs,
      }),
    })
    const parsed = parseSSE(await response.text())
    const output = parsed.result
    const checked = reconcileAdviceNumbers({
      mode: testCase.mode,
      result: output?.result,
      payload: testCase.payload,
    })
    const errors = []
    if (!output?.ok) errors.push(output?.error || '生成失败')
    if (output?.truncated) errors.push('结果被截断')
    if (checked.issues.length) errors.push(...checked.issues)
    if (hasUnexpectedEnglish(parsed.visibleReasoning)) errors.push('可见思考链含英文句子')
    if (hasUnexpectedEnglish(output?.result?.reasoning)) errors.push('最终研判含英文句子')
    return {
      id: testCase.id,
      mode: testCase.mode,
      ok: errors.length === 0,
      elapsedMs: Date.now() - startedAt,
      model: output?.model || '',
      endpoint: output?.endpoint || '',
      errors,
    }
  } catch (error) {
    return {
      id: testCase.id,
      mode: testCase.mode,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      errors: [String(error?.message || error)],
    }
  }
}

const results = new Array(runs)
let cursor = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < runs) {
    const index = cursor++
    results[index] = await execute(caseAt(index))
  }
}))
const summary = {
  ok: results.every((result) => result.ok),
  passed: results.filter((result) => result.ok).length,
  total: results.length,
  concurrency,
  avgMs: Math.round(results.reduce((sum, result) => sum + result.elapsedMs, 0) / results.length),
  results,
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
if (!summary.ok) process.exitCode = 1
