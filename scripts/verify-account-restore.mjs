import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.equal(new URL(base).hostname, '127.0.0.1')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const waitMs of [100, 1200]) {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', (route) => new URL(route.request().url()).origin === base
      ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.goto(`${base}/test/ui/account-restore-preview.html`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '删除本地规则与自选', exact: true }).click()
    await page.waitForTimeout(waitMs)
    await page.getByRole('button', { name: '返回延迟云端快照', exact: true }).click()
    await page.waitForTimeout(1800)
    await page.getByRole('button', { name: '检查保存结果', exact: true }).click()
    const local = JSON.parse(await page.getByTestId('local').innerText())
    const cloud = JSON.parse(await page.getByTestId('cloud').innerText())
    results.push({ waitMs, local, cloud })
    await context.close()
  }
  console.log(JSON.stringify(results, null, 2))
  await fs.mkdir('harness-artifacts/account-restore', { recursive: true })
  await fs.writeFile('harness-artifacts/account-restore/report.json', JSON.stringify(results, null, 2))
  for (const { local, cloud } of results) {
    assert.deepEqual(local, { plan: 0, alerts: 0 }, '恢复期间的用户删除不得被延迟快照覆盖')
    assert.equal(cloud.plan, 0)
    assert.equal(cloud.alerts, 0)
  }
} finally {
  await browser.close()
}
