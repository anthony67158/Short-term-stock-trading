import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.UI_TEST_ORIGIN || 'http://127.0.0.1:5174'
assert.ok(new URL(base).hostname === '127.0.0.1', 'Only the isolated local fixture is allowed')
const preview = `${base}/test/ui/system-upgrade-preview.html`
const output = 'harness-artifacts/system-upgrade'
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []

try {
  for (const width of [320, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      return url.origin === base ? route.continue() : route.abort()
    })
    async function check(view) {
      await page.locator('h1').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${output}/${page.viewportSize().width}-${view}.png`, fullPage: true })
      const geometry = await page.evaluate(() => {
        const rect = (element) => {
          const r = element.getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        }
        const visible = (element) => element.getClientRects().length
          && getComputedStyle(element).visibility !== 'hidden'
        const buttons = [...document.querySelectorAll('.nav-tabs .nav-tab')].filter(visible)
        const assistant = document.querySelector('.ai-fab')
        const overlaps = assistant && visible(assistant) && buttons.some((button) => {
          const a = rect(assistant)
          const b = rect(button)
          return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        })
        return {
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          navigationButtons: buttons.length,
          assistantOverlap: Boolean(overlaps),
          heading: document.querySelector('h1')?.textContent,
        }
      })
      assert.ok(geometry.scrollWidth <= geometry.width + 1, JSON.stringify({ view, geometry }))
      assert.equal(geometry.navigationButtons, 3)
      assert.equal(geometry.assistantOverlap, false)
      results.push({ view, ...geometry })
    }
    await page.goto(preview, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { level: 1, name: '市场与选股' }).waitFor()
    await check('selection')
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /交易/ }).click()
    await page.locator('.account-risk-strip').waitFor()
    await page.locator('.selection-origin > summary').first().click()
    assert.equal(await page.locator('.selection-origin[open]').count(), 1)
    await check('positions')
    await page.locator('.plan-cand .stock-name-link').first().click()
    await page.locator('.detail-panel .selection-origin').waitFor()
    await page.waitForTimeout(400)
    const dialog = await page.locator('.detail-panel').boundingBox()
    assert.ok(dialog.x >= -1 && dialog.x + dialog.width <= width + 1)
    await page.screenshot({ path: `${output}/${width}-stock-detail.png` })
    await page.getByRole('button', { name: '关闭个股详情', exact: true }).click()
    await page.getByRole('button', { name: '资金与仓位', exact: true }).click()
    await page.locator('.acc-hero').waitFor()
    await check('account')
    await page.locator('.nav-tabs:visible').getByRole('button', { name: /复盘/ }).click()
    await page.locator('.selection-performance').waitFor()
    await check('review')
    await page.goto(`${preview}?tab=research`, { waitUntil: 'networkidle' })
    await page.locator('.research').waitFor()
    await check('legacy-research')
    await page.goto(`${preview}?tab=hub&sub=account`, { waitUntil: 'networkidle' })
    await page.locator('.acc-hero').waitFor()
    await check('legacy-account')
    if (width === 1440) {
      await page.getByRole('button', { name: '切到白天模式', exact: true }).click()
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
      await check('light-account')
      await page.setViewportSize({ width: 320, height: 900 })
      await check('light-account')
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  await fs.writeFile(`${output}/geometry.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ passed: results.length, results }, null, 2))
} finally {
  await browser.close()
}
