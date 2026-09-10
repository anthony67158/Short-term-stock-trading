import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const base = process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.equal(new URL(base).hostname, '127.0.0.1')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output = 'harness-artifacts/quant-report'
await fs.mkdir(output, { recursive: true })
const time = Date.parse('2026-09-10T08:20:00+08:00')
const reports = [
  {
    id: 'quantreport/opportunity-123.json', at: time, model: 'opportunity',
    title: 'V3 机会模型 · 每日重训', decision: 'reject',
    summary: '本轮未通过晋级，生产模型未切换。',
    meta: { runId: 123, runNumber: 20, trainingAt: time,
      workflowUrl: 'https://github.com/example/repo/actions/runs/123' },
    details: {
      facts: [
        { label: '成熟样本', value: '73004' }, { label: '完整成交样本', value: '37516' },
        { label: '独立交易日', value: '124' },
        { label: '候选版本', value: 'opportunity-score.local-test-long-version.20260910T002040Z' },
      ],
      metrics: [
        { label: 'Top5 费后净R', challenger: -0.213379, baseline: -0.664453, unit: 'r' },
        { label: 'Top5 净R下置信界', challenger: -0.518984, baseline: null, unit: 'r' },
        { label: 'Top5 正净R信号占比', challenger: 0.242105, baseline: 0.073684, unit: 'percent' },
      ],
      blockers: ['独立滚动时间窗未稳定通过验证', 'Top5费后净R下置信界未大于0'],
    },
  },
  { id: 'quantreport/sector-123.json', at: time - 1000, model: 'sector', title: '板块每日重训',
    decision: 'error', body: '原因：板块数据源不可达\n线上模型未切换', meta: { runId: 123 } },
  { id: 'quantreport/retrain-123.json', at: time - 2000, title: '量化每日重训',
    decision: 'skip', body: '增量适配样本：900/1000\n训练时间：2026-09-10 01:15', meta: { runId: 123 } },
]
const fixture = {
  ok: true,
  workflow: { available: true, latest: { state: 'success', runNumber: 20,
    event: 'schedule', startedAt: time - 600000, durationSec: 600 } },
  opportunity: { at: time, label: '未通过验证', productionEligible: false,
    samples: 73004, filledSamples: 37516, dates: 124, blockers: ['Top5费后净R下置信界未大于0'] },
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const width of [320, 768, 1024, 1440]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' })
      let current = structuredClone(reports)
      let failRead = false
      let failDelete = false
      let reads = 0
      const requests = []
      await context.route('**/*', async (route) => {
        const req = route.request()
        const url = new URL(req.url())
        if (url.pathname === '/api/quant_report') {
          if (req.method() === 'GET') {
            reads++
            return route.fulfill({ json: failRead ? { ok: false, error: 'test offline' } : { ...fixture, reports: current } })
          }
          const body = req.postDataJSON()
          requests.push(body)
          if (failDelete) return route.fulfill({ json: { ok: false, error: 'test storage failure' } })
          current = body.action === 'clear' ? [] : current.filter((row) => row.id !== body.id)
          return route.fulfill({ json: { ok: true } })
        }
        return url.origin === base ? route.continue() : route.abort()
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${base}/test/ui/quant-report-preview.html?theme=${theme}`, { waitUntil: 'domcontentloaded' })
      const dialog = page.getByRole('dialog', { name: '量化汇报', exact: true })
      await dialog.locator('.qrp-card').first().waitFor()
      assert.equal(await dialog.locator('.qrp-card').count(), 3)
      assert.match(await dialog.innerText(), /73,004/)
      assert.match(await dialog.innerText(), /-0.519 R/)
      assert.match(await dialog.innerText(), /未提供/)
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector('.qrp-panel')
        const scroll = document.querySelector('.qrp-scroll')
        const bounds = panel.getBoundingClientRect()
        const buttons = [...document.querySelectorAll('.qrp-actions button')].map((button) => {
          const rect = button.getBoundingClientRect()
          return { width: rect.width, height: rect.height }
        })
        return {
          width: innerWidth, pageWidth: document.documentElement.scrollWidth,
          panelLeft: bounds.left, panelRight: bounds.right,
          contentWidth: scroll.clientWidth, contentScrollWidth: scroll.scrollWidth, buttons,
          metrics: [...document.querySelectorAll('.qrp-metrics :is(th, td)')].map((cell) => ({
            width: cell.clientWidth, scrollWidth: cell.scrollWidth,
          })),
        }
      })
      assert.equal(geometry.pageWidth, width)
      assert.ok(geometry.panelLeft >= 0 && geometry.panelRight <= width)
      assert.ok(geometry.contentScrollWidth <= geometry.contentWidth + 1)
      for (const button of geometry.buttons) assert.ok(Math.abs(button.width - button.height) < 0.01)
      for (const cell of geometry.metrics) assert.ok(cell.scrollWidth <= cell.width + 1)
      await page.screenshot({ path: `${output}/${width}-${theme}.png`, fullPage: true, animations: 'disabled' })
      await dialog.locator('.qrp-metrics').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${output}/${width}-${theme}-metrics.png`, fullPage: true, animations: 'disabled' })
      await dialog.getByRole('button', { name: 'V3 机会模型', exact: true }).click()
      assert.equal(await dialog.locator('.qrp-card').count(), 1)
      await dialog.locator('summary').click()
      assert.equal(await dialog.locator('.qrp-metrics').isVisible(), false)
      await dialog.locator('summary').click()
      assert.equal(await dialog.locator('.qrp-metrics').isVisible(), true)
      failRead = true
      await dialog.getByRole('button', { name: '刷新汇报', exact: true }).click()
      await dialog.getByRole('alert').waitFor()
      assert.equal(await dialog.locator('.qrp-card').count(), 1)
      failRead = false
      await dialog.getByRole('button', { name: '刷新汇报', exact: true }).click()
      await dialog.getByRole('alert').waitFor({ state: 'hidden' })
      failDelete = true
      await dialog.getByRole('button', { name: '删除这条汇报', exact: true }).click()
      await dialog.getByRole('alert').waitFor()
      assert.equal(await dialog.locator('.qrp-card').count(), 1)
      failDelete = false
      await dialog.getByRole('button', { name: '清空全部汇报', exact: true }).click()
      assert.equal(requests.filter((request) => request.action === 'clear').length, 0)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await dialog.getByRole('button', { name: '清空全部汇报', exact: true }).click()
      await dialog.getByRole('button', { name: '确认清空', exact: true }).click()
      await dialog.locator('.qrp-card').waitFor({ state: 'hidden' })
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      const before = reads
      await page.getByRole('button', { name: '打开量化汇报' }).click()
      await page.getByText('暂无量化汇报', { exact: true }).waitFor()
      assert.ok(reads > before)
      assert.deepEqual(errors, [])
      results.push({ theme, ...geometry })
      await context.close()
    }
  }
  await fs.writeFile(`${output}/geometry.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ passed: true, viewports: [320, 768, 1024, 1440], themes: 2,
    checks: ['model-filters', 'metrics', 'details-toggle', 'read-failure', 'delete-failure', 'clear-confirm', 'escape', 'reopen-refresh', 'no-overflow'] }))
} finally {
  await browser.close()
}
