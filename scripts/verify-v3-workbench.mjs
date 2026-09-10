import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const base = process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.equal(new URL(base).hostname, '127.0.0.1')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output = 'harness-artifacts/v3-workbench'
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const width of [320, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.clock.install({ time: new Date('2026-09-10T02:10:00Z') })
    await page.goto(`${base}/test/ui/v3-workbench-preview.html?tab=positions`, { waitUntil: 'domcontentloaded' })
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /持仓/ }).click()
    await page.locator('.plan-cand.v3-card').first().waitFor()
    const holding = (code) => page.locator(`.hold-item[data-code="${code}"]`)
    const candidate = (code) => page.locator(`.plan-cand[data-code="${code}"]`)
    assert.match(await holding('000001').innerText(), /清仓 10 手/)
    assert.match(await holding('600036').innerText(), /继续持有 5 手/)
    assert.match(await holding('300750').innerText(), /V3模型当前不可用/)
    assert.match(await candidate('002594').innerText(), /等待回踩 84元/)
    assert.match(await candidate('688981').innerText(), /买入 1 手/)
    assert.match(await candidate('600519').innerText(), /仅收藏，尚未跟踪/)
    const geometry = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll('.v3-card')].map((element) => {
        const summary = element.querySelector('.v3-decision-summary').getBoundingClientRect()
        const slot = element.querySelector('.card-decision-slot').getBoundingClientRect()
        const meta = element.querySelector('.card-decision-meta')?.getBoundingClientRect()
        return {
          code: element.dataset.code,
          width: element.clientWidth, scrollWidth: element.scrollWidth,
          height: element.clientHeight, scrollHeight: element.scrollHeight,
          summaryBottom: summary.bottom, slotBottom: slot.bottom,
          metaTop: meta?.height > 0 ? meta.top : slot.bottom,
        }
      }),
    }))
    assert.equal(geometry.scrollWidth, width)
    for (const card of geometry.cards) {
      assert.ok(card.scrollWidth <= card.width + 1, JSON.stringify(card))
      assert.ok(card.scrollHeight <= card.height + 1, JSON.stringify(card))
      assert.ok(card.summaryBottom <= card.slotBottom + 1, JSON.stringify(card))
      assert.ok(card.summaryBottom <= card.metaTop + 1, JSON.stringify(card))
    }
    await page.screenshot({ path: `${output}/${width}-cards.png`, fullPage: true })
    await candidate('600519').getByRole('button', { name: '纳入作战', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '纳入作战并持续跟踪？' })
    await confirm.waitFor()
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await candidate('688981').getByRole('button', { name: '记录买入', exact: true }).click()
    const buy = candidate('688981').locator('.buy-inline')
    await buy.getByPlaceholder('买入价').fill('120')
    await buy.getByPlaceholder('手', { exact: true }).fill('1')
    await buy.getByRole('checkbox').uncheck()
    await buy.locator('.act-buy.solid').click()
    await holding('688981').waitFor()
    assert.match(await holding('688981').innerText(), /T\+1锁定1手/)
    await holding('600036').locator('.stock-name-link').first().click()
    await page.locator('.detail-panel').waitFor()
    assert.equal(await page.getByRole('button', { name: '深度生成', exact: true }).count(), 0)
    assert.equal(await page.locator('.footbar-quick').innerText(), '更新 V3 决策')
    await page.getByRole('button', { name: '关闭个股详情', exact: true }).click()
    assert.deepEqual(errors, [])
    results.push(geometry)
    await context.close()
  }
  await fs.writeFile(`${output}/geometry.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ passed: true, viewports: results.map((item) => item.width), checks: ['six-states', 'single-primary-action', 'no-deep-generation', 'enrollment-cancel', 'record-buy', 't1', 'detail-return', 'no-overflow'] }))
} finally {
  await browser.close()
}
