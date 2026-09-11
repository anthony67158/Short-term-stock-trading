import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

assert.ok(process.argv.includes('--online'), 'Use --online to authorize test-account jobs')
const base = 'https://stock-dashboard-znrlekbzit.cn-hangzhou.fcapp.run'
const secret = (await readFile('CREDENTIALS.md', 'utf8'))
  .split('## 7. 自动化测试账号')[1]?.split('\n## ')[0] || ''
const nick = secret.match(/账号[：:]\s*([^\n]+)/)?.[1]?.trim()
const password = secret.match(/密码[：:]\s*([^\n]+)/)?.[1]?.trim()
assert.equal(nick, '测试账号')
assert.ok(password)
const fixture = JSON.parse(await readFile('test/fixtures/comprehensive-test-account.json', 'utf8'))
const codes = [...new Set([...fixture.holding, ...fixture.plan].map((row) => row.code))]
const output = 'harness-artifacts/strategy-runtime/test-account.json'
await mkdir('harness-artifacts/strategy-runtime', { recursive: true })
const report = { startedAt: Date.now(), account: '测试账号', transport: 'API', cases: [] }
let token
const batches = []
async function request(path, payload) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nick, ...(token ? { token } : {}), ...payload }),
    signal: AbortSignal.timeout(45_000),
  })
  const body = await response.json()
  assert.ok([200, 202].includes(response.status), body.error || `${path}: ${response.status}`)
  assert.equal(body.ok, true, body.error || path)
  return body
}
const account = () => request('/api/account', { action: 'get' })
const status = () => request('/api/cron_advice', { op: 'status' })
const jobs = (value) => [...Object.values(value.jobs || {}), ...Object.values(value.reviewJobs || {})]
const active = (value) => jobs(value).filter((j) => ['queued', 'running'].includes(j.status))
const facts = (value) => JSON.stringify({
  cash: value.account?.cash,
  holding: value.holding?.map(({ id, code, qty, buyPrice, buyFee, buyAt, tFlows }) =>
    ({ id, code, qty, buyPrice, buyFee, buyAt, tFlows })),
  closed: value.closed, transactions: value.transactions,
})
async function settle(batchId) {
  for (let i = 0; i < 100; i++) {
    const runtime = await status()
    const batch = jobs(runtime).filter((job) => job.batchId === batchId)
    if (batch.length && batch.every((job) => !['queued', 'running'].includes(job.status))) return batch
    await delay(3000)
  }
  throw new Error('Test batch did not finish within five minutes')
}
try {
  token = (await request('/api/account', { action: 'login', pw: password })).token
  assert.ok(token)
  const before = (await account()).data
  assert.equal(before.account?.simulation, true, 'Refuse non-simulation account')
  assert.equal(before.account.cash, fixture.account.cash)
  assert.deepEqual(before.holding.map((h) => h.id).sort(), fixture.holding.map((h) => h.id).sort())
  assert.equal(active(await status()).length, 0, 'Refuse to interfere with active jobs')
  const ledger = facts(before)
  const batchId = `strategy-acceptance-${Date.now()}`
  batches.push(batchId)
  const payload = { ondemand: true, op: 'enqueue', codes, scope: 'all', batchId, requestId: batchId }
  await request('/api/cron_advice', payload)
  const completed = await settle(batchId)
  assert.equal(completed.length, codes.length)
  assert.ok(completed.every((j) => j.status === 'done'), 'A generated decision failed')
  const after = (await account()).data
  assert.equal(facts(after), ledger, 'Decision jobs changed trade facts')
  for (const job of completed) {
    const entry = after.advice?.[job.code]
    assert.ok(entry?.at >= report.startedAt)
    assert.equal(entry.advice?.decisionSource?.engine, 'MULTI_TASK')
    assert.ok(entry.advice.decisionPaths.some((p) => p.opportunityScore?.state === 'READY'))
    report.cases.push({
      code: job.code, status: job.status, attempts: job.attempts,
      decisionId: entry.advice.decisionPlan.decisionId,
      action: entry.advice.decisionPlan.action,
      actionability: entry.advice.decisionPlan.actionability,
      savedAt: entry.at,
    })
  }
  await request('/api/cron_advice', payload)
  const duplicate = jobs(await status()).filter((job) => job.batchId === batchId)
  assert.deepEqual(duplicate.map((j) => j.id).sort(), completed.map((j) => j.id).sort())
  assert.ok(duplicate.every((j) => j.status === 'done'))
  report.idempotency = true
  const canceledBatch = `${batchId}-cancel`
  batches.push(canceledBatch)
  await request('/api/cron_advice', {
    ...payload, batchId: canceledBatch, requestId: canceledBatch, codes: [codes[0]],
  })
  await request('/api/cron_advice', { op: 'cancelAll', batchId: canceledBatch })
  const canceled = await settle(canceledBatch)
  assert.ok(canceled.every((job) => ['canceled', 'done'].includes(job.status)))
  report.cancellation = canceled.map((j) => ({ code: j.code, status: j.status }))
  assert.equal(facts((await account()).data), ledger)
  report.ledgerUnchanged = true
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.message
  process.exitCode = 1
} finally {
  for (const batchId of batches) {
    const runtime = await status().catch(() => null)
    if (runtime && active(runtime).some((job) => job.batchId === batchId)) {
      await request('/api/cron_advice', { op: 'cancelAll', batchId }).catch(() => {})
      await settle(batchId).catch(() => {})
    }
  }
  report.finishedAt = Date.now()
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report))
}
